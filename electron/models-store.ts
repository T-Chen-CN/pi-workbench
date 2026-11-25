/**
 * 桌面端目录缓存适配层：把 `models-store.json` 放在便携式 `data/agent/` 下。
 *
 * 内核实现（磁盘格式、只读快照）在 `pi-bridge/src/models-store.ts`，云端共用。
 */

import * as path from 'path'
import { createFileModelsStore, type TrackedModelsStore } from 'pi-bridge'
import { getAppDir, piAgentDir } from './app-paths.js'

export const MODELS_STORE_FILE = 'models-store.json'

export function modelsStorePath(appDir: string = getAppDir()): string {
  return path.join(appDir, 'data', 'agent', MODELS_STORE_FILE)
}

let shared: TrackedModelsStore | null = null

/** 主进程只有一个目录缓存文件：并发刷新必须共用同一把文件锁 */
export function getModelsStore(): TrackedModelsStore {
  if (!shared) {
    shared = createFileModelsStore({
      path: modelsStorePath(),
      logger: { warn: (message, ...args) => console.warn('[ModelsStore]', message, ...args) },
    })
  }
  return shared
}

/** 测试用：丢掉进程内缓存，下次按新路径重建 */
export function resetModelsStoreForTests(): void {
  shared = null
}

export { piAgentDir }
