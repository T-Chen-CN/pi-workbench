/**
 * 文件监听事件聚合器。
 *
 * 同一个防抖窗口内的多个文件变更会合并为一批发送，而不是只保留最后一个，
 * 避免批量修改时丢失事件。
 */
export interface WatchChange {
  path: string
  type: string
}

export class WatchBatcher {
  private readonly pending = new Map<string, WatchChange>()
  private timer: NodeJS.Timeout | null = null
  private readonly flush: (changes: WatchChange[]) => void
  private readonly delayMs: number

  constructor(flush: (changes: WatchChange[]) => void, delayMs = 300) {
    this.flush = flush
    this.delayMs = delayMs
  }

  /**
   * @param change 要发送的变更
   * @param key 去重键（Windows 下可传小写路径）
   */
  add(change: WatchChange, key: string = change.path): void {
    this.pending.set(key, change)
    if (this.timer) return

    this.timer = setTimeout(() => {
      this.timer = null
      this.flushPending()
    }, this.delayMs)
    this.timer.unref?.()
  }

  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flushPending()
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending.clear()
  }

  size(): number {
    return this.pending.size
  }

  private flushPending(): void {
    if (this.pending.size === 0) return
    const changes = [...this.pending.values()]
    this.pending.clear()
    this.flush(changes)
  }
}
