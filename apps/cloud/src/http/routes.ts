/**
 * 控制面 REST（F-01 ~ F-12 / F-53 ~ F-54）。
 *
 * 只做三件事：身份（唯一管理员账号 + cookie 会话）、设备（6 位配对码 + token）、
 * 云端模型配置（AES-256-GCM 落盘、只回掩码）。会话内容一概不走 REST——
 * 那是 `/client/ws` 的事，避免一条逻辑连接被劈成两条腿（D-10）。
 */

import { randomBytes } from 'crypto'
import type { CloudSnapshot, CloudWorkspaceInfo } from 'pi-bridge'
import type { CloudConfig } from '../config.js'
import type { CloudStore, DeviceRecord } from '../store/store.js'
import { PAIRING_CODE_TTL_MS } from '../store/store.js'
import {
  createPairingCode,
  createToken,
  hashPassword,
  hashToken,
  verifyPassword,
  verifyToken,
} from '../auth/credentials.js'
import type { AttemptLimiter } from '../auth/rate-limit.js'
import {
  clearSessionCookieHeader,
  issueSessionCookie,
  readCookie,
  SESSION_COOKIE,
  sessionCookieHeader,
  verifySessionCookie,
} from '../auth/session-cookie.js'
import { HttpError, Router, sendJson, type RequestContext } from './router.js'
import { decryptSecret, encryptSecret, maskSecret } from '../secure/config-crypto.js'
import {
  DEFAULT_AUTHORIZATION_TTL_MS,
  DEFAULT_QUOTA,
  type AuthorizationRecord,
} from '../tasks/authorization.js'
import type { CloudSession } from '../agent/cloud-session.js'
import type { TaskDispatcher } from '../tasks/dispatcher.js'

export interface RouteDeps {
  config: CloudConfig
  store: CloudStore
  dispatcher: TaskDispatcher
  session: CloudSession
  loginLimiter: AttemptLimiter
  pairLimiter: AttemptLimiter
  snapshot: () => Promise<CloudSnapshot>
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

/** 所有凭据类失败对外同一个错误码（不透露「码是否存在 / 是否过期」） */
const CREDENTIAL_ERROR = 'invalid-credential'

export function buildRouter(deps: RouteDeps): Router {
  const router = new Router()

  const requireSession = (ctx: RequestContext): void => {
    const value = readCookie(ctx.req.headers.cookie, SESSION_COOKIE)
    const payload = verifySessionCookie(deps.config.cookieSecret, value)
    if (!payload) throw new HttpError(401, 'Login required', 'unauthorized')
  }

  const requireDevice = (ctx: RequestContext): DeviceRecord => {
    const header = ctx.req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const device = token ? deps.store.findDeviceByToken(token) : undefined
    if (!device) throw new HttpError(401, 'Unknown or revoked device', 'unauthorized')
    return device
  }

  router.get('/v1/health', () => ({
    ok: true,
    version: deps.config.version,
    ready: deps.session.currentSessionId !== null,
    hasAccount: deps.store.getAccount() !== null,
  }))

  router.get('/v1/me', (ctx) => {
    const value = readCookie(ctx.req.headers.cookie, SESSION_COOKIE)
    const payload = verifySessionCookie(deps.config.cookieSecret, value)
    return { authenticated: Boolean(payload), hasAccount: deps.store.getAccount() !== null }
  })

  /** F-01：唯一的自助入口，只允许创建一次；之后必须登录 */
  router.post('/v1/setup', async (ctx) => {
    if (deps.store.getAccount()) throw new HttpError(409, 'Account already exists', 'conflict')
    const body = await ctx.json<{ password?: string }>()
    const password = String(body.password ?? '')
    if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
    const hashed = await hashPassword(password)
    const now = Date.now()
    const created = await deps.store.createAccount({
      passwordHash: hashed.hash,
      salt: hashed.salt,
      createdAt: now,
      updatedAt: now,
    })
    if (!created) throw new HttpError(409, 'Account already exists', 'conflict')
    deps.logger.info('[cloud] admin account created')
    return { ok: true }
  })

  router.post('/v1/login', async (ctx) => {
    const account = deps.store.getAccount()
    if (!account) throw new HttpError(409, 'No account yet', 'conflict')
    const source = ctx.source
    if (!deps.loginLimiter.canAttempt(source).allowed) {
      throw new HttpError(429, CREDENTIAL_ERROR, 'rate-limited')
    }
    const body = await ctx.json<{ password?: string }>()
    const ok = await verifyPassword(String(body.password ?? ''), {
      hash: account.passwordHash,
      salt: account.salt,
    })
    if (!ok) {
      deps.loginLimiter.recordFailure(source)
      throw new HttpError(401, CREDENTIAL_ERROR, CREDENTIAL_ERROR)
    }
    deps.loginLimiter.recordSuccess(source)
    const cookie = issueSessionCookie(deps.config.cookieSecret)
    ctx.res.setHeader(
      'Set-Cookie',
      sessionCookieHeader({ value: cookie, secure: deps.config.secureCookies })
    )
    return { ok: true }
  })

  router.post('/v1/logout', (ctx) => {
    ctx.res.setHeader('Set-Cookie', clearSessionCookieHeader(deps.config.secureCookies))
    return { ok: true }
  })

  /** F-04：6 位纯数字、一次性、5 分钟、只显示一次 */
  router.post('/v1/pair/code', (ctx) => {
    requireSession(ctx)
    const code = createPairingCode()
    const hashed = hashToken(code)
    void deps.store.issuePairingCode({ codeHash: hashed.hash, salt: hashed.salt })
    return { code, expiresAt: Date.now() + PAIRING_CODE_TTL_MS }
  })

  /**
   * F-05：配对。限速 + 熔断 + CAS 作废；所有失败同一个错误码。
   * 一台机器一条设备记录、一个 token；`/client/ws` 与 `/device/ws` 共用（D-22）。
   */
  router.post('/v1/pair', async (ctx) => {
    const source = ctx.source
    const gate = deps.pairLimiter.canAttempt(source)
    if (!gate.allowed) throw new HttpError(429, CREDENTIAL_ERROR, 'rate-limited')

    const body = await ctx.json<{
      code?: string
      deviceName?: string
      platform?: string
      workspaces?: CloudWorkspaceInfo[]
    }>()
    const code = String(body.code ?? '').trim()
    if (!/^\d{6}$/.test(code)) {
      deps.pairLimiter.recordFailure(source)
      throw new HttpError(401, CREDENTIAL_ERROR, CREDENTIAL_ERROR)
    }

    // 用每个未使用码的 salt 逐条比对哈希
    const candidates = deps.store.listPairingCodes()
    let consumed: string | null = null
    for (const candidate of candidates) {
      const hashed = hashToken(code, candidate.salt)
      if (hashed.hash !== candidate.hash) continue
      const record = await deps.store.consumePairingCode(hashed.hash)
      if (!record) break
      consumed = hashed.hash
      break
    }
    if (!consumed) {
      deps.pairLimiter.recordFailure(source)
      throw new HttpError(401, CREDENTIAL_ERROR, CREDENTIAL_ERROR)
    }
    deps.pairLimiter.recordSuccess(source)

    const token = createToken()
    const deviceId = `dev-${randomBytes(4).toString('hex')}`
    const now = Date.now()
    await deps.store.addDevice({
      id: deviceId,
      name: String(body.deviceName ?? 'Device').slice(0, 60),
      platform: String(body.platform ?? 'unknown').slice(0, 40),
      token: hashToken(token),
      createdAt: now,
      lastSeenAt: now,
      workspaces: sanitizeWorkspaces(body.workspaces),
      revokedAt: null,
    })
    deps.logger.info(`[cloud] device paired: ${deviceId}`)
    return { deviceId, token, protocol: 1 }
  })

  /** F-09：工作区清单上报（终端 token 鉴权，可随时刷新） */
  router.put('/v1/workspaces', async (ctx) => {
    const device = requireDevice(ctx)
    const body = await ctx.json<{ workspaces?: CloudWorkspaceInfo[] }>()
    await deps.store.updateDevice(device.id, {
      workspaces: sanitizeWorkspaces(body.workspaces),
      lastSeenAt: Date.now(),
    })
    return { ok: true }
  })

  router.get('/v1/devices', (ctx) => {
    requireSession(ctx)
    return { devices: deps.dispatcher.deviceSnapshots() }
  })

  /** F-08：解绑 → 该端重连 401，提示「已被云端移除」 */
  router.delete('/v1/devices/:id', async (ctx) => {
    requireSession(ctx)
    const device = deps.store.findDevice(ctx.params.id)
    if (!device) throw new HttpError(404, 'Unknown device')
    await deps.store.updateDevice(device.id, { revokedAt: Date.now() })
    return { ok: true }
  })

  router.get('/v1/cloud-config', (ctx) => {
    requireSession(ctx)
    const record = deps.store.getCloudConfig()
    if (!record) return { configured: false }
    let keyTail = ''
    try {
      keyTail = maskSecret(decryptSecret(record.apiKeyCipher, deps.config.encryptionKey))
    } catch {
      keyTail = '********'
    }
    return {
      configured: true,
      provider: record.provider,
      apiUrl: record.apiUrl,
      model: record.model,
      apiKeyMasked: keyTail,
      updatedAt: record.updatedAt,
    }
  })

  /** F-10 ~ F-13：配置由客户端推上来，AES 加密落盘，只回掩码 */
  router.put('/v1/cloud-config', async (ctx) => {
    requireSession(ctx)
    const body = await ctx.json<{
      provider?: string
      apiUrl?: string
      model?: string
      apiKey?: string
    }>()
    const provider = String(body.provider ?? '').trim()
    const apiUrl = String(body.apiUrl ?? '').trim()
    const model = String(body.model ?? '').trim()
    const apiKey = String(body.apiKey ?? '').trim()
    if (!provider || !apiUrl || !model || !apiKey) {
      throw new HttpError(400, 'provider, apiUrl, model and apiKey are required')
    }
    await deps.store.saveCloudConfig({
      provider,
      apiUrl,
      model,
      apiKeyCipher: encryptSecret(apiKey, deps.config.encryptionKey),
      updatedAt: Date.now(),
    })
    deps.logger.info(`[cloud] cloud config updated for model ${model}`)
    return { ok: true, apiKeyMasked: maskSecret(apiKey), takesEffect: 'next-turn' }
  })

  router.get('/v1/snapshot', async (ctx) => {
    requireSession(ctx)
    return deps.snapshot()
  })

  router.get('/v1/authorizations', (ctx) => {
    requireSession(ctx)
    return { authorizations: deps.store.activeAuthorizations().map(toView) }
  })

  /** F-18：确认动作落盘，作为后续派活的授权凭据（只能由用户端触发） */
  router.post('/v1/authorizations', async (ctx) => {
    requireSession(ctx)
    const body = await ctx.json<{
      planText?: string
      items?: Array<{ deviceId?: string; workspacePath?: string }>
      quota?: number
    }>()
    const items = (body.items ?? [])
      .map((item) => ({
        deviceId: String(item.deviceId ?? ''),
        workspacePath: String(item.workspacePath ?? ''),
      }))
      .filter((item) => item.deviceId && item.workspacePath)
    if (items.length === 0) throw new HttpError(400, 'At least one device/repository is required')
    const now = Date.now()
    const record: AuthorizationRecord = {
      id: `auth-${randomBytes(4).toString('hex')}`,
      items,
      quota: Math.max(1, Math.min(50, Number(body.quota ?? DEFAULT_QUOTA) || DEFAULT_QUOTA)),
      used: 0,
      confirmedAt: now,
      confirmedSummary: String(body.planText ?? '').slice(0, 400),
      expiresAt: now + DEFAULT_AUTHORIZATION_TTL_MS,
      revokedAt: null,
    }
    await deps.store.saveAuthorization(record)
    deps.logger.info(`[cloud] authorization ${record.id} confirmed for ${items.length} target(s)`)
    return { authorization: toView(record) }
  })

  router.delete('/v1/authorizations/:id', async (ctx) => {
    requireSession(ctx)
    await deps.store.revokeAuthorization(ctx.params.id)
    return { ok: true }
  })

  return router
}

function toView(record: AuthorizationRecord) {
  return {
    id: record.id,
    items: record.items,
    quota: record.quota,
    used: record.used,
    confirmedAt: record.confirmedAt,
    confirmedSummary: record.confirmedSummary,
    expiresAt: record.expiresAt,
  }
}

/** 只接受结构合法的仓库条目；路径与名称都做长度裁剪（不信任客户端上报的内容） */
function sanitizeWorkspaces(input: unknown): CloudWorkspaceInfo[] {
  if (!Array.isArray(input)) return []
  const result: CloudWorkspaceInfo[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const workspacePath = String(record.path ?? '').trim()
    if (!workspacePath) continue
    result.push({
      path: workspacePath.slice(0, 1024),
      name: String(record.name ?? workspacePath.split(/[\\/]/).pop() ?? 'workspace').slice(0, 80),
      remote: record.remote ? String(record.remote).slice(0, 300) : undefined,
      defaultBranch: record.defaultBranch ? String(record.defaultBranch).slice(0, 120) : undefined,
      isGit: record.isGit !== false,
    })
  }
  return result
}

/** 设备 token 直通（桌面端 / Web 的 Bearer 场景由 WS 层校验，这里只导出给测试） */
export { verifyToken, sendJson }
