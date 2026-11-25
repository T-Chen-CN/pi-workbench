/**
 * 原子 JSON 落盘（服务器版）。
 *
 * 与 electron / pi-bridge 的同语义实现保持一致的**约束**：临时文件 + fsync + rename。
 * 这里用异步 API：云端进程同时在跑 WS、会话与模型请求，同步 fsync 会卡住整条事件循环。
 * 只有文档级（账号 / 设备 / 工单）写走这里；高频的会话 JSONL 由 SDK 自己维护。
 */

import { promises as fs } from 'fs'
import * as path from 'path'

function tmpPathFor(filePath: string): string {
  const random = Math.random().toString(36).slice(2, 8)
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${random}.tmp`
  )
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: { backup?: boolean } = {}
): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmpPath = tmpPathFor(filePath)
  const content = JSON.stringify(value, null, 2)

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(tmpPath, 'w', 0o600)
    await handle.writeFile(content, 'utf-8')
    await handle.sync()
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()

  if (options.backup) {
    try {
      const previous = await fs.readFile(filePath, 'utf-8')
      JSON.parse(previous)
      await fs.copyFile(filePath, `${filePath}.bak`)
    } catch {
      // 文件不存在或已损坏：不把坏内容写进 .bak
    }
  }

  try {
    await fs.rename(tmpPath, filePath)
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  for (const candidate of [filePath, `${filePath}.bak`]) {
    try {
      return JSON.parse(await fs.readFile(candidate, 'utf-8')) as T
    } catch {
      // 尝试回退 .bak
    }
  }
  return fallback
}

/**
 * 带串行写的 JSON 文档。
 * 读走内存快照，写排队执行——并发路由不会互相覆盖（后写者丢改动是真实事故）。
 */
export class JsonDoc<T> {
  private value: T
  private queue: Promise<void> = Promise.resolve()

  private constructor(
    private readonly filePath: string,
    private readonly fallback: () => T,
    initial: T
  ) {
    this.value = initial
  }

  static async open<T>(filePath: string, fallback: () => T): Promise<JsonDoc<T>> {
    const initial = await readJson<T>(filePath, fallback())
    return new JsonDoc<T>(filePath, fallback, initial)
  }

  get(): T {
    return this.value
  }

  /** 修改后再落盘；单次 I/O 失败不会毒化后续写队列 */
  async update(mutate: (current: T) => T | void): Promise<T> {
    const next = mutate(this.value) ?? this.value
    this.value = next
    const run = this.queue.then(() =>
      writeJsonAtomic(this.filePath, this.value, { backup: true })
    )
    this.queue = run.catch(() => undefined)
    await run
    return this.value
  }

  /** 直接替换整份文档（用于一次性重置） */
  async replace(next: T): Promise<void> {
    this.value = next
    const run = this.queue.then(() =>
      writeJsonAtomic(this.filePath, this.value, { backup: true })
    )
    this.queue = run.catch(() => undefined)
    await run
  }

  /** 等到在途写入结束；退出流程用 */
  async flush(): Promise<void> {
    await this.queue
  }

  reloadFallback(): T {
    return this.fallback()
  }
}
