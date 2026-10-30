/**
 * 超时控制工具（主进程侧）。
 *
 * 与 pi-bridge/src/async-utils.ts 同语义：超时只让调用方拿到结果，被放弃的
 * promise 仍在后台继续，调用方不要再依赖它的副作用。定时器 unref()，
 * 避免超时本身拖住进程退出。
 */

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 超时返回 null：调用方继续往下走，只记一条警告 */
export async function withTimeoutResult<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  logger: { warn: (...args: unknown[]) => void }
): Promise<{ value: T } | null> {
  try {
    return { value: await withTimeout(promise, timeoutMs, label) }
  } catch (error) {
    logger.warn(`[Async] ${label} 超时（${timeoutMs}ms），继续后续清理:`, error)
    return null
  }
}
