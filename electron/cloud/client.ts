/**
 * 云端 API 客户端（主进程）。
 *
 * 为什么不用 Node 的 `fetch`：系统代理在 Windows 上不通过环境变量传递，
 * 裸 fetch 直连会失败；Electron 的 `net` 走 Chromium 网络栈，自动跟随系统代理设置。
 */

import { net } from 'electron'
import { normalizeBaseUrl } from './config.js'

export type CloudErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'bad_request'
  | 'bad_response'
  | 'server'
  | 'network'
  | 'timeout'
  | 'unknown'

export class CloudApiError extends Error {
  readonly code: CloudErrorCode
  readonly status: number
  readonly retryAfterMs?: number
  /** 后端自己的错误码（`invalid_params` / `stale_generation` / `approval_not_pending` …） */
  readonly backendCode: string

  constructor(
    code: CloudErrorCode,
    message: string,
    options: { status?: number; retryAfterMs?: number; backendCode?: string } = {}
  ) {
    super(message)
    this.name = 'CloudApiError'
    this.code = code
    this.status = options.status ?? 0
    this.retryAfterMs = options.retryAfterMs
    this.backendCode = options.backendCode ?? ''
  }
}

/**
 * 已知错误码 → 中文文案。后端的 `message` 是英文运维原文，
 * 直接摊给用户看不懂；按码翻译，未知码再回落到「状态码 + 原文」。
 */
const CODE_MESSAGES: Record<string, string> = {
  gateway_auth_failed: '设备凭据无效或已过期（这台设备可能已被注销），在「连接」页重新配对',
  idempotency_key_conflict: '这次请求和上一条用了同一个幂等键但内容不同，请重新发送',
  run_not_found: '这一轮已经结束了',
  run_not_active: '这一轮不在本机进程里跑，无法操作',
  run_not_accepting_steer: '本轮已经不再接受插话（快结束了），等它收尾再发',
  steer_not_accepted: '本轮没有接住这条插话，等它收尾再发',
  invalid_steer_input: '插话内容不能为空',
  unsupported_session_field: '这个会话字段服务端不支持修改',
  session_not_found: '会话不存在（可能已被删除）',
  client_upgrade_required: '服务端要求更新客户端才能用这个接口',
  // 审批（/v1/runs/{id}/approval）
  invalid_approval_choice: '审批选项不被服务端接受',
  approval_not_pending: '这条审批已经被结算了（超时 / 已在别处处理）',
  approval_not_active: '这一轮已经没有待决审批了',
  stale_generation: '审批已经过期（服务端轮次变了），请重试这一轮',
  invalid_params: '请求参数不被服务端接受',
  unknown_execution: '这一轮的结果未知（服务端进程重启过）',
  // 网关（pi-workbench-gateway）自己的错误码：不把它的英文原句透给用户
  upstream_unavailable: '网关在线，但云端的 Hermes 没有响应',
  upstream_timeout: '网关在线，但云端 Hermes 响应超时',
  device_revoked: '这台设备已被注销，在「连接」页重新配对',
  scope_required: '当前设备权限不够，需要在云端重新授权',
  hub_disabled: '网关没配管理密钥，配对 / 注销暂时不可用',
  path_not_allowed: '这个路径不在网关允许的范围内',
  payload_too_large: '请求体太大，网关拒绝了',
  pairing_not_found: '连接码不存在，在服务器重新生成',
  pairing_expired: '连接码已过期，在服务器重新生成',
  pairing_used: '连接码已经被用过，在服务器重新生成',
  pairing_disabled: '服务器没启用设备配对，检查插件配置',
}

const STATUS_MESSAGES: Record<number, string> = {
  401: '设备凭据无效或已过期（401）',
  403: '没有权限访问这个接口（403）',
  404: '云端资源不存在（404）',
  409: '幂等键冲突：同样的 key 已用于不同的请求内容（409）',
  429: '请求过于频繁，请稍后重试（429）',
}

const NETWORK_MESSAGE = '无法连接云端 API（检查网络 / 代理 / 防火墙）'
const TIMEOUT_MESSAGE = '请求云端 API 超时'

function codeForStatus(status: number): CloudErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status >= 400 && status < 500) return 'bad_request'
  if (status >= 500) return 'server'
  return 'unknown'
}

interface ErrorBody {
  /** 后端错误码（`{error:{code}}` 或 `{code}`） */
  code: string
  /** 可读信息 */
  message: string
}

/** 从错误响应体里取出错误码与可读信息：`{error:{code,message}}` / `{message}` / 原文 */
async function describeErrorBody(response: Response): Promise<ErrorBody> {
  try {
    const text = await response.text()
    if (!text) return { code: '', message: '' }
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string; code?: string } | string
        message?: string
        code?: string
      }
      const errorObject = typeof parsed?.error === 'object' ? parsed.error : null
      const code = String(errorObject?.code ?? parsed?.code ?? '')
      const message = String(
        errorObject?.message ??
          (typeof parsed?.error === 'string' ? parsed.error : '') ??
          parsed?.message ??
          ''
      )
      return { code, message }
    } catch {
      // 非 JSON：截断原样返回
    }
    return { code: '', message: text.slice(0, 300) }
  } catch {
    return { code: '', message: '' }
  }
}

async function toApiError(response: Response): Promise<CloudApiError> {
  const status = response.status
  const code = codeForStatus(status)
  const detail = await describeErrorBody(response)
  const known = detail.code ? CODE_MESSAGES[detail.code] : ''
  const base = STATUS_MESSAGES[status] ?? `云端返回 HTTP ${status}`
  const message = known
    ? known
    : detail.message && detail.message !== base
      ? `${base}：${detail.message}`
      : base
  const retryAfter = Number(response.headers.get('retry-after') ?? '')
  return new CloudApiError(code, message, {
    status,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    backendCode: detail.code || undefined,
  })
}

function wrapNetworkError(error: unknown): CloudApiError {
  if (error instanceof CloudApiError) return error
  const name = (error as { name?: string })?.name
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new CloudApiError('timeout', TIMEOUT_MESSAGE)
  }
  return new CloudApiError('network', `${NETWORK_MESSAGE}：${networkFailureText(error)}`)
}

/** Chromium 的 net 错误码 → 人话。保留原码在后括号里，排查还得靠它 */
const NET_ERROR_TEXT: Record<string, string> = {
  ERR_CONNECTION_CLOSED: '连接被关闭',
  ERR_CONNECTION_REFUSED: '连接被拒绝，服务可能没在运行',
  ERR_CONNECTION_RESET: '连接被重置',
  ERR_CONNECTION_TIMED_OUT: '连接超时',
  ERR_TIMED_OUT: '连接超时',
  ERR_NAME_NOT_RESOLVED: '域名解析失败',
  ERR_INTERNET_DISCONNECTED: '本机没有网络',
  ERR_NETWORK_CHANGED: '网络切换中断了请求',
  ERR_PROXY_CONNECTION_FAILED: '代理连不上',
  ERR_TUNNEL_CONNECTION_FAILED: '代理隧道建立失败',
  ERR_ADDRESS_UNREACHABLE: '地址不可达',
  ERR_SSL_PROTOCOL_ERROR: 'TLS 握手失败',
  ERR_CERT_AUTHORITY_INVALID: '证书不受信任',
  ERR_CERT_COMMON_NAME_INVALID: '证书和域名不匹配',
  ERR_CERT_DATE_INVALID: '证书已过期或未生效',
}

/** 把 `net:ERR_CONNECTION_CLOSED` 这类底层串译成可读文案（含原码） */
export function networkFailureText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const match = /(?:net:)?(ERR_[A-Z_]+)/.exec(raw)
  if (!match) return raw
  const code = match[1]
  const friendly = NET_ERROR_TEXT[code]
  return friendly ? `${friendly}（${code}）` : raw
}

export interface CloudRequestInit {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface CloudClient {
  baseUrl: string
  request: <T>(path: string, init?: CloudRequestInit) => Promise<T>
  /**
   * 打开 SSE 流：返回未读的 Response，由调用方解析。
   * 不设整体超时（轮次可能很长），只由 signal 控制。
   */
  openStream: (path: string, signal: AbortSignal) => Promise<Response>
  rawBaseUrl: string
  credential: string
}

export function createCloudClient(input: { baseUrl: string; credential: string }): CloudClient {
  const rawBaseUrl = normalizeBaseUrl(input.baseUrl)
  if (!rawBaseUrl) {
    throw new CloudApiError('bad_request', 'API 地址格式不正确（需要 http:// 或 https://）')
  }
  const credential = input.credential
  if (!credential) {
    throw new CloudApiError('unauthorized', '这台设备还没有配对，请在「连接」页配对后重试')
  }

  const authHeaders = { Authorization: `Bearer ${credential}` }

  return {
    rawBaseUrl,
    credential,
    baseUrl: rawBaseUrl,

    async request<T>(path: string, init: CloudRequestInit = {}) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000)
      try {
        const response = await net.fetch(`${rawBaseUrl}${path}`, {
          method: init.method ?? 'GET',
          headers: {
            Accept: 'application/json',
            ...authHeaders,
            ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...init.headers,
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal,
        })
        if (!response.ok) throw await toApiError(response)
        if (response.status === 204) return undefined as T
        return (await response.json()) as T
      } catch (error) {
        throw wrapNetworkError(error)
      } finally {
        clearTimeout(timer)
      }
    },

    async openStream(path, signal) {
      try {
        const response = await net.fetch(`${rawBaseUrl}${path}`, {
          headers: {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...authHeaders,
          },
          signal,
        })
        if (!response.ok) throw await toApiError(response)
        return response
      } catch (error) {
        throw wrapNetworkError(error)
      }
    },
  }
}

/** 给 UI 用的统一文案（已经是中文，直接展示） */
export function cloudErrorMessage(error: unknown): string {
  if (error instanceof CloudApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
