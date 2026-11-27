/** 凭据、限速、cookie 与静态加密（F-02 / F-04 / F-05 / F-06 / F-11 / A-45） */

import { describe, expect, it } from 'vitest'
import {
  createPairingCode,
  createToken,
  hashPassword,
  hashToken,
  verifyPassword,
  verifyToken,
} from '../../apps/cloud/src/auth/credentials'
import { AttemptLimiter } from '../../apps/cloud/src/auth/rate-limit'
import {
  SESSION_COOKIE,
  issueSessionCookie,
  readCookie,
  sessionCookieHeader,
  verifySessionCookie,
} from '../../apps/cloud/src/auth/session-cookie'
import { decryptSecret, encryptSecret, maskSecret } from '../../apps/cloud/src/secure/config-crypto'

describe('密码哈希', () => {
  it('同一密码两次盐不同，但都能验证通过', async () => {
    const first = await hashPassword('hunter2-hunter2')
    const second = await hashPassword('hunter2-hunter2')
    expect(first.hash).not.toBe(second.hash)
    expect(first.salt).not.toBe(second.salt)
    await expect(verifyPassword('hunter2-hunter2', first)).resolves.toBe(true)
    await expect(verifyPassword('hunter2-hunter2', second)).resolves.toBe(true)
  })

  it('错误密码验证失败', async () => {
    const stored = await hashPassword('correct-password')
    await expect(verifyPassword('wrong-password', stored)).resolves.toBe(false)
  })
})

describe('token 与配对码', () => {
  it('token 只以加盐哈希落库，可校验但不可反推', () => {
    const token = createToken()
    const stored = hashToken(token)
    expect(stored.hash).not.toContain(token)
    expect(verifyToken(token, stored)).toBe(true)
    expect(verifyToken(`${token}x`, stored)).toBe(false)
  })

  it('配对码是 6 位纯数字（D-34）', () => {
    for (let index = 0; index < 20; index += 1) {
      expect(createPairingCode()).toMatch(/^\d{6}$/)
    }
  })
})

describe('AttemptLimiter', () => {
  it('每来源 5 次失败后拒绝', () => {
    let now = 0
    const limiter = new AttemptLimiter(
      { limit: 5, windowMs: 1000, globalLimit: 100, cooldownMs: 1000 },
      () => now
    )
    for (let index = 0; index < 5; index += 1) {
      expect(limiter.canAttempt('1.2.3.4').allowed).toBe(true)
      limiter.recordFailure('1.2.3.4')
    }
    expect(limiter.canAttempt('1.2.3.4')).toEqual({ allowed: false, reason: 'source' })
    // 另一来源不受影响
    expect(limiter.canAttempt('5.6.7.8').allowed).toBe(true)
    // 窗口滑过后恢复
    now = 2000
    expect(limiter.canAttempt('1.2.3.4').allowed).toBe(true)
  })

  it('触发全局熔断后所有人暂时不可配对（A-45）', () => {
    let now = 0
    const limiter = new AttemptLimiter(
      { limit: 100, windowMs: 1000, globalLimit: 3, cooldownMs: 500 },
      () => now
    )
    limiter.recordFailure('a')
    limiter.recordFailure('b')
    expect(limiter.recordFailure('c').tripped).toBe(true)
    expect(limiter.canAttempt('brand-new')).toEqual({ allowed: false, reason: 'global' })
    expect(limiter.blockedForMs()).toBe(500)
    now = 600
    expect(limiter.canAttempt('brand-new').allowed).toBe(true)
  })

  it('成功一次清空该来源的失败记录', () => {
    const limiter = new AttemptLimiter({ limit: 2, windowMs: 1000, globalLimit: 100, cooldownMs: 1000 })
    limiter.recordFailure('ip')
    limiter.recordSuccess('ip')
    limiter.recordFailure('ip')
    expect(limiter.canAttempt('ip').allowed).toBe(true)
  })
})

describe('登录 cookie', () => {
  it('签发后可验证，篡改后失效', () => {
    const cookie = issueSessionCookie('secret', 1000)
    expect(verifySessionCookie('secret', cookie, 2000)).not.toBeNull()
    expect(verifySessionCookie('other-secret', cookie, 2000)).toBeNull()
    const [body, signature] = cookie.split('.')
    expect(verifySessionCookie('secret', `${body}.x${signature}`, 2000)).toBeNull()
  })

  it('过期失效', () => {
    const cookie = issueSessionCookie('secret', 1000)
    expect(verifySessionCookie('secret', cookie, 1000 + 31 * 24 * 60 * 60 * 1000)).toBeNull()
  })

  it('会话版本号递增后旧 Cookie 立即失效', () => {
    const v1 = issueSessionCookie('secret', 1000, 1)
    expect(verifySessionCookie('secret', v1, 2000, 1)).not.toBeNull()
    expect(verifySessionCookie('secret', v1, 2000, 2)).toBeNull()
    const legacy = issueSessionCookie('secret', 1000)
    expect(verifySessionCookie('secret', legacy, 2000, 1)).not.toBeNull()
    expect(verifySessionCookie('secret', legacy, 2000, 2)).toBeNull()
  })

  it('生产口径带 Secure / HttpOnly / SameSite=Lax；本地调试可关掉 Secure', () => {
    const secure = sessionCookieHeader({ value: 'v', secure: true })
    expect(secure).toContain('HttpOnly')
    expect(secure).toContain('SameSite=Lax')
    expect(secure).toContain('Secure')
    const insecure = sessionCookieHeader({ value: 'v', secure: false })
    expect(insecure).not.toContain('Secure')
  })

  it('从 Cookie 头里取出指定项', () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=xyz; b=2`, SESSION_COOKIE)).toBe('xyz')
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined()
  })
})

describe('云端配置加密（AES-256-GCM）', () => {
  const key = Buffer.alloc(32, 7)

  it('加解密往返，且密文每次不同（随机 IV）', () => {
    const first = encryptSecret('sk-live-123456', key)
    const second = encryptSecret('sk-live-123456', key)
    expect(first).not.toBe(second)
    expect(decryptSecret(first, key)).toBe('sk-live-123456')
    expect(decryptSecret(second, key)).toBe('sk-live-123456')
  })

  it('换密钥解不开（认证失败而不是返回乱码）', () => {
    const payload = encryptSecret('sk-live-123456', key)
    expect(() => decryptSecret(payload, Buffer.alloc(32, 9))).toThrow()
  })

  it('格式错误直接拒绝', () => {
    expect(() => decryptSecret('garbage', key)).toThrow(/malformed|Unsupported/)
  })

  it('掩码只露末 4 位（F-12）', () => {
    expect(maskSecret('sk-live-123456')).toBe('********3456')
    expect(maskSecret('abc')).toBe('abc')
    expect(maskSecret('')).toBe('')
  })
})
