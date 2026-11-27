/**
 * 凭据原语：版本化 PHC scrypt 密码哈希与带索引 KID 的 token 哈希。
 *
 * 硬约束：
 * - 密码最长 MAX_PASSWORD_BYTES（128 字节），只存自描述 PHC scrypt 哈希（N=131072, r=8, p=1），
 *   永不落明文、永不进日志；校验向后兼容旧版 `<salt>:<hash>` 与 `{ hash, salt }`（N=16384）。
 * - token 使用 `pk_<kid>.<secret>` 格式便于数据库 O(1) 索引定位，只存 `SHA-256(token + salt)` + `kid`；
 *   明文只在配对响应里出现一次。
 */

import {
  createHash,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'crypto'

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey)
    })
  })
}

export const MAX_PASSWORD_BYTES = 128
export const SCRYPT_CURRENT_COST = 131072
export const SCRYPT_BLOCK_SIZE = 8
export const SCRYPT_PARALLELIZATION = 1
const SCRYPT_LEGACY_COST = 16384
const SCRYPT_KEYLEN = 64
/** N=131072, r=8 需要 128 MiB（超过 Node 默认 32 MiB 上限），必须显式声明 maxmem */
const SCRYPT_MAXMEM = 256 * 1024 * 1024

/** 登录 / 配对码的尝试窗口；两者共用同一套限速器（F-02 / F-05） */
export const CREDENTIAL_ATTEMPT_LIMIT = 5
export const CREDENTIAL_ATTEMPT_WINDOW_MS = 5 * 60 * 1000

const PHC_SCRYPT_RE = /^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/

export interface PasswordHash {
  hash: string
  salt: string
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n >= 1024 && n <= 1_048_576 && (n & (n - 1)) === 0
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new Error(`Password exceeds ${MAX_PASSWORD_BYTES} bytes limit`)
  }
  const salt = randomBytes(16)
  const saltB64 = salt.toString('base64')
  const derived = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_CURRENT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAXMEM,
  })
  const hashB64 = derived.toString('base64')
  const phc = `$scrypt$N=${SCRYPT_CURRENT_COST},r=${SCRYPT_BLOCK_SIZE},p=${SCRYPT_PARALLELIZATION}$${saltB64}$${hashB64}`
  return { hash: phc, salt: saltB64 }
}

/** 是否为旧版哈希或弱参数哈希（成功登录后应透明升级为当前 PHC 参数） */
export function needsPasswordRehash(stored: PasswordHash): boolean {
  const match = PHC_SCRYPT_RE.exec(stored.hash)
  if (!match) return true
  const N = Number(match[1])
  const r = Number(match[2])
  const p = Number(match[3])
  return N < SCRYPT_CURRENT_COST || r < SCRYPT_BLOCK_SIZE || p < SCRYPT_PARALLELIZATION
}

export async function verifyPassword(
  password: string,
  stored: PasswordHash
): Promise<boolean> {
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return false
  const normalized = password.normalize('NFKC')

  // 1. 自描述 PHC 格式：$scrypt$N=...,r=...,p=...$<salt>$<hash>
  const phc = PHC_SCRYPT_RE.exec(stored.hash)
  if (phc) {
    const N = Number(phc[1])
    const r = Number(phc[2])
    const p = Number(phc[3])
    if (!isPowerOfTwo(N) || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
      return false
    }
    const salt = Buffer.from(phc[4], 'base64')
    const expected = Buffer.from(phc[5], 'base64')
    if (salt.length === 0 || expected.length === 0) return false
    const requiredMem = 128 * N * r
    const maxmem = Math.min(512 * 1024 * 1024, Math.max(SCRYPT_MAXMEM, requiredMem * 2))
    const derived = await scryptAsync(normalized, salt, expected.length, { N, r, p, maxmem })
    if (derived.length !== expected.length) return false
    return timingSafeEqual(derived, expected)
  }

  // 2. 旧版内联 `<salt>:<hash>` 格式（N=16384）
  if (!stored.salt && stored.hash.includes(':')) {
    const [saltPart, hashPart] = stored.hash.split(':')
    if (!saltPart || !hashPart) return false
    const salt = Buffer.from(saltPart, 'base64')
    const expected = Buffer.from(hashPart, 'base64')
    if (salt.length === 0 || expected.length === 0) return false
    const derived = await scryptAsync(normalized, salt, expected.length, {
      N: SCRYPT_LEGACY_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
    })
    if (derived.length !== expected.length) return false
    return timingSafeEqual(derived, expected)
  }

  // 3. 旧版分离 `{ hash, salt }` 格式（N=16384）
  const salt = Buffer.from(stored.salt, 'base64')
  const expected = Buffer.from(stored.hash, 'base64')
  if (salt.length === 0 || expected.length === 0) return false
  const derived = await scryptAsync(normalized, salt, expected.length, {
    N: SCRYPT_LEGACY_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
  })
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

/** 签发带索引 KID 的凭据：`pk_<kid>.<secret>`（O(1) 数据库索引定位） */
export function createToken(prefix = 'pk'): string {
  const kid = randomBytes(6).toString('base64url')
  const secret = randomBytes(32).toString('base64url')
  return `${prefix}_${kid}.${secret}`
}

/** 提取 `pk_<kid>.<secret>` 中的 key ID；旧格式无 `.` 返回 null */
export function extractTokenKid(token: string): string | null {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const head = token.slice(0, dot)
  const sep = head.indexOf('_')
  const kid = sep >= 0 ? head.slice(sep + 1) : head
  if (!kid || kid.length > 32 || !/^[A-Za-z0-9_-]+$/.test(kid)) return null
  return kid
}

export interface TokenHash {
  hash: string
  salt: string
  /** 索引键前缀（旧版未升级 token 不含此字段） */
  kid?: string
}

export function hashToken(token: string, salt?: string): TokenHash {
  const useSalt = salt ?? randomBytes(16).toString('base64')
  const kid = extractTokenKid(token)
  return {
    hash: createHash('sha256').update(`${token}${useSalt}`).digest('hex'),
    salt: useSalt,
    ...(kid ? { kid } : {}),
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
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}
