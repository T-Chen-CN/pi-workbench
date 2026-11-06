import { describe, expect, it, vi } from 'vitest'
import { startHeartbeat, type HeartbeatState } from '../electron/cloud/heartbeat'

/** 可控时钟 + 可控定时器：心跳要测得出来「跳了几拍」而不是真的等 30 秒 */
function harness(options: {
  credential?: () => { gatewayUrl: string; deviceToken: string } | null
  beat?: (input: { gatewayUrl: string; deviceToken: string }) => Promise<{
    ok: boolean
    deviceId: string
    serverTime: number
    onlineWindow: number
  }>
  onRevoked?: (reason: string) => void
} = {}) {
  let now = 1_000_000
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const states: HeartbeatState[] = []

  const handle = startHeartbeat({
    credential:
      options.credential ??
      (() => ({ gatewayUrl: 'https://hub.example.com', deviceToken: 'pi_dev' })),
    beat:
      options.beat ??
      (async () => ({ ok: true, deviceId: 'dev-1', serverTime: 1, onlineWindow: 90 })),
    onState: (state) => states.push(state),
    onRevoked: options.onRevoked,
    now: () => now,
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cancelled: false }
      timers.push(entry)
      return entry as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (entry) => {
      ;(entry as unknown as { cancelled: boolean }).cancelled = true
    },
  })

  return {
    handle,
    states,
    timers,
    advance(ms: number) {
      now += ms
    },
    /** 跑当前挂着的定时器（跳过被取消的） */
    async fire(): Promise<void> {
      const pending = timers.filter((t) => !t.cancelled)
      timers.length = 0
      for (const t of pending) {
        t.fn()
      }
      // 让 await 链跑完
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    pending() {
      return timers.filter((t) => !t.cancelled)
    },
  }
}

describe('设备心跳', () => {
  it('beats immediately on start so the cloud sees it online', async () => {
    const beat = vi.fn(async () => ({
      ok: true,
      deviceId: 'dev-1',
      serverTime: 1,
      onlineWindow: 90,
    }))
    const h = harness({ beat })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(beat).toHaveBeenCalledTimes(1)
    expect(h.handle.state().lastOkAt).toBe(1_000_000)
    h.handle.stop()
  })

  it('schedules the next beat inside the online window', async () => {
    const h = harness()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [next] = h.pending()
    // 窗口 90s → 每 30s 一拍
    expect(next.ms).toBe(30_000)
    h.handle.stop()
  })

  it('clamps the interval so a weird window cannot spam the hub', async () => {
    const h = harness({
      beat: async () => ({ ok: true, deviceId: 'dev-1', serverTime: 1, onlineWindow: 3 }),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.pending()[0].ms).toBe(10_000)
    h.handle.stop()
  })

  it('does nothing until the device is registered', async () => {
    const beat = vi.fn(async () => ({
      ok: true,
      deviceId: 'dev-1',
      serverTime: 1,
      onlineWindow: 90,
    }))
    const h = harness({ credential: () => null, beat })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(beat).not.toHaveBeenCalled()
    // 但表不能停：用户登记后不用重启应用
    expect(h.pending().length).toBe(1)
    h.handle.stop()
  })

  it('keeps retrying after a network blip and reports the error', async () => {
    let calls = 0
    const h = harness({
      beat: async () => {
        calls += 1
        if (calls === 1) throw new Error('socket hang up')
        return { ok: true, deviceId: 'dev-1', serverTime: 1, onlineWindow: 90 }
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.handle.state().lastError).toContain('socket')
    expect(h.pending().length).toBe(1)

    await h.fire()
    expect(h.handle.state().lastError).toBeNull()
    expect(h.handle.state().lastOkAt).not.toBeNull()
    h.handle.stop()
  })

  it('stops beating once the cloud revokes the credential', async () => {
    const onRevoked = vi.fn()
    const h = harness({
      beat: async () => {
        throw new Error('device_revoked: token is no longer valid')
      },
      onRevoked,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onRevoked).toHaveBeenCalledTimes(1)
    expect(h.handle.state().stoppedBecauseRevoked).toBe(true)
    // 401 之后继续打只是噪音
    expect(h.pending().length).toBe(0)
    h.handle.stop()
  })

  it('stops beating when the gateway reports the revocation in Chinese', async () => {
    // 真实链路：gateway.ts 把 device_revoked 翻成中文，英文码只在 CloudApiError 字段上
    const onRevoked = vi.fn()
    const error = Object.assign(new Error('这台设备已被注销（在云端重新登记即可）'), {
      code: 'unauthorized',
      backendCode: 'device_revoked',
    })
    const h = harness({
      beat: async () => {
        throw error
      },
      onRevoked,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onRevoked).toHaveBeenCalledTimes(1)
    expect(h.handle.state().stoppedBecauseRevoked).toBe(true)
    expect(h.pending().length).toBe(0)
    h.handle.stop()
  })

  it('resumes when the user registers again (poke)', async () => {
    let calls = 0
    const h = harness({
      beat: async () => {
        calls += 1
        if (calls === 1) throw new Error('unauthorized')
        return { ok: true, deviceId: 'dev-1', serverTime: 1, onlineWindow: 90 }
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.handle.state().stoppedBecauseRevoked).toBe(true)

    h.handle.poke()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.handle.state().stoppedBecauseRevoked).toBe(false)
    expect(h.handle.state().lastError).toBeNull()
    h.handle.stop()
  })

  it('never runs two beats at once', async () => {
    let running = 0
    let maxRunning = 0
    const h = harness({
      beat: async () => {
        running += 1
        maxRunning = Math.max(maxRunning, running)
        await new Promise((resolve) => setTimeout(resolve, 5))
        running -= 1
        return { ok: true, deviceId: 'dev-1', serverTime: 1, onlineWindow: 90 }
      },
    })
    h.handle.poke()
    h.handle.poke()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(maxRunning).toBe(1)
    h.handle.stop()
  })

  it('stops scheduling after stop()', async () => {
    const h = harness()
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.handle.stop()
    expect(h.pending().length).toBe(0)
  })
})
