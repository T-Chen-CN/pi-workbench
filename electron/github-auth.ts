/**
 * GitHub 设备码授权（Device Flow）与凭据存储。
 *
 * 设备码流程不需要 client secret：应用显示用户码，用户在自己的浏览器里确认，
 * 应用轮询 GitHub 换取访问令牌。令牌用 Electron safeStorage 加密后保存在
 * {appDir}/config/github.json；应用从不把令牌写入日志或返回给渲染进程。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { safeStorage } from 'electron'
import { getAppDir } from './app-paths.js'

export const GITHUB_DEVICE_VERIFICATION_URI = 'https://github.com/login/device'
export const GITHUB_OAUTH_SCOPES = 'repo read:user'

export interface GithubUser {
  login: string
  name: string | null
  avatarUrl: string | null
}

export interface DeviceFlowStart {
  success: boolean
  deviceCode?: string
  userCode?: string
  verificationUri?: string
  expiresIn?: number
  interval?: number
  error?: string
}

export type DeviceFlowPoll =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'success'; token: string; scope?: string }
  | { status: 'expired' | 'denied'; error: string }
  | { status: 'error'; error: string; retryable: boolean }

interface GithubAuthFile {
  token?: string
  clientId?: string
}

function authFilePath(): string {
  return path.join(getAppDir(), 'config', 'github.json')
}

function decryptToken(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('enc:')) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
  } catch {
    return null
  }
}

function encryptToken(token: string | null): string | null {
  if (!token) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  return `enc:${safeStorage.encryptString(token).toString('base64')}`
}

async function readFile(): Promise<GithubAuthFile> {
  try {
    const raw = await fs.readFile(authFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as GithubAuthFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeFile(data: GithubAuthFile): Promise<void> {
  await fs.mkdir(path.dirname(authFilePath()), { recursive: true })
  await fs.writeFile(authFilePath(), JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
}

export async function readGithubAuth(): Promise<{
  token: string | null
  clientId: string | null
}> {
  const data = await readFile()
  return {
    token: decryptToken(data.token),
    clientId: typeof data.clientId === 'string' && data.clientId.trim() ? data.clientId.trim() : null,
  }
}

export async function saveGithubToken(token: string | null): Promise<void> {
  const current = await readFile()
  await writeFile({ ...current, token: encryptToken(token) ?? undefined })
}

export async function saveGithubClientId(clientId: string | null): Promise<void> {
  const current = await readFile()
  const next = clientId?.trim()
  await writeFile({ ...current, clientId: next || undefined })
}

export async function clearGithubToken(): Promise<void> {
  await saveGithubToken(null)
}

export async function startDeviceFlow(
  clientId: string,
  scopes = GITHUB_OAUTH_SCOPES
): Promise<DeviceFlowStart> {
  if (!clientId.trim()) return { success: false, error: 'CLIENT_ID_REQUIRED' }
  try {
    const response = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'pi-workbench',
      },
      body: new URLSearchParams({ client_id: clientId.trim(), scope: scopes }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await response.json()) as {
      device_code?: string
      user_code?: string
      verification_uri?: string
      expires_in?: number
      interval?: number
      error?: string
      error_description?: string
    }
    if (!response.ok || body.error || !body.device_code || !body.user_code) {
      return {
        success: false,
        error: body.error_description || body.error || `GitHub returned ${response.status}`,
      }
    }
    return {
      success: true,
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri ?? GITHUB_DEVICE_VERIFICATION_URI,
      expiresIn: body.expires_in ?? 900,
      interval: body.interval ?? 5,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function pollDeviceFlow(
  clientId: string,
  deviceCode: string
): Promise<DeviceFlowPoll> {
  try {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'pi-workbench',
      },
      body: new URLSearchParams({
        client_id: clientId.trim(),
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await response.json()) as {
      access_token?: string
      token_type?: string
      scope?: string
      interval?: number
      error?: string
      error_description?: string
    }
    if (body.access_token) {
      return { status: 'success', token: body.access_token, scope: body.scope }
    }
    if (body.error === 'authorization_pending') return { status: 'pending' }
    if (body.error === 'slow_down') {
      return { status: 'slow_down', interval: body.interval ?? 10 }
    }
    if (body.error === 'expired_token') {
      return { status: 'expired', error: 'The device code expired. Start the login again.' }
    }
    if (body.error === 'access_denied') {
      return { status: 'denied', error: 'Authorization was denied on GitHub.' }
    }
    return {
      status: 'error',
      error: body.error_description || body.error || `GitHub returned ${response.status}`,
      retryable: false,
    }
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    }
  }
}

export async function fetchGithubUser(token: string): Promise<GithubUser | null> {
  if (!token) return null
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'pi-workbench',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const body = (await response.json()) as {
      login?: string
      name?: string | null
      avatar_url?: string | null
    }
    if (!body.login) return null
    return {
      login: body.login,
      name: typeof body.name === 'string' ? body.name : null,
      avatarUrl: typeof body.avatar_url === 'string' ? body.avatar_url : null,
    }
  } catch {
    return null
  }
}
