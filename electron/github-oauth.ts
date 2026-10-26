/**
 * GitHub OAuth 授权码流程（桌面应用，无后端）。
 *
 * 授权窗口在系统浏览器中打开，GitHub 通过自定义协议 pi-workbench://oauth
 * 把 code 交回应用；主进程用 PKCE verifier + client secret 换 token，
 * 再用 safeStorage 加密保存。secret 只从本地配置或环境变量读取，不进源码。
 */

import { createHash, randomBytes } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import { shell } from 'electron'
import { getAppDir } from './app-paths.js'
import {
  fetchGithubUser,
  readGithubAuth,
  saveGithubToken,
  type GithubUser,
} from './github-auth.js'

export const GITHUB_PROTOCOL = 'pi-workbench'
export const GITHUB_CALLBACK_URL = `${GITHUB_PROTOCOL}://oauth`
export const GITHUB_OAUTH_SCOPES = 'repo read:user'

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const OAUTH_CONFIG_FILE = 'github-oauth.json'
const LOGIN_TTL_MS = 10 * 60_000

interface OAuthConfig {
  clientId: string
  clientSecret: string
}

interface PendingLogin {
  state: string
  verifier: string
  createdAt: number
}

let pendingLogin: PendingLogin | null = null

function oauthConfigPath(): string {
  return path.join(getAppDir(), 'config', OAUTH_CONFIG_FILE)
}

/** 读取 OAuth App 配置；环境变量优先，便于打包版注入 */
export async function readGithubOAuthConfig(): Promise<OAuthConfig | null> {
  const envId = process.env.PI_WORKBENCH_GITHUB_CLIENT_ID?.trim()
  const envSecret = process.env.PI_WORKBENCH_GITHUB_CLIENT_SECRET?.trim()
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret }
  try {
    const raw = await fs.readFile(oauthConfigPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<OAuthConfig>
    const clientId = typeof parsed.clientId === 'string' ? parsed.clientId.trim() : ''
    const clientSecret =
      typeof parsed.clientSecret === 'string' ? parsed.clientSecret.trim() : ''
    if (clientId && clientSecret) return { clientId, clientSecret }
  } catch {
    // 配置缺失时由调用方返回可读错误
  }
  return null
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

/**
 * 开始授权：生成 PKCE 与 state，打开系统浏览器。
 * 返回 authUrl 仅用于调试；不包含 secret。
 */
export async function startGithubOAuth(): Promise<{
  success: boolean
  authUrl?: string
  error?: string
}> {
  const config = await readGithubOAuthConfig()
  if (!config) return { success: false, error: 'OAUTH_APP_NOT_CONFIGURED' }

  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  const state = base64Url(randomBytes(16))
  pendingLogin = { state, verifier, createdAt: Date.now() }

  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', GITHUB_CALLBACK_URL)
  url.searchParams.set('scope', GITHUB_OAUTH_SCOPES)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('allow_signup', 'true')

  try {
    await shell.openExternal(url.toString())
  } catch {
    // 浏览器打开失败时仍返回 authUrl，界面可提供手动打开
  }
  return { success: true, authUrl: url.toString() }
}

export function isGithubCallbackUrl(url: string): boolean {
  return /^pi-workbench:\/\/oauth(?:[/?#]|$)/i.test(url)
}

/** 处理 pi-workbench://oauth?... 回调：校验 state、换 token、保存并返回用户 */
export async function completeGithubOAuth(url: string): Promise<{
  success: boolean
  user?: GithubUser | null
  error?: string
}> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { success: false, error: 'Invalid callback URL' }
  }
  if (parsed.protocol !== `${GITHUB_PROTOCOL}:` || parsed.hostname !== 'oauth') {
    return { success: false, error: 'Unexpected callback URL' }
  }

  const errorParam = parsed.searchParams.get('error')
  if (errorParam) {
    return {
      success: false,
      error: parsed.searchParams.get('error_description') ?? errorParam,
    }
  }

  const code = parsed.searchParams.get('code') ?? ''
  const state = parsed.searchParams.get('state') ?? ''
  if (!code) return { success: false, error: 'Missing authorization code' }

  const pending = pendingLogin
  pendingLogin = null
  if (
    !pending ||
    !state ||
    pending.state !== state ||
    Date.now() - pending.createdAt > LOGIN_TTL_MS
  ) {
    return { success: false, error: 'OAuth state is invalid or expired. Start again.' }
  }

  const config = await readGithubOAuthConfig()
  if (!config) return { success: false, error: 'OAUTH_APP_NOT_CONFIGURED' }

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'pi-workbench',
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: GITHUB_CALLBACK_URL,
        code_verifier: pending.verifier,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await response.json()) as {
      access_token?: string
      error?: string
      error_description?: string
    }
    if (!response.ok || body.error || !body.access_token) {
      return {
        success: false,
        error:
          body.error_description || body.error || `GitHub returned ${response.status}`,
      }
    }

    await saveGithubToken(body.access_token)
    const stored = await readGithubAuth()
    if (stored.token !== body.access_token) {
      return { success: false, error: 'Failed to store the GitHub token securely' }
    }

    const user = await fetchGithubUser(body.access_token)
    return { success: true, user }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
