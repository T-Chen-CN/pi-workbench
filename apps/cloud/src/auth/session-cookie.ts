/**
 * 单账号登录态：无状态签名 cookie。
 *
 * 用 HMAC 签 `{ sid, exp }`，服务重启不需要重放会话表；cookie 属性固定为
 * `HttpOnly; Secure; SameSite=Lax`（F-02）。本机 http 调试时 `Secure` 关闭，
 * 否则浏览器丢弃 cookie，登录永远成功不了；生产口径不变。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

export const SESSION_COOKIE = 'pi_cloud_sid'
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface SessionPayload {
  sid: string
  exp: number
  /** 账号会话版本号；登出后服务端递增，使旧 Cookie 立即失效 */
  sv?: number
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

export function issueSessionCookie(
  secret: string,
  now = Date.now(),
  sessionVersion?: number
): string {
  const payload: SessionPayload = {
    sid: randomBytes(16).toString('base64url'),
    exp: now + MAX_AGE_MS,
    ...(sessionVersion !== undefined ? { sv: sessionVersion } : {}),
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
  return `${body}.${sign(secret, body)}`
}

export function verifySessionCookie(
  secret: string,
  value: string | undefined,
  now = Date.now(),
  expectedSessionVersion?: number
): SessionPayload | null {
  if (!value) return null
  const [body, signature] = value.split('.')
  if (!body || !signature) return null
  const expected = sign(secret, body)
  const received = Buffer.from(signature)
  const want = Buffer.from(expected)
  if (received.length !== want.length || !timingSafeEqual(received, want)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as SessionPayload
    if (typeof payload?.sid !== 'string' || typeof payload?.exp !== 'number') return null
    if (payload.exp <= now) return null
    if (expectedSessionVersion !== undefined) {
      const version = typeof payload.sv === 'number' ? payload.sv : 1
      if (version !== expectedSessionVersion) return null
    }
    return payload
  } catch {
    return null
  }
}

export function sessionCookieHeader(options: {
  value: string
  secure: boolean
  maxAgeSeconds?: number
}): string {
  const maxAge = options.maxAgeSeconds ?? Math.floor(MAX_AGE_MS / 1000)
  return [
    `${SESSION_COOKIE}=${options.value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    options.secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ')
}

export function clearSessionCookieHeader(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ')
}

/** 读请求头里的 cookie（只关心这一条，不引入 cookie 解析依赖） */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}
