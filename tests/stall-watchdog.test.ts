import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StallWatchdog } from '../pi-bridge/src/stall-watchdog'

const TIMEOUT = 120_000

function createWatchdog(onStall = vi.fn()) {
  const watchdog = new StallWatchdog({ timeoutMs: TIMEOUT, onStall })
  return { watchdog, onStall }
}

describe('StallWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires once the model has been silent for the full timeout', async () => {
    const { watchdog, onStall } = createWatchdog()
    watchdog.start()

    await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
    expect(onStall).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onStall).toHaveBeenCalledTimes(1)
    expect(onStall.mock.calls[0][0]).toBeGreaterThanOrEqual(TIMEOUT)
  })

  it('reports the stall only once', async () => {
    const { watchdog, onStall } = createWatchdog()
    watchdog.start()

    await vi.advanceTimersByTimeAsync(TIMEOUT)
    await vi.advanceTimersByTimeAsync(TIMEOUT * 3)

    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting while deltas keep arriving', async () => {
    const { watchdog, onStall } = createWatchdog()
    watchdog.start()

    // 50 分钟的长轮次，每 60s 一个增量
    for (let index = 0; index < 50; index += 1) {
      await vi.advanceTimersByTimeAsync(TIMEOUT / 2)
      watchdog.touch()
    }

    expect(onStall).not.toHaveBeenCalled()
    expect(watchdog.isArmed).toBe(true)
  })

  it('suspends while a tool is running', async () => {
    const { watchdog, onStall } = createWatchdog()
    watchdog.start()
    watchdog.beginTool('tool-1')

    // 静默 20 分钟：命令可能一直没有输出，属于合法等待
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(onStall).not.toHaveBeenCalled()
    expect(watchdog.isArmed).toBe(false)

    watchdog.endTool('tool-1')
    expect(watchdog.isArmed).toBe(true)

    // 工具结束后重新按空闲计时
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
    expect(onStall).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('stays suspended until every parallel tool call has ended', async () => {
    const { watchdog, onStall } = createWatchdog()
    watchdog.start()
    watchdog.beginTool('tool-1')
    watchdog.beginTool('tool-2')

    watchdog.endTool('tool-1')
    expect(watchdog.isArmed).toBe(false)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(onStall).not.toHaveBeenCalled()

    watchdog.endTool('tool-2')
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('suspends while a tool approval is pending', async () => {
    const { watchdog, onStall } = createWatchdog()
    watchdog.start()
    // 审批是 tool_call 钩子，先于 tool_execution_start：这段静默由审批自己的上限兜底
    watchdog.beginApproval()

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(onStall).not.toHaveBeenCalled()

    watchdog.endApproval()
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
    expect(onStall).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('stays suspended while either a tool or an approval is open', async () => {
    const { watchdog, onStall } = createWatchdog()
    watchdog.start()
    watchdog.beginApproval()
    watchdog.beginTool('tool-1')

    watchdog.endTool('tool-1')
    await vi.advanceTimersByTimeAsync(TIMEOUT * 2)
    expect(onStall).not.toHaveBeenCalled()

    watchdog.endApproval()
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('does not fire after stop and clears its timer', async () => {
    const { watchdog, onStall } = createWatchdog()
    watchdog.start()
    watchdog.touch()
    expect(vi.getTimerCount()).toBe(1)

    watchdog.stop()
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(TIMEOUT * 2)
    expect(onStall).not.toHaveBeenCalled()
    expect(watchdog.isArmed).toBe(false)
  })

  it('stays idle when the timeout is disabled', async () => {
    const onStall = vi.fn()
    const watchdog = new StallWatchdog({ timeoutMs: 0, onStall })
    watchdog.start()

    await vi.advanceTimersByTimeAsync(TIMEOUT * 2)
    expect(onStall).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores touches before start', async () => {
    const { watchdog, onStall } = createWatchdog()
    watchdog.touch()
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(TIMEOUT * 2)
    expect(onStall).not.toHaveBeenCalled()
  })
})
