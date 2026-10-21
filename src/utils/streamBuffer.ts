export interface DeltaBuffer {
  /** 追加一段流式增量；按时间窗口合并后交给 onFlush */
  push: (delta: string) => void
  /** 立即把尚未输出的增量交给 onFlush */
  flush: () => void
  /** 丢弃尚未输出的增量并取消定时器 */
  dispose: () => void
}

/**
 * 合并高频流式增量，避免每个 token 都触发一次 store 更新与渲染。
 * 默认 50ms 窗口，缓冲超过 maxChars 时立即输出，防止内存与延迟无界增长。
 */
export function createDeltaBuffer(onFlush: (text: string) => void, intervalMs = 50, maxChars = 4000): DeltaBuffer {
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!pending) return
    const text = pending
    pending = ''
    onFlush(text)
  }

  const push = (delta: string) => {
    if (!delta) return
    pending += delta
    if (pending.length >= maxChars) {
      flush()
      return
    }
    if (!timer) timer = setTimeout(flush, intervalMs)
  }

  const dispose = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = ''
  }

  return { push, flush, dispose }
}
