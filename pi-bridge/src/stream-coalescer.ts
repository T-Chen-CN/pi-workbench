/**
 * 有序流式事件合帧器（零 Node 依赖，供 pi-bridge / apps/cloud 服务端共用）。
 *
 * 合并 50ms 时间窗内相邻的 `text_delta` / `thinking_delta`，降低 WS 广播频率并保护
 * 服务端 `BoundedLog` outbox 不被单轮长回复打爆；遇到工具调用或轮次结束边界可立即 flush
 * 以保证事件严格有序、零延迟送达。
 */

export interface CoalescableStreamEvent {
  type: string
  delta?: string
}

export interface StreamCoalescerOptions {
  /** 合并时间窗（毫秒），默认 50ms */
  intervalMs?: number
  /** 累计文本字符上限，达到即刻刷出以防背压与延迟堆积，默认 4000 */
  maxChars?: number
  /** 遇到非 delta 边界事件（如 tool_start/tool_end）时是否立即刷出整批事件 */
  flushOnBoundary?: boolean
}

export interface StreamCoalescer<T extends CoalescableStreamEvent> {
  push: (event: T) => void
  flush: () => void
  dispose: () => void
}

function isDeltaEvent(event: CoalescableStreamEvent): event is CoalescableStreamEvent & { delta: string } {
  return (
    (event.type === 'text_delta' || event.type === 'thinking_delta') &&
    typeof event.delta === 'string'
  )
}

export function createStreamCoalescer<T extends CoalescableStreamEvent>(
  onFlush: (events: T[]) => void,
  options: StreamCoalescerOptions = {}
): StreamCoalescer<T> {
  const intervalMs = options.intervalMs ?? 50
  const maxChars = options.maxChars ?? 4000
  const flushOnBoundary = options.flushOnBoundary ?? false

  let pending: T[] = []
  let pendingChars = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const flush = () => {
    clearTimer()
    if (pending.length === 0) return
    const events = pending
    pending = []
    pendingChars = 0
    onFlush(events)
  }

  const push = (event: T) => {
    if (isDeltaEvent(event)) {
      if (!event.delta) return
      const last = pending[pending.length - 1]
      if (last && isDeltaEvent(last) && last.type === event.type) {
        pending[pending.length - 1] = {
          ...last,
          delta: last.delta + event.delta,
        }
      } else {
        pending.push({ ...event })
      }
      pendingChars += event.delta.length
      if (pendingChars >= maxChars || intervalMs <= 0) {
        flush()
        return
      }
    } else {
      pending.push(event)
      if (flushOnBoundary || intervalMs <= 0) {
        flush()
        return
      }
    }

    if (timer === null) {
      timer = setTimeout(flush, intervalMs)
      // Node 服务端定时合帧不能阻止进程正常退出
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        ;(timer as { unref?: () => void }).unref?.()
      }
    }
  }

  const dispose = () => {
    clearTimer()
    pending = []
    pendingChars = 0
  }

  return { push, flush, dispose }
}
