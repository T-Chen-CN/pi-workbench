/**
 * 设备心跳：每 30 秒告诉云端一次「这台机器还开着」。
 *
 * 为什么需要它：云端判定在线是「`last_seen_at` 在 90 秒内」。如果没有心跳，
 * 用户只是把窗口切走一会儿，云端与云端 Agent 就会觉得这台设备离线了 ——
 * 而实际上它一直开着，只是没在发消息。
 *
 * 三条纪律：
 * - **凭据从配置里现读**：登记 / 注销 / 换 token 之后不用重启心跳。
 * - **被注销就停**：401 `device_revoked` / `unauthorized` 时继续打只是噪音，
 *   停到用户重新登记（`poke()` 会被重新调一次）。
 * - **失败不打断任何人**：网络抖动只记状态，下一拍再试；不抛异常、不进日志刷屏。
 */

import type { HeartbeatResult } from './gateway.js'

/** 云端在线窗口（秒）。服务端也会回，回执优先。 */
const DEFAULT_ONLINE_WINDOW_S = 90
/** 心跳节奏：窗口的 1/3，但落在 [10s, 60s]，别把手机热点打穷。 */
const MIN_INTERVAL_MS = 10_000
const MAX_INTERVAL_MS = 60_000

export interface HeartbeatState {
  /** 最近一次成功心跳（本地时间，ms）；没成功过是 null */
  lastOkAt: number | null
  /** 最近一次失败原因；成功一次就清空 */
  lastError: string | null
  /** 因为被注销而停下（要重新登记才会再跳） */
  stoppedBecauseRevoked: boolean
}

export interface HeartbeatDeps {
  /** 读当前凭据：没有 token 就返回 null（未登记 / 已注销） */
  credential: () => { gatewayUrl: string; deviceToken: string } | null
  beat: (input: { gatewayUrl: string; deviceToken: string }) => Promise<HeartbeatResult>
  /** 状态变化时通知上层（用来推给界面，不用于做业务判断） */
  onState?: (state: HeartbeatState) => void
  /** 被云端撤销 / 凭据失效时调一次，让界面说清楚原因 */
  onRevoked?: (reason: string) => void
  now?: () => number
  /** 测试用：直接注入定时器 */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

export interface HeartbeatHandle {
  /** 立刻跳一拍（登记成功后、窗口重新可见时调） */
  poke: () => void
  /** 停掉（应用退出） */
  stop: () => void
  state: () => HeartbeatState
}

export function startHeartbeat(deps: HeartbeatDeps): HeartbeatHandle {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle))

  const state: HeartbeatState = {
    lastOkAt: null,
    lastError: null,
    stoppedBecauseRevoked: false,
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  let intervalMs = DEFAULT_ONLINE_WINDOW_S * 1000 / 3
  let stopped = false
  /** 防止 poke 与定时器同时发起两次心跳 */
  let inFlight = false

  const publish = (): void => {
    deps.onState?.({ ...state })
  }

  const schedule = (): void => {
    if (stopped) return
    if (timer) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      void tick()
    }, intervalMs)
  }

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return
    const credential = deps.credential()
    if (!credential || !credential.deviceToken) {
      // 未登记 / 已注销：不打网络，只等下一次（用户登记时会 poke，这里也不停表）
      schedule()
      return
    }
    inFlight = true
    try {
      const result = await deps.beat(credential)
      state.lastOkAt = now()
      state.lastError = null
      state.stoppedBecauseRevoked = false
      const windowS = Number(result?.onlineWindow)
      if (Number.isFinite(windowS) && windowS > 0) {
        intervalMs = Math.min(
          MAX_INTERVAL_MS,
          Math.max(MIN_INTERVAL_MS, Math.floor((windowS * 1000) / 3))
        )
      }
      publish()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.lastError = message
      const revoked = /\b(unauthorized|device_revoked)\b/i.test(message)
      if (revoked) {
        // 凭据已经废了：停下来，等用户重新登记（否则每 30s 一条 401）
        state.stoppedBecauseRevoked = true
        stopped = true
        if (timer) clearTimer(timer)
        timer = null
        publish()
        deps.onRevoked?.(message)
        return
      }
      publish()
    } finally {
      inFlight = false
    }
    schedule()
  }

  // 启动即跳一拍：登记完成后马上就能在云端看到「在线」
  void tick()

  return {
    poke: () => {
      stopped = false
      state.stoppedBecauseRevoked = false
      if (timer) clearTimer(timer)
      timer = null
      void tick()
    },
    stop: () => {
      stopped = true
      if (timer) clearTimer(timer)
      timer = null
    },
    state: () => ({ ...state }),
  }
}
