/**
 * 网关（`hub.`）客户端：登记设备、查设备自己的身份与 scope、撤销设备。
 *
 * 为什么单独一个模块：
 * - 这三个接口是**管理面**，用的是管理密钥或设备 token 的不同组合，跟
 *   普通业务请求（`/v1/runs` 等）混在一个客户端里容易拿错凭据；
 * - 登记会返回**一次性明文 token**，这一刻是设备身份的唯一诞生点，
 *   值得单独写清楚。
 *
 * 单缝约定（C-2）：登记之后业务请求只走网关；`api.` 直连字段只为回滚保留。
 */

import { net } from 'electron'
import { CloudApiError, cloudErrorMessage } from './client.js'
import { normalizeBaseUrl } from './url.js'

export interface GatewayDevice {
  deviceId: string
  name: string
  scopes: string[]
  createdAt: number
  lastSeenAt: number | null
  online: boolean
  revokedAt: number | null
  tokenPrefix?: string
}

export interface GatewayHealth {
  status: string
  hub: string
  upstream: string
  upstreamOk: boolean | null
  upstreamVersion?: string
  upstreamError?: string
  dashboard: string | null
  devices: { total: number; active: number; revoked: number }
  adminKeyConfigured: boolean
  uptimeSeconds: number
}

export interface RegisterResult {
  deviceId: string
  name: string
  scopes: string[]
  token: string
  tokenPrefix: string
}

/** 网关自己的错误码 → 中文文案（与后端 `core/errors.py` 一一对应） */
const GATEWAY_MESSAGES: Record<string, string> = {
  unauthorized: '这台设备还没有登记，或 token 已失效',
  device_revoked: '这台设备已被注销（在云端重新登记即可）',
  admin_required: '管理密钥不对，或者这台设备没有 admin 权限',
  scope_required: '当前设备权限不够，需要在云端重新授权',
  rate_limited: '请求太频繁了，稍等一下再试',
  upstream_unavailable: '网关在线，但云端的 Hermes 没有响应',
  upstream_timeout: '云端 Hermes 响应超时',
  path_not_allowed: '这个路径不在允许范围内',
  hub_disabled: '网关没配管理密钥，登记/撤销暂时不可用',
  payload_too_large: '请求体太大',
  not_found: '网关没有这个接口（可能是版本不匹配）',
  internal: '网关内部出错（云端已记录日志，可先点「刷新状态」重试）',
}

export function gatewayErrorMessage(code: string, fallback: string): string {
  return GATEWAY_MESSAGES[code] ?? fallback
}

async function call<T>(
  gatewayUrl: string,
  path: string,
  options: {
    method?: string
    bearer?: string
    adminKey?: string
    body?: unknown
    timeoutMs?: number
  } = {}
): Promise<T> {
  const base = normalizeBaseUrl(gatewayUrl)
  if (!base) {
    throw new CloudApiError('bad_request', '网关地址格式不正确（需要 http:// 或 https://）')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`
  if (options.adminKey) headers['X-Pi-Admin-Key'] = options.adminKey
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const response = await net.fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload: unknown = undefined
    try {
      payload = text ? JSON.parse(text) : undefined
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      const payloadError = (payload as { error?: { code?: string; message?: string } } | undefined)
        ?.error
      const code = payloadError?.code ?? ''
      throw new CloudApiError(
        response.status === 401
          ? 'unauthorized'
          : response.status === 403
            ? 'forbidden'
            : response.status === 429
              ? 'rate_limited'
              : response.status >= 500
                ? 'server'
                : 'bad_request',
        gatewayErrorMessage(code, payloadError?.message ?? `网关返回 ${response.status}`),
        { status: response.status, backendCode: code }
      )
    }
    return payload as T
  } catch (error) {
    if (error instanceof CloudApiError) throw error
    const name = error instanceof Error ? error.name : ''
    if (name === 'AbortError') {
      throw new CloudApiError('timeout', '网关没有按时响应')
    }
    throw new CloudApiError('network', `连不上网关（${cloudErrorMessage(error)}）`)
  } finally {
    clearTimeout(timer)
  }
}

export function gatewayHealth(gatewayUrl: string): Promise<GatewayHealth> {
  return call<GatewayHealth>(gatewayUrl, '/v1/hub/health')
}

/** 读这台设备自己的身份：token 有效才有答案 */
export async function gatewayWhoAmI(
  gatewayUrl: string,
  deviceToken: string
): Promise<{ deviceId: string; name: string; scopes: string[]; hub: string }> {
  return call(gatewayUrl, '/v1/devices/me', { bearer: deviceToken })
}

/**
 * 登记这台设备（同一 id 再登记 = 换 token，返回 `rotated: true`）。
 *
 * `deviceId` 用本地 `device.json` 里那个只读 id：这样网关侧、`author.id`、
 * 审计日志说的是同一个身份，不会出现「一台机器两个 id」。也正因为 id 固定，
 * 重装 / token 丢失 / 误注销之后再点一次「登记」是**正常操作**，不该报错。
 */
export function registerDevice(input: {
  gatewayUrl: string
  adminKey: string
  deviceId: string
  name: string
  scopes?: string[]
  note?: string
}): Promise<RegisterResult> {
  return call<RegisterResult>(input.gatewayUrl, '/v1/devices/register', {
    method: 'POST',
    adminKey: input.adminKey,
    body: {
      deviceId: input.deviceId,
      name: input.name,
      scopes: input.scopes ?? ['chat', 'dispatch'],
      note: input.note,
    },
  })
}

/** 注销这台设备（撤销后立刻 401，需要重新登记） */
export async function revokeDevice(input: {
  gatewayUrl: string
  deviceId: string
  adminKey?: string
  deviceToken?: string
}): Promise<void> {
  if (!input.adminKey && !input.deviceToken) {
    throw new CloudApiError('forbidden', '撤销设备需要管理密钥，或带 admin 权限的设备 token')
  }
  await call(input.gatewayUrl, `/v1/devices/${encodeURIComponent(input.deviceId)}/revoke`, {
    method: 'POST',
    adminKey: input.adminKey,
    bearer: input.adminKey ? undefined : input.deviceToken,
  })
}
