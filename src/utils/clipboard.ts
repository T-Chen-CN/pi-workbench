/**
 * 复制文本到剪贴板。
 *
 * 打包后渲染层跑在 `pw-app://` 自定义协议上：它虽被登记为 secure，但不属于
 * Chromium 认可的可信来源，`navigator.clipboard.writeText()` 会直接 reject
 * （renderer.log 里的 `Failed to copy code: {}` 就是它）。所以优先用 preload
 * 暴露的 Electron 原生剪贴板，再退回浏览器实现，最后退回 execCommand。
 */

type ClipboardBridge = (text: string) => boolean | Promise<boolean>

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

export async function copyText(text: string): Promise<boolean> {
  const value = typeof text === 'string' ? text : ''
  if (!value) return false

  const bridge = bridgeWriter()
  if (bridge) {
    try {
      // Electron 桥返回 Promise（主进程写剪贴板）；Web dev 桥可能是同步的
      if (await bridge(value)) return true
    } catch (error) {
      console.error('Failed to copy through Electron clipboard:', error)
    }
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch (error) {
    console.error('Failed to copy through navigator.clipboard:', error)
  }

  return legacyCopy(value)
}
