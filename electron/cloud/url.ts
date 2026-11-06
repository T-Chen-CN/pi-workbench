/**
 * 云端地址工具（纯函数，零 Electron 依赖）。
 *
 * 单独成模块的原因：交接文件解析器（`handoff.ts`）与客户端（`client.ts`）都要用，
 * 而 `config.ts` 会碰 `app` / `safeStorage`，被它牵连就进不了纯单测。
 */

export const DEFAULT_CLOUD_DASHBOARD_URL = 'https://dash.tchen-xiaoxiao.com'
export const DEFAULT_CLOUD_GATEWAY_URL = 'https://hub.tchen-xiaoxiao.com'

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
 * 控制台地址：`api.x.com` → `dash.x.com`（v1 交接文件的旧地址就用这个规则）。
 * 其他情况退回同源地址，用户仍可正常登录。
 */
export function deriveDashboardUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl)
    if (parsed.hostname.startsWith('api.')) {
      parsed.hostname = `dash.${parsed.hostname.slice(4)}`
    }
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return DEFAULT_CLOUD_DASHBOARD_URL
  }
}

/**
 * 网关地址（本方案的单入口）：`api.x.com` → `hub.x.com`。
 * 只用于解析 v1 交接文件；当前配置直接存 `gatewayUrl`。
 */
export function deriveGatewayUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl)
    if (parsed.hostname.startsWith('api.')) {
      parsed.hostname = `hub.${parsed.hostname.slice(4)}`
    } else {
      return DEFAULT_CLOUD_GATEWAY_URL
    }
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return DEFAULT_CLOUD_GATEWAY_URL
  }
}
