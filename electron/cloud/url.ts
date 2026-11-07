/**
 * 云端地址工具（纯函数，零 Electron 依赖）。
 *
 * 单独成模块的原因：客户端（`client.ts`）与配对（`gateway.ts`）都要用，
 * 而 `config.ts` 会碰 `app` / `safeStorage`，被它牵连就进不了纯单测。
 */

/**
 * 网关地址**没有默认值**：它是用户自己的部署，客户端不该内置任何人的域名。
 * 未配置时 `readCloudConfig().gatewayUrl` 就是空串，连接页要求用户填（或直接粘
 * 一段完整的配对链接，地址从链接里来）。下面的占位符只用于输入框提示。
 */
export const PLACEHOLDER_CLOUD_GATEWAY_URL = 'https://hub.example.com'
export const PLACEHOLDER_CLOUD_DASHBOARD_URL = 'https://dash.example.com'

/** `https://api.example.com/v1/` → `https://api.example.com`；非法输入返回空串 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return ''
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '')
  return parsed.toString().replace(/\/+$/, '')
}

/**
 * 控制台地址：`hub.x.com` / `api.x.com` → `dash.x.com`。
 * 其他情况退回同源地址，用户仍可正常登录。
 */
export function deriveDashboardUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl)
    if (parsed.hostname.startsWith('hub.')) {
      parsed.hostname = `dash.${parsed.hostname.slice(4)}`
    } else if (parsed.hostname.startsWith('api.')) {
      parsed.hostname = `dash.${parsed.hostname.slice(4)}`
    }
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    // 推不出来就给空串：调用方展示「未设置」，不要编一个别人的域名
    return ''
  }
}
