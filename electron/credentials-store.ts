/**
 * 桌面端凭证存储：safeStorage 加解密的适配层。
 *
 * 内核在 pi-bridge（云端共用同一份序列化 / 串行 / 原子写），这里只提供密钥与
 * 文件位置。`enc:` 前缀与「系统不支持加密时明文回退」由 secret-crypto 决定，
 * 本文件不做二次加工。
 */

import * as path from 'path'
import { createFileCredentialStore } from 'pi-bridge'
import { getAppDir } from './app-paths.js'
import { decryptSecret, encryptSecret } from './secret-crypto.js'

/** 应用级文件：跨工作区共享，不能放进 `{workspace}/.pi-workbench/` */
export const CREDENTIALS_FILE_NAME = 'credentials.json'

export function credentialsPath(appDir: string = getAppDir()): string {
  return path.join(appDir, 'config', CREDENTIALS_FILE_NAME)
}

/** 类型走函数返回，避免 electron 侧再声明一份 pi-ai 依赖 */
export type DesktopCredentialStore = ReturnType<typeof createFileCredentialStore>

/** 按路径共享单例：保证跨工作区 / 后台任务 / 设置页共用同一份 OAuth 刷新互斥锁与写锁 */
const sharedStores = new Map<string, DesktopCredentialStore>()

export function createDesktopCredentialStore(options: { path?: string } = {}): DesktopCredentialStore {
  const filePath = path.resolve(options.path ?? credentialsPath())
  const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath
  const existing = sharedStores.get(key)
  if (existing) return existing
  const created = createFileCredentialStore({
    path: filePath,
    cipher: { encrypt: encryptSecret, decrypt: decryptSecret },
  })
  sharedStores.set(key, created)
  return created
}
