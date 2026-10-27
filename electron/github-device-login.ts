/**
 * GitHub 设备码登录会话（主进程）。
 *
 * clientId 内置在应用里，因此任何设备都不需要本地配置；应用向 GitHub 申请
 * 一次性用户码，用户在浏览器确认后由主进程轮询换取 token。device_code 与
 * token 都只留在主进程，渲染层只能看到用户码和状态事件。
 */

import { shell } from 'electron'
import { getGithubClientId } from './github-app.js'
import {
  GITHUB_DEVICE_VERIFICATION_URI,
  fetchGithubUser,
  pollDeviceFlow,
  saveGithubToken,
  startDeviceFlow,
  type GithubUser,
} from './github-auth.js'

/** 连续网络失败的重试次数（不含首次请求） */
const MAX_NETWORK_RETRIES = 3

export type GithubDeviceLoginEvent =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' | 'denied' | 'error'; error: string }

export interface GithubDeviceLoginStart {
  success: boolean
  userCode?: string
  verificationUri?: string
  expiresIn?: number
  interval?: number
  error?: string
}

export interface GithubDeviceLoginSinks {
  onEvent: (event: GithubDeviceLoginEvent) => void
  onComplete: (result: {
    success: boolean
    user?: GithubUser | null
    error?: string
  }) => void
}

interface DeviceSession {
  clientId: string
  deviceCode: string
  verificationUri: string
  interval: number
  expiresAt: number
  failures: number
  cancelled: boolean
  timer: ReturnType<typeof setTimeout> | null
}

let activeSession: DeviceSession | null = null

function stopSession(session: DeviceSession): void {
  session.cancelled = true
  if (session.timer) {
    clearTimeout(session.timer)
    session.timer = null
  }
  if (activeSession === session) activeSession = null
}

/** 取消进行中的设备码登录；返回是否有会话被取消 */
export function cancelGithubDeviceLogin(): boolean {
  if (!activeSession) return false
  stopSession(activeSession)
  return true
}

function schedulePoll(session: DeviceSession, sinks: GithubDeviceLoginSinks): void {
  if (session.cancelled) return
  const untilExpiry = Math.max(0, session.expiresAt - Date.now())
  const delay = Math.min(session.interval * 1000, untilExpiry)
  session.timer = setTimeout(() => {
    void pollOnce(session, sinks)
  }, delay)
  // 让轮询不阻塞应用退出
  session.timer.unref?.()
}

function finish(
  session: DeviceSession,
  event: GithubDeviceLoginEvent,
  sinks: GithubDeviceLoginSinks
): void {
  stopSession(session)
  sinks.onEvent(event)
}

async function pollOnce(
  session: DeviceSession,
  sinks: GithubDeviceLoginSinks
): Promise<void> {
  if (session.cancelled || activeSession !== session) return
  session.timer = null

  if (Date.now() >= session.expiresAt) {
    finish(session, { status: 'expired', error: 'The device code expired. Start again.' }, sinks)
    return
  }

  const result = await pollDeviceFlow(session.clientId, session.deviceCode)
  if (session.cancelled || activeSession !== session) return

  switch (result.status) {
    case 'pending':
      session.failures = 0
      sinks.onEvent({ status: 'pending' })
      schedulePoll(session, sinks)
      return
    case 'slow_down':
      session.failures = 0
      session.interval = Math.max(session.interval + 5, result.interval)
      sinks.onEvent({ status: 'slow_down', interval: session.interval })
      schedulePoll(session, sinks)
      return
    case 'expired':
    case 'denied':
      finish(session, { status: result.status, error: result.error }, sinks)
      return
    case 'error':
      if (result.retryable && session.failures < MAX_NETWORK_RETRIES) {
        session.failures += 1
        schedulePoll(session, sinks)
        return
      }
      finish(session, { status: 'error', error: result.error }, sinks)
      return
    case 'success': {
      stopSession(session)
      try {
        await saveGithubToken(result.token)
        const user = await fetchGithubUser(result.token)
        sinks.onComplete({ success: true, user })
      } catch (error) {
        sinks.onComplete({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
  }
}

/**
 * 开始设备码登录：申请用户码、打开浏览器并启动轮询。
 * 同一时刻只保留一个会话，重复开始会取消上一个。
 */
export async function startGithubDeviceLogin(
  sinks: GithubDeviceLoginSinks
): Promise<GithubDeviceLoginStart> {
  cancelGithubDeviceLogin()

  const clientId = getGithubClientId()
  if (!clientId) return { success: false, error: 'CLIENT_ID_NOT_CONFIGURED' }

  const started = await startDeviceFlow(clientId)
  if (!started.success || !started.deviceCode || !started.userCode) {
    return { success: false, error: started.error ?? 'DEVICE_CODE_MISSING' }
  }

  const session: DeviceSession = {
    clientId,
    deviceCode: started.deviceCode,
    verificationUri: started.verificationUri ?? GITHUB_DEVICE_VERIFICATION_URI,
    interval: Math.max(1, started.interval ?? 5),
    expiresAt: Date.now() + (started.expiresIn ?? 900) * 1000,
    failures: 0,
    cancelled: false,
    timer: null,
  }
  activeSession = session

  void shell.openExternal(session.verificationUri).catch(() => undefined)
  schedulePoll(session, sinks)

  return {
    success: true,
    userCode: started.userCode,
    verificationUri: session.verificationUri,
    expiresIn: started.expiresIn ?? 900,
    interval: session.interval,
  }
}

/** 重新打开设备授权页面（用于用户关掉了浏览器标签的情况） */
export async function openGithubDeviceVerification(): Promise<boolean> {
  const uri = activeSession?.verificationUri ?? GITHUB_DEVICE_VERIFICATION_URI
  try {
    await shell.openExternal(uri)
    return true
  } catch {
    return false
  }
}
