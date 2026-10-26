/**
 * 配置中敏感字段的静态加密（Electron safeStorage：Windows DPAPI / macOS Keychain / Linux libsecret）。
 *
 * 文件仍保存在便携式目录中，只有加密所用的系统密钥来自操作系统。
 * 系统不支持加密时回退为明文，并打印警告。
 */

import { safeStorage } from 'electron'

const ENCRYPTED_PREFIX = 'enc:'

export function encryptSecret(value: string): string {
  if (!value) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('base64')
    }
  } catch (error) {
    console.warn('[Main] safeStorage encryption failed:', error)
  }
  console.warn('[Main] safeStorage unavailable — secret will be stored in plain text')
  return value
}

/** 兼容升级前的明文配置：没有 enc: 前缀时原样返回 */
export function decryptSecret(stored: string): string {
  if (!stored) return ''
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored
  try {
    return safeStorage.decryptString(
      Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64')
    )
  } catch (error) {
    console.error('[Main] Failed to decrypt stored secret:', error)
    return ''
  }
}
