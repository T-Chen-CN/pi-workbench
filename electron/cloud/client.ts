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
  | 'server'
  | 'network'
  | 'timeout'
  | 'unknown'

export class CloudApiError extends Error {
  readonly code: CloudErrorCode
  readonly status: number
  readonly retryAfterMs?: number

  constructor(
    code: CloudErrorCode,
    message: string,
    options: { status?: number; retryAfterMs?: number } = {}
  ) {
    super(message)
    this.name = 'CloudApiError'
    this.code = code
    this.status = options.status ?? 0
    this.retryAfterMs = options.retryAfterMs
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  401: 'API 密钥无效或已过期（401）',
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

/** 从错误响应体里取出可读信息：`{error:{message}}` / `{message}` / 原文 */
async function describeErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (!text) return ''
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string } | string
        message?: string
        code?: string
      }
      if (parsed && typeof parsed.error === 'object' && parsed.error?.message) {
        return String(parsed.error.message)
      }
      if (typeof parsed?.error === 'string') return parsed.error
      if (parsed?.message) return String(parsed.message)
      if (parsed?.code) return String(parsed.code)
    } catch {
      // 非 JSON：截断原样返回
    }
    return text.slice(0, 300)
  } catch {
    return ''
  }
}

async function toApiError(response: Response): Promise<CloudApiError> {
  const status = response.status
  const code = codeForStatus(status)
  const detail = await describeErrorBody(response)
  const base = STATUS_MESSAGES[status] ?? `云端返回 HTTP ${status}`
  const message = detail && detail !== base ? `${base}：${detail}` : base
  const retryAfter = Number(response.headers.get('retry-after') ?? '')
  return new CloudApiError(code, message, {
    status,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
  })
}

function wrapNetworkError(error: unknown): CloudApiError {
  if (error instanceof CloudApiError) return error
  const name = (error as { name?: string })?.name
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new CloudApiError('timeout', TIMEOUT_MESSAGE)
  }
  const raw = error instanceof Error ? error.message : String(error)
  return new CloudApiError('network', `${NETWORK_MESSAGE}：${raw}`)
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
  apiKey: string
}

export function createCloudClient(input: { baseUrl: string; apiKey: string }): CloudClient {
  const rawBaseUrl = normalizeBaseUrl(input.baseUrl)
  if (!rawBaseUrl) {
    throw new CloudApiError('bad_request', 'API 地址格式不正确（需要 http:// 或 https://）')
  }
  const apiKey = input.apiKey
  if (!apiKey) {
    throw new CloudApiError('unauthorized', '还没有填写 API 密钥')
  }

  const authHeaders = { Authorization: `Bearer ${apiKey}` }

  return {
    rawBaseUrl,
    apiKey,
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
