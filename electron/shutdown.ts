/**
 * 退出流程编排。
 *
 * 两条硬性要求：
 * 1. 清理链上的每一步都要有超时上界 —— 任意一个 agent / PTY / 数据库卡住，
 *    都不能让「关不掉」变成「再也打不开」（残留进程一直握着单实例锁）。
 * 2. 清理结尾必须调用 `app.exit(0)` 而不是再 `app.quit()`：`will-quit` 已经
 *    `preventDefault()` 过，二次 quit 依赖上游事件状态机（见 electron#33643），
 *    一旦没生效就是无窗口、无托盘的僵尸进程。exit 是确定能结束进程的写法。
 *
 * 这里刻意不引入 electron 依赖，全部通过参数注入，便于单测覆盖。
 *
 * 时长预算：main.ts 里各步 timeout 之和（5.9s）必须小于 SHUTDOWN_TIMEOUT_MS（6s），
 * 否则看门狗会在某一步还在正常计时的时候抢先把进程 exit 掉。
 */
import { withTimeout } from './async-utils.js'

export const SHUTDOWN_TIMEOUT_MS = 6_000
export const QUIT_STALL_TIMEOUT_MS = 10_000
/** 单步耗时超过这个值就打警告，便于事后从日志定位慢在哪 */
const SLOW_STEP_WARN_MS = 500

export interface ShutdownLogger {
  log: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface ShutdownStep {
  /** 只用于日志：卡住时能一眼看出是哪一步 */
  name: string
  run: () => void | Promise<void>
  /** 单步超时；超时只记警告并继续下一步，不再等它 */
  timeoutMs: number
}

export interface ShutdownStepResult {
  name: string
  ok: boolean
  ms: number
  error?: string
}

export interface ShutdownReport {
  ok: boolean
  totalMs: number
  steps: ShutdownStepResult[]
}

/**
 * 顺序执行清理步骤，逐步隔离超时与异常。
 * 超时被放弃的 promise 仍在后台跑，但调用方很快会 exit，不需要收尾。
 */
export async function runShutdownSteps(
  steps: ShutdownStep[],
  options: { logger?: ShutdownLogger; now?: () => number } = {}
): Promise<ShutdownReport> {
  const logger = options.logger ?? console
  const now = options.now ?? Date.now
  const startedAt = now()
  const results: ShutdownStepResult[] = []

  for (const step of steps) {
    const stepStartedAt = now()
    const timeoutMs = step.timeoutMs > 0 ? step.timeoutMs : SHUTDOWN_TIMEOUT_MS
    try {
      await withTimeout((async () => step.run())(), timeoutMs, step.name)
      const ms = now() - stepStartedAt
      results.push({ name: step.name, ok: true, ms })
      if (ms >= SLOW_STEP_WARN_MS) {
        logger.warn(`[Shutdown] ${step.name} 耗时 ${ms}ms`)
      }
    } catch (error) {
      const ms = now() - stepStartedAt
      const message = error instanceof Error ? error.message : String(error)
      results.push({ name: step.name, ok: false, ms, error: message })
      logger.warn(`[Shutdown] ${step.name} 失败（${ms}ms）：${message}`)
    }
  }

  const report: ShutdownReport = {
    ok: results.every((result) => result.ok),
    totalMs: now() - startedAt,
    steps: results,
  }
  logger.log(`[Shutdown] 清理完成，耗时 ${report.totalMs}ms`)
  return report
}

export interface QuitSequencerOptions {
  app: { exit: (code?: number) => void }
  shutdown: () => void | Promise<void>
  /** will-quit 之后允许清理的最长时间 */
  shutdownTimeoutMs?: number
  /** before-quit 到 will-quit 之间允许的最长等待（渲染层 beforeunload 卡死、同步弹窗未关闭） */
  stallTimeoutMs?: number
  logger?: ShutdownLogger
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export interface QuitSequencer {
  /** before-quit：武装「退出卡住」看门狗 */
  handleBeforeQuit: () => void
  /** will-quit：接管退出，清理结束后强制 exit */
  handleWillQuit: (event: { preventDefault: () => void }) => void
  /** 用户取消了关闭（未保存确认里点「取消」）：撤掉看门狗，别把应用杀掉 */
  cancel: () => void
  isShuttingDown: () => boolean
}

export function createQuitSequencer(options: QuitSequencerOptions): QuitSequencer {
  const logger = options.logger ?? console
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS
  const stallTimeoutMs = options.stallTimeoutMs ?? QUIT_STALL_TIMEOUT_MS
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return timer
    })
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout))

  let shuttingDown = false
  let exited = false
  let stallTimer: unknown = null
  let shutdownTimer: unknown = null

  const clearStallTimer = (): void => {
    if (stallTimer === null) return
    clearTimer(stallTimer)
    stallTimer = null
  }

  const exitOnce = (reason: string | null): void => {
    if (exited) return
    exited = true
    clearStallTimer()
    if (shutdownTimer !== null) {
      clearTimer(shutdownTimer)
      shutdownTimer = null
    }
    if (reason) logger.warn(`[Main] ${reason}，强制退出`)
    options.app.exit(0)
  }

  return {
    handleBeforeQuit(): void {
      if (shuttingDown || stallTimer !== null) return
      stallTimer = setTimer(() => {
        stallTimer = null
        exitOnce(`退出在 will-quit 之前卡住超过 ${stallTimeoutMs}ms`)
      }, stallTimeoutMs)
    },

    handleWillQuit(event): void {
      // 清理已在进行：让这次 quit 直接通过，别再 preview 一次
      if (shuttingDown) return
      event.preventDefault()
      shuttingDown = true
      clearStallTimer()
      logger.log('[Main] Shutdown started')
      shutdownTimer = setTimer(() => {
        shutdownTimer = null
        exitOnce(`清理超过 ${shutdownTimeoutMs}ms 仍未完成`)
      }, shutdownTimeoutMs)
      void Promise.resolve()
        .then(() => options.shutdown())
        .catch((error: unknown) => {
          logger.error('[Main] Shutdown cleanup failed:', error)
        })
        .then(() => exitOnce(null))
    },

    cancel(): void {
      clearStallTimer()
    },

    isShuttingDown(): boolean {
      return shuttingDown
    },
  }
}
