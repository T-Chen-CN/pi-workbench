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

function isStoredCatalogsObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** 只保留 SDK 认识的字段，避免把手工改出来的垃圾写回去 */
function normalize(raw: unknown): StoredCatalogs {
  const catalogs: StoredCatalogs = {}
  if (!isStoredCatalogsObject(raw)) return catalogs
  for (const [providerId, entry] of Object.entries(raw)) {
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

  async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(from, to)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
        if (!transient || attempt >= attempts - 1) throw error
        await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)))
      }
    }
  }

  async function readBackupFile(): Promise<StoredCatalogs | null> {
    try {
      const raw = await fs.readFile(`${filePath}.bak`, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (!isStoredCatalogsObject(parsed)) return null
      return normalize(parsed)
    } catch {
      return null
    }
  }

  async function preserveCorruptPrimary(): Promise<string | null> {
    const corruptPath = `${filePath}.corrupt.${Date.now()}`
    try {
      await renameWithRetry(filePath, corruptPath)
      return corruptPath
    } catch (renameError) {
      logger.warn('[ModelsStore] 备份损坏主缓存失败:', renameError)
      return null
    }
  }

  async function readAll(strict = false): Promise<StoredCatalogs> {
    let raw: string
    for (let attempt = 0; ; attempt += 1) {
      try {
        raw = await fs.readFile(filePath, 'utf-8')
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return {}
        const transient = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
        if (transient && attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)))
          continue
        }
        logger.warn('[ModelsStore] 读取失败:', error)
        // 写路径遇到非 ENOENT 的磁盘/锁错误必须抛出，避免误当空缓存覆盖其余供应商记录
        if (strict) throw error
        return {}
      }
    }
    let parsed: unknown
    let parseError: unknown = null
    try {
      parsed = JSON.parse(raw)
      if (!isStoredCatalogsObject(parsed)) {
        parseError = new Error('Invalid models store structure')
      }
    } catch (error) {
      parseError = error
    }
    if (parseError !== null) {
      const recovered = await readBackupFile()
      if (recovered !== null) {
        logger.warn('[ModelsStore] 主缓存损坏，已从 .bak 恢复:', parseError)
        return recovered
      }
      if (strict) {
        const preserved = await preserveCorruptPrimary()
        logger.warn('[ModelsStore] 缓存损坏且无可用备份，拒绝覆盖写盘:', parseError)
        const reason = parseError instanceof Error ? parseError.message : String(parseError)
        const suffix = preserved ? ` (preserved as ${path.basename(preserved)})` : ''
        throw new Error(`Models store file is corrupted and cannot be recovered${suffix}: ${reason}`)
      }
      logger.warn('[ModelsStore] 缓存不是合法 JSON，按空缓存处理:', parseError)
      return {}
    }
    return normalize(parsed)
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
      try {
        const existing = await fs.readFile(filePath, 'utf-8')
        const parsed: unknown = JSON.parse(existing)
        if (isStoredCatalogsObject(parsed)) {
          await fs.copyFile(filePath, `${filePath}.bak`)
        }
      } catch {
        // 主缓存不存在或已损坏：绝不用损坏内容覆盖健康 .bak
      }
      await renameWithRetry(tmpPath, filePath)
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
        // 锁内重读（strict=true），合并其他 provider 在这期间的刷新；遇锁错误不得清盘
        const catalogs = await readAll(true)
        catalogs[providerId] = entry
        await writeFile(catalogs)
      })
    },

    async delete(providerId: string, deleteOptions?: ModelsStoreOperationOptions): Promise<void> {
      deleteOptions?.signal?.throwIfAborted()
      return serialize(async () => {
        const catalogs = await readAll(true)
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
