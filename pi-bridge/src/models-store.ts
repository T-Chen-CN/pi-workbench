/**
 * 文件型 `ModelsStore`：Pi SDK 的远端目录缓存（`data/agent/models-store.json`）。
 *
 * SDK 自己的 `FileModelsStore` 没有从 `pi-coding-agent` 导出（`exports` 只有
 * `.` 与 `./rpc-entry`），所以这里按同一份磁盘格式自己实现，保证升级 SDK
 * 不会读不懂旧缓存：
 * `{ "<providerId>": { models: AnyModel[], lastModified?, checkedAt?, etag? } }`
 *
 * 额外提供只读快照：`snapshot()` 给出每个 provider 最近一次远端目录的 id 清单，
 * 供「以远端为准」的列表过滤与 `source: 'remote' | 'bundled'` 判断使用。
 * 快照从 `read()` 派生，不写第二个文件。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type {
  AnyModel,
  ModelsStore,
  ModelsStoreEntry,
  ModelsStoreOperationOptions,
} from '@earendil-works/pi-ai'

export interface CatalogSnapshot {
  providerId: string
  /** 最近一次成功检查远端的时间 */
  checkedAt?: number
  /** 远端目录的 Last-Modified */
  lastModified?: number
  /** 远端目录里的模型 id（空 = 从未成功刷新 / 上游 404） */
  ids: string[]
}

export interface ModelsStoreLogger {
  warn(message: string, ...args: unknown[]): void
}

export interface FileModelsStoreOptions {
  path: string
  logger?: ModelsStoreLogger
}

export interface TrackedModelsStore extends ModelsStore {
  snapshot(): Promise<CatalogSnapshot[]>
  snapshotFor(providerId: string): Promise<CatalogSnapshot | undefined>
}

type StoredCatalogs = Record<string, ModelsStoreEntry>

function isEntry(value: unknown): value is ModelsStoreEntry {
  return (
    !!value &&
    typeof value === 'object' &&
    Array.isArray((value as ModelsStoreEntry).models)
  )
}

/** 只保留 SDK 认识的字段，避免把手工改出来的垃圾写回去 */
function normalize(raw: unknown): StoredCatalogs {
  const catalogs: StoredCatalogs = {}
  if (!raw || typeof raw !== 'object') return catalogs
  for (const [providerId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isEntry(entry)) continue
    catalogs[providerId] = {
      models: entry.models as readonly AnyModel[],
      ...(typeof entry.lastModified === 'number' ? { lastModified: entry.lastModified } : {}),
      ...(typeof entry.checkedAt === 'number' ? { checkedAt: entry.checkedAt } : {}),
      ...(typeof entry.etag === 'string' ? { etag: entry.etag } : {}),
    }
  }
  return catalogs
}

export function createFileModelsStore(options: FileModelsStoreOptions): TrackedModelsStore {
  const { path: filePath } = options
  const logger = options.logger ?? console
  /** 整文件读-改-写必须串行，否则两个 provider 的刷新会互相覆盖 */
  let writeChain: Promise<void> = Promise.resolve()

  async function readAll(): Promise<StoredCatalogs> {
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') logger.warn('[ModelsStore] 读取失败，按空缓存处理:', error)
      return {}
    }
    try {
      return normalize(JSON.parse(raw))
    } catch (error) {
      logger.warn('[ModelsStore] 缓存不是合法 JSON，按空缓存处理:', error)
      return {}
    }
  }

  async function writeFile(catalogs: StoredCatalogs): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    const tmpPath = `${filePath}.${unique}.tmp`
    const body = JSON.stringify(catalogs, null, 2)
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(tmpPath, 'w', 0o600)
      await handle.writeFile(body, 'utf-8')
      await handle.sync()
    } catch (error) {
      await handle?.close().catch(() => {})
      await fs.rm(tmpPath, { force: true }).catch(() => {})
      throw error
    }
    await handle.close()
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fs.rename(tmpPath, filePath)
          return
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
          if (!transient || attempt >= 5) throw error
          await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)))
        }
      }
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {})
      throw error
    }
  }

  /** 读-改-写整体串行：并行刷新两个 provider 时不能各自基于旧快照覆盖对方 */
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const previous = writeChain
    const run = (async () => {
      await previous.catch(() => {})
      return task()
    })()
    writeChain = run.then(
      (): void => {},
      (): void => {}
    )
    return run
  }

  function toSnapshot(providerId: string, entry: ModelsStoreEntry | undefined): CatalogSnapshot {
    return {
      providerId,
      checkedAt: entry?.checkedAt,
      lastModified: entry?.lastModified,
      ids: (entry?.models ?? [])
        .map((model) => (typeof model === 'object' && model && 'id' in model ? String(model.id) : ''))
        .filter(Boolean),
    }
  }

  return {
    async read(
      providerId: string,
      readOptions?: ModelsStoreOperationOptions
    ): Promise<ModelsStoreEntry | undefined> {
      readOptions?.signal?.throwIfAborted()
      const catalogs = await readAll()
      return catalogs[providerId]
    },

    async write(
      providerId: string,
      entry: ModelsStoreEntry,
      writeOptions?: ModelsStoreOperationOptions
    ): Promise<void> {
      writeOptions?.signal?.throwIfAborted()
      return serialize(async () => {
        // 锁内重读，合并其他 provider 在这期间的刷新
        const catalogs = await readAll()
        catalogs[providerId] = entry
        await writeFile(catalogs)
      })
    },

    async delete(providerId: string, deleteOptions?: ModelsStoreOperationOptions): Promise<void> {
      deleteOptions?.signal?.throwIfAborted()
      return serialize(async () => {
        const catalogs = await readAll()
        if (!(providerId in catalogs)) return
        delete catalogs[providerId]
        await writeFile(catalogs)
      })
    },

    async snapshot(): Promise<CatalogSnapshot[]> {
      const catalogs = await readAll()
      return Object.keys(catalogs)
        .sort()
        .map((providerId) => toSnapshot(providerId, catalogs[providerId]))
    },

    async snapshotFor(providerId: string): Promise<CatalogSnapshot | undefined> {
      const catalogs = await readAll()
      const entry = catalogs[providerId]
      return entry ? toSnapshot(providerId, entry) : undefined
    },
  }
}
