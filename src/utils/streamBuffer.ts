import type { AgentStreamEvent } from '../types/electron'

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

export interface TraceBuffer {
  /** 追加一条文本 / 思考 / 工具事件；50ms 内的相邻增量会合并 */
  push: (event: AgentStreamEvent) => void
  /** 立即按到达顺序输出尚未处理的事件 */
  flush: () => void
  /** 丢弃尚未输出的事件并取消定时器 */
  dispose: () => void
}

/**
 * 有序事件缓冲：文本与思考的增量合并相邻同类型项，工具事件保持原位。
 * 不能为 text/thinking 分别建立定时器，否则 part 顺序会与真实输出不一致。
 */
export function createTraceBuffer(
  onFlush: (events: AgentStreamEvent[]) => void,
  intervalMs = 50,
  maxChars = 4000
): TraceBuffer {
  let pending: AgentStreamEvent[] = []
  let pendingChars = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.length === 0) return
    const events = pending
    pending = []
    pendingChars = 0
    onFlush(events)
  }

  const push = (event: AgentStreamEvent) => {
    if (event.type === 'text_delta' || event.type === 'thinking_delta') {
      const last = pending[pending.length - 1]
      if (last && last.type === event.type) {
        pending[pending.length - 1] = {
          ...last,
          delta: last.delta + event.delta,
        } as AgentStreamEvent
      } else {
        pending.push({ ...event })
      }
      pendingChars += event.delta.length
      if (pendingChars >= maxChars) {
        flush()
        return
      }
    } else {
      pending.push(event)
    }

    if (!timer) timer = setTimeout(flush, intervalMs)
  }

  const dispose = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = []
    pendingChars = 0
  }

  return { push, flush, dispose }
}
