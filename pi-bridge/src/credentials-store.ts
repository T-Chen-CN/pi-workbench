/**
 * 供应商凭证的文件存储内核（pi-ai `CredentialStore` 的实现）。
 *
 * 纯 Node，不碰 electron：加解密由宿主注入 —— 桌面端注入 safeStorage，
 * 云端注入自己的 encryptionKey 方案，两边共用同一份序列化 / 串行 / 原子写。
 *
 * 必须满足 pi-ai 的三条契约（见 `@earendil-works/pi-ai` 的 `auth/types.d.ts`）：
 * - 每个 provider 只有一条凭证，`modify` 是唯一写路径；
 * - `modify` 按 provider 互斥，且解析为**写后**值 —— OAuth 刷新在 `modify`
 *   内执行，并发双刷会让已经被轮换的 refresh token 失效；
 * - `list()` 不返回密文也不解密，所以 `type` 以明文旁挂。
 *
 * 落盘形状：
 * { "version": 1, "entries": { "<providerId>": { "type": "api_key" | "oauth", "secret": "<密文>" } } }
 *
 * 每次操作都从磁盘重读：文件只有几 KB、操作频率低，顺带获得跨进程的
 * 读-改-写安全。写盘用临时文件 + fsync + 合法主文件备份 `.bak` + rename；
 * 主文件损坏时先尝试从 `.bak` 恢复，写路径若无可用备份则保留 `.corrupt.<ts>` 并抛错，
 * 严禁按空表静默覆盖其他供应商凭证。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai'

const FILE_VERSION = 1

/** 宿主提供的加解密；`encrypt` 负责加前缀，`decrypt` 必须能接受自己产出的格式 */
export interface CredentialCipher {
  encrypt(plain: string): string
  decrypt(stored: string): string
}

export interface CredentialStoreLogger {
  warn(message: string, ...args: unknown[]): void
}

export interface FileCredentialStoreOptions {
  path: string
  cipher: CredentialCipher
  /** 缺省 console；测试用它断言告警而不是污染输出 */
  logger?: CredentialStoreLogger
  /** 文件版本号，只在需要区分云端 / 桌面端格式时覆盖 */
  fileVersion?: number
}

interface StoredEntry {
  type: Credential['type']
  secret: string
}

interface StoredFile {
  version: number
  entries: Record<string, StoredEntry>
}

/** 与 pi-ai 的 `operationSignal` 同语义：公共 API 的 signal 可选 */
function operationSignal(signal?: AbortSignal): AbortSignal {
  return signal ?? new AbortController().signal
}

/**
 * 与 pi-ai 的 `raceWithAbortSignal` 同语义：abort 时立刻结束等待，
 * 但仍吞掉被放弃 promise 的后续拒绝，避免 unhandled rejection。
 */
async function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {})
    throw signal.reason
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void operation.catch(() => {})
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return type === 'api_key' || type === 'oauth'
}

function isStoredFile(value: unknown): value is { entries: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = (value as { entries?: unknown }).entries
  return Boolean(entries && typeof entries === 'object' && !Array.isArray(entries))
}

/** 逐条校验，坏条目丢弃；整文件坏掉时由调用方先尝试 .bak 恢复或拒绝覆盖 */
function normalizeEntries(value: unknown, logger: CredentialStoreLogger): Record<string, StoredEntry> {
  const entries: Record<string, StoredEntry> = {}
  if (!value || typeof value !== 'object') return entries
  const raw = (value as { entries?: unknown }).entries
  if (!raw || typeof raw !== 'object') return entries
  for (const [providerId, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') {
      logger.warn(`[Credentials] 丢弃无法识别的条目 ${providerId}`)
      continue
    }
    const { type, secret } = entry as { type?: unknown; secret?: unknown }
    if (type !== 'api_key' && type !== 'oauth') {
      logger.warn(`[Credentials] 丢弃类型不合法的条目 ${providerId}`)
      continue
    }
    if (typeof secret !== 'string' || !secret) {
      logger.warn(`[Credentials] 丢弃缺少密文的条目 ${providerId}`)
      continue
    }
    entries[providerId] = { type, secret }
  }
  return entries
}

export function createFileCredentialStore(options: FileCredentialStoreOptions): CredentialStore {
  const { path: filePath, cipher } = options
  const logger = options.logger ?? console
  const fileVersion = options.fileVersion ?? FILE_VERSION
  /** 每个 provider 一条 promise 链，保证 `modify` / `delete` 互斥 */
  const chains = new Map<string, Promise<void>>()
  /**
   * 全文件写入的全局互斥：不同 provider 的 `modify` 可并行执行 `fn`
   * （OAuth 刷新是网络调用），但读-改-写必须串行，否则后写会用旧快照
   * 覆盖掉其他 provider，刚写入的凭证就丢了。
   */
  let writeChain: Promise<void> = Promise.resolve()

  function emptyFile(): StoredFile {
    return { version: fileVersion, entries: {} }
  }

  async function readBackupFile(): Promise<StoredFile | null> {
    try {
      const raw = await fs.readFile(`${filePath}.bak`, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (!isStoredFile(parsed)) return null
      return { version: fileVersion, entries: normalizeEntries(parsed, logger) }
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
      logger.warn('[Credentials] 备份损坏主文件失败:', renameError)
      return null
    }
  }

  async function readFile(readOpts: { throwOnIoError?: boolean } = {}): Promise<StoredFile> {
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return emptyFile()
      // 写前读取遇到瞬时 OS 错误（如 EBUSY/EPERM）必须抛错，绝不能当成空表抹掉其他供应商凭证
      if (readOpts.throwOnIoError) throw error
      logger.warn('[Credentials] 读取失败，按空表处理:', error)
      return emptyFile()
    }
    let parsed: unknown
    let parseError: unknown = null
    try {
      parsed = JSON.parse(raw)
      if (!isStoredFile(parsed)) {
        parseError = new Error('Invalid credentials store structure')
      }
    } catch (error) {
      parseError = error
    }
    if (parseError !== null) {
      const recovered = await readBackupFile()
      if (recovered) {
        logger.warn('[Credentials] 主文件损坏，已从 .bak 恢复:', parseError)
        return recovered
      }
      if (readOpts.throwOnIoError) {
        const preserved = await preserveCorruptPrimary()
        logger.warn('[Credentials] 主文件损坏且无可用备份，拒绝覆盖写盘:', parseError)
        const reason = parseError instanceof Error ? parseError.message : String(parseError)
        const suffix = preserved ? ` (preserved as ${path.basename(preserved)})` : ''
        throw new Error(`Credentials file is corrupted and cannot be recovered${suffix}: ${reason}`)
      }
      logger.warn('[Credentials] 文件不是合法 JSON，按空表处理:', parseError)
      return emptyFile()
    }
    return { version: fileVersion, entries: normalizeEntries(parsed, logger) }
  }

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

  async function writeFile(data: StoredFile): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    const tmpPath = `${filePath}.${unique}.tmp`
    const body = JSON.stringify({ version: data.version, entries: data.entries }, null, 2)
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
        if (isStoredFile(parsed)) {
          await fs.copyFile(filePath, `${filePath}.bak`)
        }
      } catch {
        // 主文件不存在或已损坏：绝不用损坏内容覆盖健康 .bak
      }
      await renameWithRetry(tmpPath, filePath)
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {})
      throw error
    }
  }

  function decode(providerId: string, entry: StoredEntry | undefined): Credential | undefined {
    if (!entry) return undefined
    try {
      const parsed: unknown = JSON.parse(cipher.decrypt(entry.secret))
      if (!isCredential(parsed)) {
        logger.warn(`[Credentials] ${providerId} 的凭证形状不合法，需要重新登录`)
        return undefined
      }
      return parsed
    } catch (error) {
      // 解密失败（换了机器 / 系统密钥变化）与内容损坏走同一条路：当作没有凭证
      logger.warn(`[Credentials] ${providerId} 的凭证无法解密，需要重新登录:`, error)
      return undefined
    }
  }

  function encode(credential: Credential): StoredEntry {
    return { type: credential.type, secret: cipher.encrypt(JSON.stringify(credential)) }
  }

  function enqueue<T>(
    providerId: string,
    task: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const active = operationSignal(signal)
    const previous = chains.get(providerId) ?? Promise.resolve()
    const queued = (async () => {
      await previous.catch(() => {})
      active.throwIfAborted()
      return task()
    })()
    const tail: Promise<void> = queued.then(
      (): void => {},
      (): void => {}
    )
    chains.set(providerId, tail)
    void tail.then(() => {
      if (chains.get(providerId) === tail) chains.delete(providerId)
    })
    return raceWithAbortSignal(queued, active)
  }

  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const previous = writeChain
    const run = (async () => {
      await previous.catch(() => {})
      return task()
    })()
    writeChain = run.then(
      () => {},
      () => {}
    )
    return run
  }

  return {
    async read(providerId: string, readOptions?: AuthOperationOptions): Promise<Credential | undefined> {
      readOptions?.signal?.throwIfAborted()
      const data = await readFile()
      return decode(providerId, data.entries[providerId])
    },

    async list(listOptions?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
      listOptions?.signal?.throwIfAborted()
      const data = await readFile()
      const infos: CredentialInfo[] = []
      for (const [providerId, entry] of Object.entries(data.entries)) {
        infos.push({ providerId, type: entry.type })
      }
      return infos
    },

    modify(
      providerId: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
      modifyOptions?: AuthOperationOptions
    ): Promise<Credential | undefined> {
      return enqueue(
        providerId,
        async () => {
          const current = decode(providerId, (await readFile({ throwOnIoError: true })).entries[providerId])
          const next = await fn(current)
          // 注意：fn(current) 若已向上游完成一次性 OAuth refresh token 轮换，绝不能因迟到的 abort 丢弃新凭证
          if (next === undefined) return current
          return await enqueueWrite(async () => {
            // 锁内重读：合并其他 provider 期间写入的条目；I/O 异常必须失败，严禁空表覆盖
            const data = await readFile({ throwOnIoError: true })
            data.entries[providerId] = encode(next)
            await writeFile(data)
            return next
          })
        },
        modifyOptions?.signal
      )
    },

    delete(providerId: string, deleteOptions?: AuthOperationOptions): Promise<void> {
      return enqueue(
        providerId,
        async () => {
          await enqueueWrite(async () => {
            const data = await readFile({ throwOnIoError: true })
            if (!(providerId in data.entries)) return
            delete data.entries[providerId]
            await writeFile(data)
          })
        },
        deleteOptions?.signal
      )
    },
  }
}
