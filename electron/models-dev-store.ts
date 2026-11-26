/**
 * models.dev 富数据独立缓存（P-07，见 provider-presets.md §8.3）。
 *
 * 硬边界：
 * - 独立落盘在 `{appDir}/cache/models-dev.json`，绝不与 Pi catalog 的 `models-store.json`
 *   混写，也不改动 `providers.json` / `models.json`。
 * - 任何网络/解析/磁盘异常静默降级（返回 null），绝不阻塞或拖垮 `providers:list` / `providers:refresh`。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import {
  MODELS_DEV_API_URL,
  extractModelsDevSnapshot,
  parseModelsDevCacheSnapshot,
  type ModelsDevCacheSnapshot,
} from 'pi-bridge'
import { writeJsonAtomicAsync } from './atomic-json.js'
import { getAppDir } from './app-paths.js'

export const MODELS_DEV_TTL_MS = 12 * 60 * 60 * 1000
const MODELS_DEV_FETCH_TIMEOUT_MS = 10_000

export interface ModelsDevRefreshOptions {
  force?: boolean
  allowNetwork: boolean
  now?: () => number
  fetchImpl?: typeof fetch
  url?: string
}

let cachedFilePath: string | null = null
let memorySnapshot: ModelsDevCacheSnapshot | null = null
let diskLoaded = false
let inflightRefresh: Promise<ModelsDevCacheSnapshot | null> | null = null

export function modelsDevCacheFilePath(): string {
  return path.join(getAppDir(), 'cache', 'models-dev.json')
}

function syncCacheSlot(): string {
  const filePath = modelsDevCacheFilePath()
  if (cachedFilePath !== filePath) {
    cachedFilePath = filePath
    memorySnapshot = null
    diskLoaded = false
    inflightRefresh = null
  }
  return filePath
}

/** 测试或切换应用目录后重置内存态 */
export function resetModelsDevStore(): void {
  cachedFilePath = null
  memorySnapshot = null
  diskLoaded = false
  inflightRefresh = null
}

/** 读取已缓存的富数据快照（只读内存/本地文件，绝不阻塞发网络请求） */
export async function getModelsDevSnapshot(): Promise<ModelsDevCacheSnapshot | null> {
  const filePath = syncCacheSlot()
  if (diskLoaded) return memorySnapshot
  diskLoaded = true
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    memorySnapshot = parseModelsDevCacheSnapshot(JSON.parse(raw))
  } catch {
    memorySnapshot = null
  }
  return memorySnapshot
}

/**
 * 刷新 models.dev 富数据缓存。
 * - `allowNetwork: false`（`PI_OFFLINE` 或关闭自动更新时的后台刷新）直接返回现有缓存；
 * - 未过期且非 `force` 时直接复用本地缓存；
 * - 网络或解析失败静默保留旧缓存，永不抛错。
 */
export async function refreshModelsDevSnapshot(
  options: ModelsDevRefreshOptions
): Promise<ModelsDevCacheSnapshot | null> {
  const filePath = syncCacheSlot()
  const now = options.now ?? Date.now
  const current = await getModelsDevSnapshot()
  if (!options.allowNetwork) return current
  if (!options.force && current && now() - current.fetchedAt < MODELS_DEV_TTL_MS) {
    return current
  }
  if (inflightRefresh) return inflightRefresh

  const run = (async (): Promise<ModelsDevCacheSnapshot | null> => {
    const fetchFn = options.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MODELS_DEV_FETCH_TIMEOUT_MS)
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (current?.etag) headers['if-none-match'] = current.etag
      const response = await fetchFn(options.url ?? MODELS_DEV_API_URL, {
        headers,
        signal: controller.signal,
      })
      const fetchedAt = now()
      if (response.status === 304 && current) {
        const refreshed: ModelsDevCacheSnapshot = { ...current, fetchedAt }
        memorySnapshot = refreshed
        await writeJsonAtomicAsync(filePath, refreshed, { backup: false })
        return refreshed
      }
      if (!response.ok) return current
      const payload = (await response.json()) as unknown
      const etag = response.headers.get('etag') ?? undefined
      const snapshot = extractModelsDevSnapshot(payload, fetchedAt, etag)
      if (Object.keys(snapshot.providers).length === 0) return current
      memorySnapshot = snapshot
      await writeJsonAtomicAsync(filePath, snapshot, { backup: false })
      return snapshot
    } catch {
      return current
    } finally {
      clearTimeout(timer)
      inflightRefresh = null
    }
  })()

  inflightRefresh = run
  return run
}
