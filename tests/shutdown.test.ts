import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQuitSequencer, runShutdownSteps } from '../electron/shutdown'

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} }

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runShutdownSteps', () => {
  it('按顺序执行并记录每步结果', async () => {
    const order: string[] = []
    const report = await runShutdownSteps(
      [
        { name: 'first', timeoutMs: 100, run: () => void order.push('first') },
        {
          name: 'second',
          timeoutMs: 100,
          run: async () => {
            order.push('second')
          }
        }
      ],
      { logger: silentLogger }
    )

    expect(order).toEqual(['first', 'second'])
    expect(report.ok).toBe(true)
    expect(report.steps.map((step) => step.name)).toEqual(['first', 'second'])
    expect(report.steps.every((step) => step.ok)).toBe(true)
  })

  it('某一步抛错不影响后续步骤', async () => {
    const ran: string[] = []
    const report = await runShutdownSteps(
      [
        {
          name: 'boom',
          timeoutMs: 100,
          run: () => {
            throw new Error('database is locked')
          }
        },
        { name: 'after', timeoutMs: 100, run: () => void ran.push('after') }
      ],
      { logger: silentLogger }
    )

    expect(ran).toEqual(['after'])
    expect(report.ok).toBe(false)
    expect(report.steps[0]).toMatchObject({ name: 'boom', ok: false })
    expect(report.steps[0].error).toContain('database is locked')
  })

  it('某一步超时后继续下一步，而不是永远等下去', async () => {
    vi.useFakeTimers()
    const ran: string[] = []
    const stuck = deferred()

    const promise = runShutdownSteps(
      [
        { name: 'stuck', timeoutMs: 500, run: () => stuck.promise },
        { name: 'after', timeoutMs: 500, run: () => void ran.push('after') }
      ],
      { logger: silentLogger }
    )
    await vi.advanceTimersByTimeAsync(500)
    const report = await promise

    expect(ran).toEqual(['after'])
    expect(report.steps[0]).toMatchObject({ name: 'stuck', ok: false })
    expect(report.steps[0].error).toContain('timed out')
    expect(report.ok).toBe(false)
  })
})

describe('createQuitSequencer', () => {
  function createHarness(overrides: Partial<Parameters<typeof createQuitSequencer>[0]> = {}) {
    const exits: number[] = []
    const shutdown = vi.fn(async () => {})
    const harness = createQuitSequencer({
      app: { exit: (code) => void exits.push(code ?? 0) },
      shutdown,
      shutdownTimeoutMs: 1000,
      stallTimeoutMs: 2000,
      logger: silentLogger,
      ...overrides
    })
    const event = { preventDefault: vi.fn() }
    return { harness, event, exits, shutdown }
  }

  it('will-quit 先拦下退出，清理完成后强制 exit', async () => {
    const { harness, event, exits, shutdown } = createHarness()

    harness.handleWillQuit(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(harness.isShuttingDown()).toBe(true)

    await vi.waitFor(() => expect(exits).toEqual([0]))
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('清理抛错也必须退出（不留残留进程）', async () => {
    const { harness, event, exits } = createHarness({
      shutdown: async () => {
        throw new Error('cleanup exploded')
      }
    })

    harness.handleWillQuit(event)
    await vi.waitFor(() => expect(exits).toEqual([0]))
  })

  it('清理卡住时由看门狗强制退出，且只退出一次', async () => {
    vi.useFakeTimers()
    const stuck = deferred()
    const { harness, event, exits } = createHarness({ shutdown: () => stuck.promise })

    harness.handleWillQuit(event)
    expect(exits).toEqual([])

    await vi.advanceTimersByTimeAsync(1000)
    expect(exits).toEqual([0])

    // 迟到的清理完成不能再触发第二次退出
    stuck.resolve()
    await vi.advanceTimersByTimeAsync(1000)
    expect(exits).toEqual([0])
  })

  it('清理进行中再次触发 will-quit 时不再拦截', () => {
    const { harness, event } = createHarness({ shutdown: () => deferred().promise })

    harness.handleWillQuit(event)
    const second = { preventDefault: vi.fn() }
    harness.handleWillQuit(second)

    expect(second.preventDefault).not.toHaveBeenCalled()
  })

  it('before-quit 卡住（渲染层不回应）时兜底退出，取消则撤掉看门狗', async () => {
    vi.useFakeTimers()
    const cancelled = createHarness()
    cancelled.harness.handleBeforeQuit()
    cancelled.harness.cancel()
    await vi.advanceTimersByTimeAsync(5000)
    expect(cancelled.exits).toEqual([])

    const stalled = createHarness()
    stalled.harness.handleBeforeQuit()
    await vi.advanceTimersByTimeAsync(2000)
    expect(stalled.exits).toEqual([0])
  })
})
