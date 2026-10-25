/** 超时控制工具 */

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

/** 超时返回 null，便于调用方处理“迟到的成功结果” */
export async function withTimeoutResult<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  logger: { warn: (...args: unknown[]) => void }
): Promise<{ value: T } | null> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(`[Agent Manager] ${label} timed out after ${timeoutMs}ms`)
      resolve(null)
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise.then((value) => ({ value })), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
