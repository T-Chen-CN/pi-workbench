// @vitest-environment jsdom
/**
 * 渲染日志过滤：ResizeObserver 噪音不能再刷屏，重复消息要折叠。
 *
 * 现场：`renderer.log` 1098 行**全部**是 `ResizeObserver loop completed with
 * undelivered notifications`（183KB），真实渲染错误完全被埋掉。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  emitRendererLog,
  installRendererLogging,
  resetRendererLogForTests,
} from '../src/api/rendererLog'

let logRenderer: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetRendererLogForTests()
  logRenderer = vi.fn().mockResolvedValue({ success: true })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { logRenderer }
})

afterEach(() => {
  logRenderer.mockReset()
})

describe('已知噪音', () => {
  it('drops the ResizeObserver loop notification', () => {
    emitRendererLog('ERROR', [
      'Uncaught error:',
      'ResizeObserver loop completed with undelivered notifications.',
      'app.asar/dist/index.html:0:0',
    ])
    expect(logRenderer).not.toHaveBeenCalled()
  })

  it('drops the older ResizeObserver wording too', () => {
    emitRendererLog('ERROR', ['Uncaught error:', 'ResizeObserver loop limit exceeded'])
    expect(logRenderer).not.toHaveBeenCalled()
  })

  it('still records a real uncaught error', () => {
    emitRendererLog('ERROR', ['Uncaught error:', 'Cannot read properties of undefined'])
    expect(logRenderer).toHaveBeenCalledTimes(1)
    expect(logRenderer.mock.calls[0][0]).toBe('ERROR')
  })
})

describe('重复折叠', () => {
  it('writes the same message once per window and reports the count afterwards', () => {
    emitRendererLog('WARN', ['同样的警告'], 1_000)
    emitRendererLog('WARN', ['同样的警告'], 2_000)
    emitRendererLog('WARN', ['同样的警告'], 3_000)
    expect(logRenderer).toHaveBeenCalledTimes(1)

    // 出了窗口再出现：补上「又发生了 N 次」
    emitRendererLog('WARN', ['同样的警告'], 1_000 + 61_000)
    expect(logRenderer).toHaveBeenCalledTimes(2)
    expect(String(logRenderer.mock.calls[1][1])).toContain('2 次')
  })

  it('keeps different messages apart', () => {
    emitRendererLog('ERROR', ['错误 A'], 1_000)
    emitRendererLog('ERROR', ['错误 B'], 1_100)
    expect(logRenderer).toHaveBeenCalledTimes(2)
  })

  it('counts the message identity, not the timestamp in the text', () => {
    emitRendererLog('ERROR', ['Uncaught error:', 'boom', 'a.ts:1:1'], 1_000)
    emitRendererLog('ERROR', ['Uncaught error:', 'boom', 'a.ts:1:1'], 1_500)
    expect(logRenderer).toHaveBeenCalledTimes(1)
  })
})

describe('安装后的行为', () => {
  it('routes window error events through the filter', () => {
    installRendererLogging()
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'ResizeObserver loop completed with undelivered notifications.',
        filename: 'index.html',
        lineno: 0,
        colno: 0,
      })
    )
    expect(logRenderer).not.toHaveBeenCalled()

    window.dispatchEvent(
      new ErrorEvent('error', { message: '真的挂了', filename: 'x.ts', lineno: 3, colno: 7 })
    )
    expect(logRenderer).toHaveBeenCalledTimes(1)
  })
})
