/**
 * 凭据原语：密码哈希与 token 哈希。
 *
 * 两条硬约束：
 * - 密码只存 scrypt 哈希 + 随机 salt，永不落明文、永不进日志。
 * - token 只存 `SHA-256(token + salt)`；明文只在配对响应里出现一次。
 */

import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto'
import { promisify } from 'util'

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>

const SCRYPT_KEYLEN = 64
/** 登录 / 配对码的尝试窗口；两者共用同一套限速器（F-02 / F-05） */
export const CREDENTIAL_ATTEMPT_LIMIT = 5
export const CREDENTIAL_ATTEMPT_WINDOW_MS = 5 * 60 * 1000

export interface PasswordHash {
  hash: string
  salt: string
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16)
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN)
  return { hash: derived.toString('base64'), salt: salt.toString('base64') }
}

export async function verifyPassword(
  password: string,
  stored: PasswordHash
): Promise<boolean> {
  const salt = Buffer.from(stored.salt, 'base64')
  const expected = Buffer.from(stored.hash, 'base64')
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN)
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

export function createToken(prefix = 'pk'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`
}

export interface TokenHash {
  hash: string
  salt: string
}

export function hashToken(token: string, salt?: string): TokenHash {
  const useSalt = salt ?? randomBytes(16).toString('base64')
  return {
    hash: createHash('sha256').update(`${token}${useSalt}`).digest('hex'),
    salt: useSalt,
  }
}

export function verifyToken(token: string, stored: TokenHash): boolean {
  const computed = Buffer.from(hashToken(token, stored.salt).hash, 'hex')
  const expected = Buffer.from(stored.hash, 'hex')
  if (computed.length !== expected.length) return false
  return timingSafeEqual(computed, expected)
}

/**
 * 6 位数字配对码（D-34）。
 * 搜索空间只有 10^6，靠 TTL + 一次性 + 限速 + 熔断抹平；这里只负责生成与哈希。
 */
export function createPairingCode(): string {
  const value = randomBytes(4).readUInt32BE(0) % 1_000_000
  return value.toString().padStart(6, '0')
}
