/**
 * 原子 JSON 落盘（服务器版）：底层复用 `pi-bridge` 统一实现，上层提供 `JsonDoc` 串行文档封装。
 */
import { readJsonAsyncWithBackup, writeJsonAtomicAsync } from 'pi-bridge/atomic-json'

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: { backup?: boolean } = {}
): Promise<void> {
  await writeJsonAtomicAsync(filePath, value, {
    backup: options.backup ?? false,
    fsync: true,
  })
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  const result = await readJsonAsyncWithBackup<T>(filePath)
  return result.source !== undefined ? (result.data as T) : fallback
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
