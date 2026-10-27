/**
 * 启动时把窗口从小尺寸放大到工作台尺寸（E-06）。
 *
 * 只做边界插值与定时调度，不依赖 Electron：主进程注入 `apply` 写窗口，
 * 单元测试注入时钟与调度器逐步推进。
 */

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export function easeOutCubic(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress))
  return 1 - Math.pow(1 - clamped, 3)
}

export function interpolateBounds(
  from: WindowBounds,
  to: WindowBounds,
  progress: number
): WindowBounds {
  const eased = easeOutCubic(progress)
  return {
    x: Math.round(from.x + (to.x - from.x) * eased),
    y: Math.round(from.y + (to.y - from.y) * eased),
    width: Math.round(from.width + (to.width - from.width) * eased),
    height: Math.round(from.height + (to.height - from.height) * eased),
  }
}

export interface BoundsAnimationOptions {
  from: WindowBounds
  to: WindowBounds
  durationMs: number
  apply: (bounds: WindowBounds) => void
  onDone?: () => void
  /** 当前时间（毫秒）；测试可注入 */
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => unknown
  cancel?: (handle: unknown) => void
  stepMs?: number
}

/** 返回取消函数；取消后不再调用 apply / onDone */
export function animateBounds(options: BoundsAnimationOptions): () => void {
  const now = options.now ?? (() => Date.now())
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancelScheduled =
    options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const stepMs = options.stepMs ?? 16
  const startedAt = now()
  let cancelled = false
  let handle: unknown = null

  const step = (): void => {
    if (cancelled) return
    const progress =
      options.durationMs <= 0 ? 1 : Math.min(1, (now() - startedAt) / options.durationMs)
    options.apply(interpolateBounds(options.from, options.to, progress))
    if (progress >= 1) {
      options.onDone?.()
      return
    }
    handle = schedule(step, stepMs)
  }

  step()

  return () => {
    cancelled = true
    if (handle !== null) cancelScheduled(handle)
  }
}
