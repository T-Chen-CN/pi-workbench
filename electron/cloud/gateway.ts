/**
 * 网关（`hub.`）客户端：配对设备、查设备自己的身份与 scope、撤销设备。
 *
 * 为什么单独一个模块：
 * - 配对是唯一「无设备凭据」的入口（连接码本身就是授权），跟普通业务请求
 *   （`/v1/runs` 等）混在一起容易拿错凭据；
 * - 配对会返回**一次性明文 token**，这一刻是设备身份的唯一诞生点，
 *   值得单独写清楚。
 *
 * 单缝约定（C-2）：配对之后业务请求只走网关，本地没有任何直连凭据。
 */

import { net } from 'electron'
import { CloudApiError, networkFailureText } from './client.js'
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

/** 心跳回执：`onlineWindow` 是云端判定在线的窗口（秒），本地据此决定心跳节奏 */
export interface HeartbeatResult {
  ok: boolean
  deviceId: string
  serverTime: number
  onlineWindow: number
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

/** 配对成功的结果：token 明文只在这一刻出现，落盘时立刻加密 */
export interface PairResult {
  deviceId: string
  name: string
  scopes: string[]
  token: string
  tokenPrefix: string
  dashboardUrl?: string
}

/** 网关自己的错误码 → 中文文案（与 hub/errors.py 一一对应） */
const GATEWAY_MESSAGES: Record<string, string> = {
  unauthorized: '这台设备还没有配对，或 token 已失效',
  device_revoked: '这台设备已被注销（在云端重新配对即可）',
  scope_required: '当前设备权限不够，需要在云端重新授权',
  rate_limited: '请求太频繁了，稍等一下再试',
  upstream_unavailable: '网关在线，但云端的 Hermes 没有响应',
  upstream_timeout: '云端 Hermes 响应超时',
  path_not_allowed: '这个路径不在允许范围内',
  hub_disabled: '网关没配管理密钥，配对/撤销暂时不可用',
  payload_too_large: '请求体太大',
  not_found: '网关没有这个接口（可能是版本不匹配）',
  pairing_not_found: '连接码不存在或已失效，请在服务器重新生成',
  pairing_expired: '连接码已过期，请在服务器重新生成',
  pairing_used: '连接码已经被使用过，请在服务器重新生成',
  pairing_disabled: '服务器没有启用设备配对，请检查插件配置',
  invalid_params: '连接码格式不对，请检查后重试',
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
    body?: unknown
    timeoutMs?: number
    redirect?: 'follow' | 'error' | 'manual'
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
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const response = await net.fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: options.redirect,
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
    throw new CloudApiError('network', `连不上网关：${networkFailureText(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

export function gatewayHealth(gatewayUrl: string): Promise<GatewayHealth> {
  return call<GatewayHealth>(gatewayUrl, '/v1/hub/health')
}

/**
 * 完整诊断（`/v1/hub/status`）：设备 token 就够了。
 *
 * 匿名端点 `/v1/hub/health` 刻意只回答「网关活着 / 上游活着」——设备计数、内部端口、
 * 运行时长、上游版本不该对公网扫器免费开放。拿不到（旧插件没有这条路由）时调用方
 * 回退到 `/v1/hub/health`。
 */
export interface GatewayStatus {
  status?: string
  hub?: string
  contractVersion?: number
  features?: string[]
  upstream?: string
  upstreamOk?: boolean | null
  upstreamVersion?: string
  dashboard?: string
  devices?: { total: number; active: number; revoked: number }
  adminKeyConfigured?: boolean
  pairingEnabled?: boolean
  uptimeSeconds?: number
  serverTime?: number
}

export function gatewayStatus(gatewayUrl: string, deviceToken: string): Promise<GatewayStatus> {
  return call<GatewayStatus>(gatewayUrl, '/v1/hub/status', { bearer: deviceToken })
}

/** 读这台设备自己的身份：token 有效才有答案 */
export async function gatewayWhoAmI(
  gatewayUrl: string,
  deviceToken: string
): Promise<{
  deviceId: string
  name: string
  scopes: string[]
  hub: string
  lastSeenAt?: number | null
  online?: boolean
  onlineWindow?: number
  serverTime?: number
}> {
  return call(gatewayUrl, '/v1/devices/me', { bearer: deviceToken })
}

/** 与服务端同一套规范化：大写、去空格 / 连字符 */
function normalizePairingCode(raw: string): string {
  return String(raw ?? '')
    .replace(/[\s-]+/g, '')
    .toUpperCase()
}

/**
 * 配对这台设备：一次性连接码 → 设备 token。
 *
 * 这是设备身份唯一的诞生点；请求**不带任何管理凭据**（没有
 * `X-Pi-Admin-Key`、没有 bearer），连接码本身就是这一次的授权。
 * `deviceId` 用本地设备身份，保证网关侧、`author.id`、审计日志是同一个 id。
 */
export async function pairDevice(input: {
  gatewayUrl: string
  code: string
  deviceId: string
  name: string
}): Promise<PairResult> {
  const code = normalizePairingCode(input.code)
  if (!code) {
    throw new CloudApiError('bad_request', '请填写连接码')
  }
  try {
    const result = await call<PairResult>(input.gatewayUrl, '/v1/devices/pair', {
      method: 'POST',
      body: { code, deviceId: input.deviceId, name: input.name },
      // 连接码在 body 里：不允许跨地址重定向，避免把码转给别的主机
      redirect: 'error',
    })
    // 2xx 但缺凭据 = 插件违约；不能把「没有 token」当成功写盘
    if (!result?.token || !result.deviceId) {
      throw new CloudApiError('bad_response', '网关返回的配对结果缺少设备凭据')
    }
    return {
      ...result,
      scopes: Array.isArray(result.scopes) ? result.scopes.map(String) : [],
      tokenPrefix: result.tokenPrefix || result.token.slice(0, 7),
    }
  } catch (error) {
    // 旧网关没有这条路由：404 且没有后端错误码。新插件连「码不存在」都会给 code，
    // 所以不能把 404 一律当成「插件过旧」。
    if (error instanceof CloudApiError && error.status === 404 && !error.backendCode) {
      throw new CloudApiError('not_found', '网关没有配对接口（插件可能需要升级）', {
        status: 404,
        backendCode: 'pairing_unsupported'
      })
    }
    throw error
  }
}

/** 心跳：告诉云端「这台机器还开着」。每 30s 一次，成本是一条空 POST。 */
export function heartbeatDevice(input: {
  gatewayUrl: string
  deviceToken: string
}): Promise<HeartbeatResult> {
  return call<HeartbeatResult>(input.gatewayUrl, '/v1/devices/me/heartbeat', {
    method: 'POST',
    bearer: input.deviceToken,
  })
}

/** 注销这台设备（撤销后立刻 401，需要重新配对） */
export async function revokeDevice(input: {
  gatewayUrl: string
  deviceId: string
  deviceToken: string
}): Promise<void> {
  if (!input.deviceToken) {
    throw new CloudApiError('forbidden', '注销设备需要设备凭据')
  }
  await call(input.gatewayUrl, `/v1/devices/${encodeURIComponent(input.deviceId)}/revoke`, {
    method: 'POST',
    bearer: input.deviceToken,
  })
}
