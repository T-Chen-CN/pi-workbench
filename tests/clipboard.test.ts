// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '../src/utils/clipboard'

/**
 * 打包后渲染层跑在 `pw-app://` 上，`navigator.clipboard` 不可用，
 * 复制必须优先走 preload 暴露的 Electron 剪贴板。
 */
describe('copyText', () => {
  const originalBridge = (window as { electronAPI?: unknown }).electronAPI

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    ;(window as { electronAPI?: unknown }).electronAPI = originalBridge
    vi.restoreAllMocks()
  })

  it('uses the Electron clipboard bridge when present', async () => {
    const writeClipboardText = vi.fn(() => true)
    ;(window as { electronAPI?: unknown }).electronAPI = { writeClipboardText }
    const clipboard = { writeText: vi.fn(async () => undefined) }
    vi.stubGlobal('navigator', { ...navigator, clipboard })

    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeClipboardText).toHaveBeenCalledWith('hello')
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })

  it('accepts an async bridge (main-process clipboard)', async () => {
    const writeClipboardText = vi.fn(async () => true)
    ;(window as { electronAPI?: unknown }).electronAPI = { writeClipboardText }
    const clipboard = { writeText: vi.fn(async () => undefined) }
    vi.stubGlobal('navigator', { ...navigator, clipboard })

    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeClipboardText).toHaveBeenCalledWith('hello')
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })

  it('falls back to navigator.clipboard when the bridge fails', async () => {
    ;(window as { electronAPI?: unknown }).electronAPI = {
      writeClipboardText: () => {
        throw new Error('boom')
      }
    }
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back when the async bridge resolves false', async () => {
    ;(window as { electronAPI?: unknown }).electronAPI = { writeClipboardText: async () => false }
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('reports failure instead of throwing when nothing works', async () => {
    ;(window as { electronAPI?: unknown }).electronAPI = undefined
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: {
        writeText: async () => {
          throw new Error('NotAllowedError')
        }
      }
    })
    // jsdom 没有 execCommand：最后一级兜底也返回 false
    document.execCommand = undefined as unknown as typeof document.execCommand

    await expect(copyText('hello')).resolves.toBe(false)
  })

  it('ignores empty input', async () => {
    await expect(copyText('')).resolves.toBe(false)
  })
})
