/**
 * 云端模型配置的静态加密（AES-256-GCM，F-11）。
 *
 * 密钥来自服务器环境变量（`PI_CLOUD_ENC_KEY`），不进代码、不进仓库、不进备份以外的位置。
 * 密文格式：`v1.<iv b64url>.<tag b64url>.<ciphertext b64url>`——版本前缀让将来换算法可迁移。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const VERSION = 'v1'

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, ivPart, tagPart, dataPart] = payload.split('.')
  if (version !== VERSION || !ivPart || !tagPart || !dataPart) {
    throw new Error('Unsupported or malformed ciphertext')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ])
  return plaintext.toString('utf-8')
}

/** 只露末 4 位（F-12）：日志、错误、UI 一律用这个 */
export function maskSecret(secret: string): string {
  if (!secret) return ''
  const tail = secret.slice(-4)
  return `${'*'.repeat(Math.max(0, Math.min(8, secret.length - 4)))}${tail}`
}
