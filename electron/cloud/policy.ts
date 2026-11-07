/**
 * 服务端审批策略（原生档位）的读写。
 *
 * **读**：`GET /api/config` 只取白名单子集 —— `approvals.mode` / `approvals.timeout` /
 * `approvals.deny`（**只计数**）/ `agent.disabled_toolsets` / `terminal.backend`。
 * 整份配置里有 `providers` / `secrets` 等**已被解析成明文**的密钥，所以它永远不出
 * 主进程，也永远不回传（见 CLOUD_AGENT.md §3.5）。
 *
 * **写**：`PUT /api/config` 的最小 patch `{"config":{"approvals":{"mode":...}}}`。
 * 服务端是 `_deep_merge(磁盘原文件, 收到的子块)`，所以不需要把整份文档回传 ——
 * 回传就会重演「GET 的解析结果被写回磁盘」那类事故。
 */

import { net } from 'electron'
import { CloudApiError } from './client.js'
import { cloudTransport } from './config.js'
import type { CloudApprovalMode, CloudApprovalPolicy } from './types.js'

/** 允许切换的三个原生档位（顺序即 UI 顺序：收紧 → 自动 → 放开） */
export const APPROVAL_MODES: CloudApprovalMode[] = ['manual', 'smart', 'off']

export function isApprovalMode(value: unknown): value is CloudApprovalMode {
  return typeof value === 'string' && (APPROVAL_MODES as string[]).includes(value)
}

interface PolicyClient {
  url: string
  token: string
}

/**
 * 读 / 写审批档位走**网关**（`/api/config` 由插件转发到控制台），
 * 只有设备 token 这一种凭据 —— 不再直连 `dash.`（C-1/C-2）。
 */
function client(): PolicyClient {
  const transport = cloudTransport()
  if (!transport.credential) {
    throw new CloudApiError('unauthorized', '这台设备还没有配对，先在「连接」页配对')
  }
  return { url: transport.baseUrl.replace(/\/+$/, ''), token: transport.credential }
}

function wrap(error: unknown): CloudApiError {
  if (error instanceof CloudApiError) return error
  const name = (error as { name?: string })?.name
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new CloudApiError('timeout', '审批档位请求超时')
  }
  return new CloudApiError(
    'network',
    `无法连接云端网关（检查网络 / 代理 / 网关是否在跑）：${error instanceof Error ? error.message : String(error)}`
  )
}

function failure(status: number, detail: string, what: string): CloudApiError {
  if (status === 401 || status === 403) {
    return new CloudApiError(
      'unauthorized',
      `云端网关拒绝了${what}请求（${status}）：设备凭据无效或权限不足`,
      { status }
    )
  }
  return new CloudApiError(
    status >= 500 ? 'server' : 'bad_request',
    `云端网关${what}失败（${status}）${detail ? `：${detail}` : ''}`,
    { status }
  )
}

/** 只认识这三个值；不认识就报 null（UI 显示「未知」，不猜） */
function modeOf(raw: unknown): CloudApprovalMode | null {
  return isApprovalMode(raw) ? raw : null
}

function numberOrNull(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

/**
 * 从整份配置里**只**抽出白名单子集。
 *
 * 抽子集的函数单独导出，方便测试断言「不夹带任何密钥字段」。
 */
export function pickApprovalPolicy(config: Record<string, unknown>): CloudApprovalPolicy {
  const approvals = (config.approvals ?? {}) as Record<string, unknown>
  const agent = (config.agent ?? {}) as Record<string, unknown>
  const terminal = (config.terminal ?? {}) as Record<string, unknown>
  const disabled = Array.isArray(agent.disabled_toolsets)
    ? agent.disabled_toolsets.map((item) => String(item ?? '')).filter(Boolean)
    : []
  return {
    mode: modeOf(approvals.mode),
    timeoutSeconds: numberOrNull(approvals.timeout),
    denyCount: Array.isArray(approvals.deny) ? approvals.deny.length : 0,
    disabledToolsets: disabled,
    terminalBackend: typeof terminal.backend === 'string' ? terminal.backend : '',
  }
}

/** 控制台可能把配置包一层 `config`，也可能直接给根对象 */
function unwrap(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {}
  const body = raw as Record<string, unknown>
  const inner = body.config
  if (inner && typeof inner === 'object') return inner as Record<string, unknown>
  return body
}

async function request(
  what: string,
  init: { method: 'GET' | 'PUT'; body?: string; timeoutMs: number }
): Promise<Record<string, unknown>> {
  const { url, token } = client()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs)
  try {
    const response = await net.fetch(`${url}/api/config`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      signal: controller.signal,
    })
    if (!response.ok) {
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 300)
      } catch {
        // 读不出正文就只报状态码
      }
      throw failure(response.status, detail, what)
    }
    return unwrap(await response.json())
  } catch (error) {
    throw wrap(error)
  } finally {
    clearTimeout(timer)
  }
}

/** 读服务端当前生效的审批策略（白名单子集） */
export async function readApprovalPolicy(): Promise<CloudApprovalPolicy> {
  return pickApprovalPolicy(await request('读取配置', { method: 'GET', timeoutMs: 30_000 }))
}

/**
 * 切原生档位：只写 `approvals.mode` 一个键，然后读回复核。
 *
 * 读回不一致就报错（例如服务端有版本守卫 / 别的东西把它改回去了），
 * 让 UI 明确「切换没生效」而不是假装成功。
 */
export async function writeApprovalMode(mode: CloudApprovalMode): Promise<CloudApprovalPolicy> {
  if (!isApprovalMode(mode)) {
    throw new CloudApiError('bad_request', `不支持的审批档位：${String(mode)}`)
  }
  await request('保存配置', {
    method: 'PUT',
    body: JSON.stringify({ config: { approvals: { mode } } }),
    timeoutMs: 45_000,
  })
  const after = await readApprovalPolicy()
  if (after.mode !== mode) {
    throw new CloudApiError(
      'server',
      `档位没有生效：写入 ${mode}，读回 ${after.mode ?? '未知'}`
    )
  }
  return after
}
