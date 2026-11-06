/**
 * `hermes-handoff v1 / v1.1 / v2` 交接文件解析。
 *
 * 纯函数，不碰 fs / electron：文件读取、落盘与 IPC 都在 `ipc/cloud-agent.ts`。
 * 明文密钥只在这个模块与 config 层出现；凡是要给渲染层的，一律走 `toPreview()`
 * （密钥只剩掩码）。
 *
 * 文件由 `docs/requirements/hermes-bootstrap-prompt.md` 的自举 Prompt 生成，
 * 格式是 `KEY=value` 文本 + `#` 注释，末尾带一段 `# ---- 校验结果 ----`。
 */

import { deriveDashboardUrl, deriveGatewayUrl, normalizeBaseUrl } from './url.js'
import type {
  CloudConfigPatch,
  CloudHandoffChecks,
  CloudHandoffParseCode,
  CloudHandoffSummary,
  CloudHandoffWarning,
} from './types.js'

/** 上限：交接文件是几十行的纯文本，64KB 已经远超正常体积 */
export const HANDOFF_MAX_BYTES = 64 * 1024

/** 行数上限，防「一大坨二进制伪装成文本」 */
const HANDOFF_MAX_LINES = 400

/**
 * 首个非空行必须是版本标记。
 *
 * - `v1` / `v1.1`：历史格式（`API_BASE_URL` + `API_KEY`），仍能读，但没有管理密钥，
 *   导入后要去连接页手填一次才能登记；
 * - `v2`：单入口格式 —— `GATEWAY_URL`（唯一的门）+ `ADMIN_KEY`（登记用），不再有 api key。
 */
const HEADER_RE = /^#\s*hermes-handoff\s+v(1(\.\d+)?|2)\b/i

/** 这些主机名允许明文 http：`ssh -L` 转发到本机的场景必须放过 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 认识的键；其余进 `ignored`（只记键名，不记值） */
const KNOWN_KEYS = new Set([
  'PROFILE',
  'GATEWAY_URL',
  'ADMIN_KEY',
  'API_BASE_URL',
  'API_KEY',
  'DASHBOARD_URL',
  'DASHBOARD_USER',
  'DASHBOARD_PASSWORD',
  'DASHBOARD_SESSION_TOKEN',
  'AUTH_MODE',
  'HERMES_VERSION',
  'SERVER_HOST',
  'GENERATED_AT',
  'DNS_OK',
  'GATEWAY_HTTP',
  'UPSTREAM_OK',
  'ADMIN_KEY_CONFIGURED',
  'CAPABILITIES_HTTP',
  'TLS_NOT_AFTER',
  'DASHBOARD_HTTP',
  'SSE_OK',
])

export interface HandoffData {
  version: 'v1' | 'v1.1' | 'v2'
  /** 网关地址（唯一的门）：v2 读 `GATEWAY_URL`，v1 由 `API_BASE_URL` 推导 */
  gatewayUrl: string
  /** 管理密钥（v2）：只在主进程内使用，导入后加密存进 `connection.json` */
  adminKey: string
  /** v1/v1.1 遗留字段：不再参与任何请求，只为读得懂旧文件 */
  baseUrl: string
  apiKey: string
  dashboardUrl: string
  dashboardToken: string
  dashboardUser: string
  dashboardPassword: string
  authMode: 'basic' | 'form' | 'none'
  profile: string
  hermesVersion: string
  serverHost: string
  generatedAt: string
  checks: CloudHandoffChecks
  warnings: CloudHandoffWarning[]
  ignored: string[]
}

export type HandoffParseResult =
  | { ok: true; data: HandoffData }
  | { ok: false; code: CloudHandoffParseCode }

/** 去掉成对引号（`KEY="value"` 也接受） */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim()
    }
  }
  return value
}

/** `200` → 200；空/非数字 → null */
function toInt(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

/** `true` / `ok` / `1` → true；`false` / `fail` / `0` → false；其它 → null（未知） */
function toBool(value: string | undefined): boolean | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  if (['true', 'yes', 'ok', '1'].includes(normalized)) return true
  if (['false', 'no', 'fail', '0'].includes(normalized)) return false
  return null
}

/** 证书到期时间距今不足 7 天就提示（证书过期会让连接直接断） */
function tlsExpiring(raw: string | null): boolean {
  if (!raw) return false
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return false
  return at - Date.now() < 7 * 24 * 60 * 60 * 1000
}

/**
 * 密钥掩码：渲染层只能看到这个。
 *
 * 短密钥不泄漏长度细节，长密钥留「前 3 后 4」够用户认出是哪一把。
 */
export function maskSecret(value: string): string {
  const length = value.length
  if (length === 0) return ''
  if (length < 8) return '*'.repeat(length)
  if (length < 12) return `${value.slice(0, 2)}****${value.slice(-2)}`
  return `${value.slice(0, 3)}****${value.slice(-4)}`
}

/**
 * 解析交接文件。
 *
 * 失败一律带错误码（渲染层按码翻译），不带任何行内容 —— 避免明文进日志/UI。
 */
export function parseHandoff(raw: string): HandoffParseResult {
  if (Buffer.byteLength(raw, 'utf8') > HANDOFF_MAX_BYTES) {
    return { ok: false, code: 'too_large' }
  }
  if (raw.includes('\0')) return { ok: false, code: 'binary' }

  // BOM（Windows 记事本另存会带）+ CRLF 都要容忍
  const lines = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > HANDOFF_MAX_LINES) return { ok: false, code: 'too_large' }

  const headerLine = lines.find((line) => line.trim() !== '')
  if (!headerLine) return { ok: false, code: 'not_handoff' }
  const headerMatch = HEADER_RE.exec(headerLine.trim())
  if (!headerMatch) return { ok: false, code: 'not_handoff' }
  const version: 'v1' | 'v1.1' | 'v2' = headerMatch[2]
    ? 'v1.1'
    : headerMatch[1] === '2'
      ? 'v2'
      : 'v1'

  const values = new Map<string, string>()
  const ignored: string[] = []
  const duplicateKeys: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue // 不是键值行：当说明文字跳过
    const key = trimmed.slice(0, separator).trim().toUpperCase()
    if (!key) continue
    let value = trimmed.slice(separator + 1).trim()
    // 行内注释：只在 `#` 前面是空白时才算（base64 里不会有 '#'，URL 里也不该有）
    const commentAt = value.search(/\s#/)
    if (commentAt >= 0) value = value.slice(0, commentAt).trim()
    value = stripQuotes(value)
    if (!KNOWN_KEYS.has(key)) {
      ignored.push(key)
      continue
    }
    if (!value) continue
    if (values.has(key)) duplicateKeys.push(key)
    values.set(key, value)
  }

  const warnings: CloudHandoffWarning[] = []

  // v1 / v1.1：老格式（api 地址 + api key）。能读，但没有管理密钥，也没有网关地址。
  const baseRaw = values.get('API_BASE_URL') ?? ''
  const baseUrl = baseRaw ? normalizeBaseUrl(baseRaw) : ''
  if (baseUrl === '' && baseRaw) return { ok: false, code: 'bad_base_url' }
  const apiKey = values.get('API_KEY') ?? ''
  if (/\s/.test(apiKey)) return { ok: false, code: 'bad_key' }

  // v2：单入口。GATEWAY_URL 是唯一的门，ADMIN_KEY 是登记用的钥匙。
  const gatewayRaw = values.get('GATEWAY_URL') ?? ''
  let gatewayUrl = gatewayRaw ? normalizeBaseUrl(gatewayRaw) : ''
  if (gatewayRaw && !gatewayUrl) return { ok: false, code: 'bad_gateway_url' }
  if (!gatewayUrl && baseUrl) gatewayUrl = deriveGatewayUrl(baseUrl)
  if (!gatewayUrl) return { ok: false, code: 'missing_base_url' }

  const adminKey = values.get('ADMIN_KEY') ?? ''
  if (/\s/.test(adminKey)) return { ok: false, code: 'bad_key' }

  if (version === 'v2') {
    if (!gatewayRaw) return { ok: false, code: 'missing_base_url' }
    if (!adminKey) return { ok: false, code: 'missing_admin_key' }
  } else {
    if (!baseUrl) return { ok: false, code: 'missing_base_url' }
    if (!apiKey) return { ok: false, code: 'missing_key' }
  }

  const parsedUrl = new URL(gatewayUrl)
  if (parsedUrl.protocol !== 'https:' && !LOOPBACK_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    warnings.push({ code: 'http_not_loopback', detail: parsedUrl.hostname })
  }
  if (version !== 'v2') {
    // 旧文件：没有管理密钥 → 导入后还要手填一次
    warnings.push({ code: 'no_admin_key' })
  }
  if (adminKey && adminKey.length < 32) {
    warnings.push({ code: 'short_key', detail: String(adminKey.length) })
  }
  if (duplicateKeys.length > 0) {
    warnings.push({ code: 'duplicate_key', detail: duplicateKeys.join(', ') })
  }

  const authRaw = (values.get('AUTH_MODE') ?? '').toLowerCase()
  const authMode: HandoffData['authMode'] =
    authRaw === 'basic' || authRaw === 'form' || authRaw === 'none' ? authRaw : 'basic'
  if (authRaw && authRaw !== authMode) {
    warnings.push({ code: 'unknown_auth_mode', detail: authRaw })
  }

  const dashboardUrl =
    normalizeBaseUrl(values.get('DASHBOARD_URL') ?? '') ||
    deriveDashboardUrl(baseUrl || gatewayUrl)

  const dashboardToken = values.get('DASHBOARD_SESSION_TOKEN') ?? ''

  const checks: CloudHandoffChecks = {
    dnsOk: toBool(values.get('DNS_OK')),
    gatewayHttp: toInt(values.get('GATEWAY_HTTP')) ?? toInt(values.get('CAPABILITIES_HTTP')),
    upstreamOk: toBool(values.get('UPSTREAM_OK')),
    adminKeyConfigured: toBool(values.get('ADMIN_KEY_CONFIGURED')),
    dashboardHttp: toInt(values.get('DASHBOARD_HTTP')),
    tlsNotAfter: values.get('TLS_NOT_AFTER') ?? null,
  }

  if (checks.gatewayHttp !== null && checks.gatewayHttp !== 200) {
    warnings.push({ code: 'gateway_not_ok', detail: String(checks.gatewayHttp) })
  }
  if (checks.upstreamOk === false) warnings.push({ code: 'upstream_down' })
  if (checks.adminKeyConfigured === false) warnings.push({ code: 'admin_key_missing' })
  if (checks.dashboardHttp !== null && checks.dashboardHttp >= 400) {
    warnings.push({ code: 'dashboard_not_ok', detail: String(checks.dashboardHttp) })
  }
  if (tlsExpiring(checks.tlsNotAfter)) {
    warnings.push({ code: 'tls_expiring', detail: checks.tlsNotAfter ?? '' })
  }

  return {
    ok: true,
    data: {
      version,
      gatewayUrl,
      adminKey,
      baseUrl,
      apiKey,
      dashboardUrl,
      dashboardToken,
      dashboardUser: values.get('DASHBOARD_USER') ?? '',
      dashboardPassword: values.get('DASHBOARD_PASSWORD') ?? '',
      authMode,
      profile: values.get('PROFILE') ?? '',
      hermesVersion: values.get('HERMES_VERSION') ?? '',
      serverHost: values.get('SERVER_HOST') ?? '',
      generatedAt: values.get('GENERATED_AT') ?? '',
      checks,
      warnings,
      ignored,
    },
  }
}

/** 脱敏预览：唯一允许离开主进程的形状 */
export function toPreview(data: HandoffData, fileName = ''): CloudHandoffSummary {
  return {
    version: data.version,
    fileName,
    gatewayUrl: data.gatewayUrl,
    adminKeyMask: maskSecret(data.adminKey),
    adminKeyLength: data.adminKey.length,
    hasAdminKey: Boolean(data.adminKey),
    dashboardUrl: data.dashboardUrl,
    dashboardUser: data.dashboardUser,
    hasDashboardPassword: Boolean(data.dashboardPassword),
    authMode: data.authMode,
    profile: data.profile,
    hermesVersion: data.hermesVersion,
    serverHost: data.serverHost,
    generatedAt: data.generatedAt,
    checks: data.checks,
    warnings: data.warnings,
    ignored: data.ignored,
  }
}

/**
 * 待落盘的配置补丁（含明文，只留在主进程）。
 *
 * 空值一律 `undefined`，让 `writeCloudConfig` 的「留空＝沿用旧值」生效。
 */
export function pendingPatch(data: HandoffData): CloudConfigPatch {
  return {
    // 单入口之后 baseUrl 只是历史字段（网关地址才是真的门）
    baseUrl: data.baseUrl || data.gatewayUrl,
    gatewayUrl: data.gatewayUrl,
    adminKey: data.adminKey || undefined,
    dashboardUrl: data.dashboardUrl,
    dashboardUser: data.dashboardUser || undefined,
    dashboardPassword: data.dashboardPassword || undefined,
    handoffProfile: data.profile || undefined,
  }
}
