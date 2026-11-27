/**
 * 复制文本到剪贴板。
 *
 * 打包后渲染层跑在 `pw-app://` 自定义协议上：它虽被登记为 secure，但不属于
 * Chromium 认可的可信来源，`navigator.clipboard.writeText()` 会直接 reject
 * （renderer.log 里的 `Failed to copy code: {}` 就是它）。所以优先用 preload
 * 暴露的 Electron 原生剪贴板，再退回浏览器实现，最后退回 execCommand。
 */

type ClipboardBridgeResult = boolean | { success?: boolean }
type ClipboardBridge = (text: string) => ClipboardBridgeResult | Promise<ClipboardBridgeResult>

let shimmedWriteText: ((text: string) => Promise<void>) | null = null
let nativeWriteText: ((text: string) => Promise<void>) | null = null

function isBridgeSuccess(result: unknown): boolean {
  if (typeof result === 'boolean') return result
  if (result && typeof result === 'object' && 'success' in result) {
    return (result as { success?: unknown }).success === true
  }
  return false
}

function bridgeWriter(): ClipboardBridge | null {
  const api = window.electronAPI as { writeClipboardText?: ClipboardBridge } | undefined
  return typeof api?.writeClipboardText === 'function' ? api.writeClipboardText.bind(api) : null
}

/** 旧版 / 无剪贴板权限时的兜底：临时 textarea + execCommand */
function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    const host = document.body
    if (!host) return false
    host.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

/**
 * 打包后的 Electron 运行在 `pw-app://` 下，第三方组件（如 Streamdown 代码/表格/Mermaid
 * 复制按钮）直接调用 `navigator.clipboard.writeText()` 会恒定 reject。
 * 在渲染进程启动时把 `navigator.clipboard.writeText` 委派给主进程原生剪贴板，
 * 并通过引用标记避免与 `copyText()` 发生回环递归。
 */
export function installElectronClipboardShim(): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return
  if (!bridgeWriter()) return

  const existing = navigator.clipboard
  if (existing && shimmedWriteText && existing.writeText === shimmedWriteText) return

  const originalWrite =
    typeof existing?.writeText === 'function' ? existing.writeText.bind(existing) : null
  nativeWriteText = originalWrite

  const writeText = async (text: string): Promise<void> => {
    const value = typeof text === 'string' ? text : String(text ?? '')
    const bridge = bridgeWriter()
    if (bridge) {
      try {
        if (isBridgeSuccess(await bridge(value))) return
      } catch {
        // 桥接失败时继续回退到原生实现
      }
    }
    if (originalWrite) {
      await originalWrite(value)
      return
    }
    if (legacyCopy(value)) return
    throw new Error('Failed to write text to clipboard')
  }

  shimmedWriteText = writeText

  const patchedClipboard = existing
    ? new Proxy(existing, {
        get(target, prop) {
          if (prop === 'writeText') return writeText
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    : ({ writeText } as unknown as Clipboard)

  try {
    Object.defineProperty(navigator, 'clipboard', {
      value: patchedClipboard,
      configurable: true,
    })
    if (navigator.clipboard?.writeText === writeText) return
  } catch {
    // 某些宿主禁止重定义 navigator.clipboard，尝试直接覆盖 writeText
  }

  if (existing) {
    try {
      Object.defineProperty(existing, 'writeText', {
        value: writeText,
        configurable: true,
        writable: true,
      })
    } catch {
      try {
        ;(existing as { writeText: typeof writeText }).writeText = writeText
      } catch {
        shimmedWriteText = null
      }
    }
  } else {
    shimmedWriteText = null
  }
}

export async function copyText(text: string): Promise<boolean> {
  const value = typeof text === 'string' ? text : ''
  if (!value) return false

  const bridge = bridgeWriter()
  if (bridge) {
    try {
      // 主进程 IPC 返回 `{ success: boolean }`，Web dev 桥或测试替身可能返回 boolean
      if (isBridgeSuccess(await bridge(value))) return true
    } catch (error) {
      console.error('Failed to copy through Electron clipboard:', error)
    }
  }

  try {
    const currentWriteText = navigator.clipboard?.writeText
    const fallbackWriteText =
      currentWriteText && currentWriteText === shimmedWriteText
        ? nativeWriteText
        : currentWriteText?.bind(navigator.clipboard)
    if (fallbackWriteText) {
      await fallbackWriteText(value)
      return true
    }
  } catch (error) {
    console.error('Failed to copy through navigator.clipboard:', error)
  }

  return legacyCopy(value)
}
