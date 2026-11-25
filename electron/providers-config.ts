/**
 * 桌面端供应商配置适配层：绑定便携式目录、safeStorage 与凭证 store。
 *
 * 内核在 `pi-bridge/src/providers-config.ts`（云端共用同一份清洗 / 迁移逻辑），
 * 这里只决定「文件在哪、密钥怎么解」。
 */

import * as path from 'path'
import { createProvidersConfigStore, PROVIDERS_CONFIG_FILE } from 'pi-bridge'
import { piAgentDir } from './app-paths.js'
import { getAppDir } from './app-paths.js'
import { decryptSecret } from './secret-crypto.js'
import { createDesktopCredentialStore, type DesktopCredentialStore } from './credentials-store.js'

export function providersConfigPath(appDir: string = getAppDir()): string {
  return path.join(appDir, 'config', PROVIDERS_CONFIG_FILE)
}

export interface DesktopProvidersConfigOptions {
  appDir?: string
  /** 复用同一个凭证 store（主进程只有一个实例） */
  credentials?: DesktopCredentialStore
}

export function createDesktopProvidersConfigStore(
  options: DesktopProvidersConfigOptions = {}
): ReturnType<typeof createProvidersConfigStore> {
  return createProvidersConfigStore({
    path: providersConfigPath(options.appDir ?? getAppDir()),
    agentDir: piAgentDir,
    decryptSecret,
    credentials: options.credentials ?? createDesktopCredentialStore(),
  })
}
