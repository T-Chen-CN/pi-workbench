// @vitest-environment node
/**
 * 工具摘要的文本清理：终端颜色码必须剥掉。
 *
 * 为什么值得单独立一个文件：这份摘要有三个下游 —— 聊天工具卡预览、派活轨迹
 * （回报给云端）、以及上报里的参数摘要。ANSI 码在人眼里是零宽，但占的是同一条
 * 截断预算：实测 160 字的轨迹结果里平均 47 个字节是 ESC 序列。
 */

import { describe, expect, it } from 'vitest'
import { stripAnsi, summarizeToolArgs, summarizeToolResult } from '../pi-bridge/src/text-utils'

const SGR = (code: string, text: string): string => `\u001b[${code}m${text}\u001b[0m`

describe('stripAnsi', () => {
  it('removes SGR colour codes', () => {
    expect(stripAnsi(`${SGR('31;1', 'dotnet:')} ${SGR('36;1', 'Line')} |`)).toBe('dotnet: Line |')
  })

  it('removes OSC titles and hyperlinks', () => {
    expect(stripAnsi(`\u001b]0;窗口标题\u0007正文`)).toBe('正文')
  })

  it('leaves ordinary text alone', () => {
    expect(stripAnsi('已经是最新的，无法还原。')).toBe('已经是最新的，无法还原。')
    expect(stripAnsi('')).toBe('')
  })
})

describe('工具摘要', () => {
  it('strips colour codes from a string result', () => {
    // 一条典型的 PowerShell 报错：整段都是颜色码
    const raw = [
      `${SGR('31;1', 'dotnet:')} ${SGR('36;1', 'Line |')}`,
      `${SGR('31;1', '命令未找到')}`,
    ].join('\n')
    expect(summarizeToolResult(raw)).toBe('dotnet: Line |\n命令未找到')
  })

  it('strips colour codes from a content-part result', () => {
    const result = { content: [{ type: 'text', text: `${SGR('32;1', 'SMOKE OK')}` }] }
    expect(summarizeToolResult(result)).toBe('SMOKE OK')
  })

  it('spends the whole 2000-char budget on real text, not escapes', () => {
    const raw = `${SGR('31;1', 'x')}`.repeat(3_000)
    const preview = summarizeToolResult(raw)
    expect(preview).not.toContain('\u001b')
    // 不剥码的话，这里只能剩下一半不到的正文
    expect(preview.replace('…', '')).toHaveLength(2_000)
  })

  it('strips colour codes from a powershell command summary', () => {
    expect(summarizeToolArgs('powershell', { command: `${SGR('33', 'npm')} test` })).toBe(
      'npm test'
    )
  })
})
