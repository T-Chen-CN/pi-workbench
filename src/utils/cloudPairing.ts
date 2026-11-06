/**
 * 连接码解析（纯函数，渲染层用）。
 *
 * 服务器生成的是短命、单次使用的配对码；用户可以只粘码，也可以粘插件给出的
 * 完整链接（`https://hub.example.com/#pair=XXXXX-XXXXX`）。链接里的码放在
 * fragment，不会进入网关访问日志；这里只取 origin，避免把路径带进网关地址。
 */

export type PairingParseReason = 'missing_code' | 'bad_gateway'

export type PairingParseResult =
  | { ok: true; gatewayUrl: string; code: string }
  | { ok: false; reason: PairingParseReason }

/** 大写、去空格 / 连字符；服务端按同一规则算哈希 */
export function normalizePairingCode(raw: string): string {
  return String(raw ?? '')
    .replace(/[\s-]+/g, '')
    .toUpperCase()
}

/** 只接受 http(s)，统一成 origin（自建部署的子路径不在本方案支持范围内） */
export function normalizePairingGateway(raw: string): string {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return ''
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
    return parsed.origin
  } catch {
    return ''
  }
}

function readPairCode(url: URL): string {
  const hash = url.hash.replace(/^#/, '')
  if (hash) {
    const fromHash = new URLSearchParams(hash).get('pair')
    if (fromHash) return fromHash
  }
  return url.searchParams.get('pair') ?? ''
}

/**
 * `raw` 可以是纯连接码，也可以是完整配对链接。
 * 完整链接必须以 `#pair=CODE`（或宽松的 `?pair=CODE`）携带码；只有链接没有码时
 * 视为用户粘错了，不把整条链接当码发给服务端。
 */
export function parsePairingInput(raw: string, fallbackGateway: string): PairingParseResult {
  const value = String(raw ?? '').trim()
  if (/^https?:\/\//i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return { ok: false, reason: 'bad_gateway' }
    }
    const gatewayUrl = normalizePairingGateway(value)
    if (!gatewayUrl) return { ok: false, reason: 'bad_gateway' }
    const code = normalizePairingCode(readPairCode(url))
    if (!code) return { ok: false, reason: 'missing_code' }
    return { ok: true, gatewayUrl, code }
  }

  const code = normalizePairingCode(value)
  if (!code) return { ok: false, reason: 'missing_code' }
  const gatewayUrl = normalizePairingGateway(fallbackGateway)
  if (!gatewayUrl) return { ok: false, reason: 'bad_gateway' }
  return { ok: true, gatewayUrl, code }
}
