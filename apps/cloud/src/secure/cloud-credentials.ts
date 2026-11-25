/**
 * 云端凭证存储：把 `CloudStore` 里那条加密记录包成 `CredentialStore`。
 *
 * 与桌面端各自独立、互不同步（D19）：云端只保存「云端配置页登录的那一份」凭证，
 * 设备端的 Key 永远不会上传到这里。凭证整体（含 OAuth refresh token）用
 * `encryptionKey` 加密后落盘，读出来只在内存里。
 */

import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { decryptSecret, encryptSecret } from '../secure/config-crypto.js'

export interface CloudConfigRecordLike {
  providerId: string
  /** 加密后的 `Credential` JSON */
  credentialCipher: string
}

export interface CloudCredentialStoreDeps {
  readConfig(): CloudConfigRecordLike | null
  saveCredential(providerId: string, credentialCipher: string): Promise<void>
  clearCredential(): Promise<void>
  encryptionKey: Buffer
  logger?: { warn(message: string, ...args: unknown[]): void }
}

export function createCloudCredentialStore(deps: CloudCredentialStoreDeps): CredentialStore {
  const logger = deps.logger ?? console
  // modify 是读-改-写：整条记录只有一份凭证，必须串行，否则并发登录会互相覆盖
  let chain: Promise<unknown> = Promise.resolve()
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  function readCurrent(): Credential | undefined {
    const record = deps.readConfig()
    if (!record) return undefined
    try {
      return JSON.parse(decryptSecret(record.credentialCipher, deps.encryptionKey)) as Credential
    } catch (error) {
      logger.warn('[cloud] cannot decrypt the stored credential:', error)
      return undefined
    }
  }

  return {
    async read(providerId) {
      const record = deps.readConfig()
      if (!record || record.providerId !== providerId) return undefined
      return readCurrent()
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const record = deps.readConfig()
      if (!record) return []
      const credential = readCurrent()
      if (!credential) return []
      return [{ providerId: record.providerId, type: credential.type }]
    },
    modify(providerId, fn) {
      return serialize(async () => {
        const record = deps.readConfig()
        const current = record?.providerId === providerId ? readCurrent() : undefined
        const next = await fn(current)
        if (!next) return current
        await deps.saveCredential(
          providerId,
          encryptSecret(JSON.stringify(next), deps.encryptionKey)
        )
        return next
      })
    },
    delete(providerId) {
      return serialize(async () => {
        const record = deps.readConfig()
        if (!record || record.providerId !== providerId) return
        await deps.clearCredential()
      })
    },
  }
}
