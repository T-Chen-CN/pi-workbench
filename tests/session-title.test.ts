import { describe, expect, it } from 'vitest'
import {
  buildTitlePrompt,
  isEchoOfUserText,
  normalizeSessionTitle,
  parseTitleResponse,
  stripEnvironmentNotes,
} from '../pi-bridge/src/session-title.js'

/**
 * 真实样本：dev 版会话 01a18312（用户只说「你是谁？」）的助手回复。
 * 504 字里有 460 字是环境说明，正是标题被带偏成「DSH 编码智能体介绍」的输入。
 */
const ENVIRONMENT_HEAVY_REPLY = [
  '我是 pi 里的编码智能体（AI 编程助手），可以读写文件、跑命令、搜代码、查资料，帮你把这个仓库里的活干完。',
  '',
  '具体到当前环境：',
  '',
  '- **工作目录**：`F:\\DSH\\DSH二次开发-2`，这是 DSH 最小核心后端（从官方 DeepSeek Harness 裁出的纯后端，整包自包含）。',
  '- **我已加载的规矩**（来自 `AGENTS.md` / 章程）：改完必须跑三个门禁（`verify-selfcontained.ps1` 16/16、`verify-core.mjs` 14/14、`handshake-test.mjs` 5/5）；不写硬编码绝对路径。',
  '- **工作树状态**：主工作树、分支 `main`，有 35 处未提交改动。',
  '',
  '需要我做什么？比如继续某个 `specs/` 下的 SDD 流程，还是先跑一遍门禁看当前状态？',
].join('\n')

describe('session title helpers', () => {
  it('drops environment notes so the topic stays readable', () => {
    const stripped = stripEnvironmentNotes(ENVIRONMENT_HEAVY_REPLY)

    expect(stripped).toBe(
      '我是 pi 里的编码智能体（AI 编程助手），可以读写文件、跑命令、搜代码、查资料，帮你把这个仓库里的活干完。'
    )
    expect(stripped).not.toContain('DSH')
    expect(stripped).not.toContain('工作目录')
    expect(stripped).not.toContain('main')
  })

  it('keeps ordinary replies untouched', () => {
    const reply = '已把 auth guard 里的重定向改成只跳一次，并补了两个回归用例。\n\n门禁全绿。'
    expect(stripEnvironmentNotes(reply)).toBe(reply)
  })

  it('falls back to the raw text when every paragraph looks like environment notes', () => {
    const reply = '- **工作目录**：`F:\\DSH\\DSH二次开发-2`\n\n- **工作树状态**：分支 `main`'
    expect(stripEnvironmentNotes(reply)).toBe(reply)
  })

  it('builds a prompt that asks for JSON and never leaks environment notes', () => {
    const prompt = buildTitlePrompt('你是谁？', ENVIRONMENT_HEAVY_REPLY)

    expect(prompt).toContain('{"title": "标题"}')
    expect(prompt).toContain('用户：你是谁？')
    expect(prompt).toContain('我是 pi 里的编码智能体')
    expect(prompt).not.toContain('工作目录')
    expect(prompt).not.toContain('F:\\DSH')
  })

  it('parses the JSON reply shape, with or without a code fence', () => {
    expect(parseTitleResponse('{"title": "助手自我介绍"}')).toBe('助手自我介绍')
    expect(parseTitleResponse('```json\n{"title": "项目门禁体检"}\n```')).toBe('项目门禁体检')
    expect(parseTitleResponse('{"title": "  修复登录跳转  "}')).toBe('修复登录跳转')
  })

  it('falls back to the first line when the model ignores the JSON instruction', () => {
    expect(parseTitleResponse('标题：修复登录跳转\n\n说明……')).toBe('修复登录跳转')
    expect(parseTitleResponse('"修复登录跳转"')).toBe('修复登录跳转')
    expect(normalizeSessionTitle('标题：“助手自我介绍”')).toBe('助手自我介绍')
  })

  it('detects a title that just echoes the user message', () => {
    expect(isEchoOfUserText('你是谁？', '你是谁？')).toBe(true)
    expect(isEchoOfUserText('你是谁', '你是谁？')).toBe(true)
    expect(isEchoOfUserText('助手自我介绍', '你是谁？')).toBe(false)
    expect(isEchoOfUserText('', '你是谁？')).toBe(false)
  })
})
