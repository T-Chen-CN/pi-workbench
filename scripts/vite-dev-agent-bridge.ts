import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Connect, Plugin } from 'vite'

/**
 * 仅开发模式使用的 Agent 桥接。
 *
 * Web 模式下渲染进程没有 Electron 主进程可用，因此由 Vite dev server 在 Node 里
 * 运行同一套 AgentManager（pi-bridge），浏览器通过 HTTP 调用，便于纯 Web 调试。
 */
const DEV_AGENT_INIT = '/__pi/agent/init'
const DEV_AGENT_CHAT = '/__pi/agent/chat'
const DEV_AGENT_CHAT_STREAM = '/__pi/agent/chat-stream'
const DEV_AGENT_ABORT = '/__pi/agent/abort'
const DEV_AGENT_DISPOSE = '/__pi/agent/dispose'
const DEV_AGENT_SESSIONS_LIST = '/__pi/agent/sessions/list'
const DEV_AGENT_SESSIONS_OPEN = '/__pi/agent/sessions/open'
const DEV_AGENT_SESSIONS_CREATE = '/__pi/agent/sessions/create'
const DEV_AGENT_SESSIONS_CLOSE = '/__pi/agent/sessions/close'
const DEV_AGENT_SESSIONS_RENAME = '/__pi/agent/sessions/rename'
const DEV_AGENT_SESSIONS_DELETE = '/__pi/agent/sessions/delete'
const DEV_AGENT_SESSIONS_TABS_GET = '/__pi/agent/sessions/tabs/get'
const DEV_AGENT_SESSIONS_TABS_SET = '/__pi/agent/sessions/tabs/set'

const DEV_AGENT_HEADER = 'x-pi-dev-token'
const DEV_AGENT_MAX_BODY_BYTES = 16 * 1024 * 1024

type JsonObject = Record<string, unknown>

export interface DevAgentManager {
  initialize(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }>
  chat(
    sessionOrMessage: string,
    messageOrOptions?: string | Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>
  abort(sessionId?: string): Promise<unknown>
  dispose(): Promise<void>
  listSessions(): Promise<unknown>
  getCurrentSessionId?: () => string | null
  openSession(sessionId?: unknown): Promise<unknown>
  createSession(): Promise<unknown>
  closeSession(sessionId: string): Promise<unknown>
  renameSession(sessionId: string, name: string): Promise<unknown>
  deleteSession(sessionId: string): Promise<unknown>
}

export interface DevAgentManagerConstructor {
  new (): DevAgentManager
}

export interface DevAgentBridgeOptions {
  /** 测试覆盖用：注入一次性鉴权令牌 */
  token?: string
  /** 测试覆盖用：替换动态加载 pi-bridge/dist/index.js 的 AgentManager 构造器 */
  loadAgentManager?: () => Promise<DevAgentManagerConstructor>
}

function isTrustedDevBridgeRequest(
  req: IncomingMessage,
  expectedToken: string
): { ok: true } | { ok: false; status: number; error: string } {
  const host = String(req.headers.host ?? '').toLowerCase()
  if (host !== 'localhost:5173' && host !== '127.0.0.1:5173') {
    return { ok: false, status: 403, error: 'Untrusted Host header' }
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      const parsed = new URL(origin)
      const expected =
        parsed.protocol === 'http:' &&
        (parsed.host.toLowerCase() === 'localhost:5173' ||
          parsed.host.toLowerCase() === '127.0.0.1:5173')
      if (!expected) return { ok: false, status: 403, error: 'Cross-origin request rejected' }
    } catch {
      return { ok: false, status: 403, error: 'Malformed Origin header' }
    }
  }
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    return { ok: false, status: 415, error: 'Content-Type must be application/json' }
  }
  const rawToken = req.headers[DEV_AGENT_HEADER]
  const provided = typeof rawToken === 'string' ? rawToken : ''
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expectedToken, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 403, error: 'Missing or invalid dev bridge token' }
  }
  return { ok: true }
}

async function defaultLoadAgentManager(): Promise<DevAgentManagerConstructor> {
  const bridgePath = path.resolve(process.cwd(), 'pi-bridge/dist/index.js')
  const mod = (await import(pathToFileURL(bridgePath).href)) as {
    AgentManager: DevAgentManagerConstructor
  }
  return mod.AgentManager
}

export function devAgentBridge(options: DevAgentBridgeOptions = {}): Plugin {
  /** 每次 Vite dev server 启动生成的一次性令牌；防本地网页跨站 POST 滥用开发桥 */
  const devAgentToken = options.token ?? randomBytes(24).toString('hex')
  const loadAgentManager = options.loadAgentManager ?? defaultLoadAgentManager

  return {
    name: 'pi-workbench-dev-agent-bridge',
    apply: 'serve',
    config() {
      return {
        define: {
          __PI_DEV_AGENT_TOKEN__: JSON.stringify(devAgentToken),
        },
      }
    },
    configureServer(server) {
      // 每个工作区一个 Agent 实例（Web 调试也能模拟多工作区）
      const agents = new Map<string, DevAgentManager>()

      const disposeAllAgents = async (): Promise<void> => {
        for (const [key, agent] of [...agents.entries()]) {
          agents.delete(key)
          try {
            await agent.dispose()
          } catch (error) {
            console.warn('[dev-agent] dispose failed:', error)
          }
        }
      }

      // Vite dev server 重启或关闭时释放所有工作区 Agent，防止子进程或句柄泄漏
      server.httpServer?.once('close', () => {
        void disposeAllAgents()
      })

      const reply = (res: ServerResponse, body: unknown): void => {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(body))
      }

      const mountPost = (
        route: string,
        handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
      ): void => {
        const middleware: Connect.NextHandleFunction = (req, res, next) => {
          if (req.method !== 'POST') {
            next()
            return
          }
          void handler(req, res).catch((error: unknown) => {
            if (!res.writableEnded) {
              reply(res, {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          })
        }
        server.middlewares.use(route, middleware)
      }

      // 统一前置守卫：所有 /__pi/agent/* 端点必须通过同源 + JSON + 一次性令牌校验
      const authGuard: Connect.NextHandleFunction = (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }
        const check = isTrustedDevBridgeRequest(req, devAgentToken)
        if (!check.ok) {
          res.statusCode = check.status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ success: false, error: check.error }))
          return
        }
        next()
      }
      server.middlewares.use('/__pi/agent', authGuard)

      const readJson = (req: IncomingMessage): Promise<JsonObject> =>
        new Promise((resolve, reject) => {
          const chunks: Buffer[] = []
          let size = 0
          req.on('data', (chunk: Buffer | string) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            size += buf.length
            if (size > DEV_AGENT_MAX_BODY_BYTES) {
              req.destroy()
              reject(new Error('Request body too large'))
              return
            }
            chunks.push(buf)
          })
          req.on('end', () => {
            try {
              const data = Buffer.concat(chunks).toString('utf8')
              const parsed: unknown = data ? JSON.parse(data) : {}
              resolve(
                parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                  ? (parsed as JsonObject)
                  : {}
              )
            } catch (error) {
              reject(error)
            }
          })
          req.on('error', reject)
        })

      // Web 调试没有真实的目录选择器：存在的路径按工作区隔离，
      // 不存在（例如 mock 路径）时回退到项目根目录，保持纯 Web 模式可用
      const workspaceKey = (value: unknown): string => {
        if (typeof value === 'string' && value) {
          const resolved = path.resolve(value)
          if (existsSync(resolved)) return resolved
        }
        return path.resolve(process.cwd())
      }

      const agentDirFor = (workspaceDir: string): string =>
        path.resolve(
          process.cwd(),
          'cache/temp/web-agent',
          createHash('sha1').update(workspaceDir).digest('hex').slice(0, 16)
        )

      // Web 调试用的临时配置：供应商 / 模型 / Key 全部来自环境变量，
      // 凭证落在 cache/ 下，绝不碰桌面端的 config/credentials.json
      const devProviderId = (): string => process.env.PI_DEV_PROVIDER || 'deepseek'
      const devModelId = (): string => process.env.PI_DEV_MODEL || 'deepseek-flash'
      const createDevCredentialStore = (): unknown => {
        const key = process.env.PI_DEV_API_KEY || ''
        const credential = key ? { type: 'api_key', key } : undefined
        return {
          read: async (providerId: string) =>
            providerId === devProviderId() ? credential : undefined,
          list: async () => (credential ? [{ providerId: devProviderId(), type: 'api_key' }] : []),
          modify: async (_providerId: string, fn: (current: unknown) => Promise<unknown>) =>
            (await fn(credential)) ?? undefined,
          delete: async () => undefined,
        }
      }

      const sendSse = (res: ServerResponse, event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      const requireAgent = (
        workspaceDir: unknown
      ): { key: string; agent: DevAgentManager | null; error: string | null } => {
        const key = workspaceKey(workspaceDir)
        const agent = agents.get(key)
        if (!agent) return { key, agent: null, error: 'Agent not initialized for this workspace' }
        return { key, agent, error: null }
      }

      mountPost(DEV_AGENT_INIT, async (req, res) => {
        const body = await readJson(req)
        const workspaceDir = workspaceKey(body.workspaceDir)
        const AgentManager = await loadAgentManager()

        // 同一工作区重新初始化前先释放旧实例
        const existing = agents.get(workspaceDir)
        if (existing) {
          agents.delete(workspaceDir)
          try {
            await existing.dispose()
          } catch (error) {
            console.warn('[dev-agent] dispose failed:', error)
          }
        }

        const agentManager = new AgentManager()
        const result = await agentManager.initialize({
          workspaceDir,
          agentDir: agentDirFor(workspaceDir),
          // Web dev 桥没有设置页：用环境变量里的 key 建一份临时凭证，
          // 只影响本地调试，不影响桌面端的凭证文件
          apiConfig: {
            providerId: devProviderId(),
            modelId: devModelId(),
          },
          credentials: createDevCredentialStore(),
          // Web dev 桥没有审批 UI：开发环境默认全自动，仍走会话级权限模型
          getDefaultPermissionLevel: () => 'auto',
        })
        if (result.success) {
          agents.set(workspaceDir, agentManager)
        } else {
          await agentManager.dispose().catch(() => undefined)
        }
        reply(res, result)
      })

      mountPost(DEV_AGENT_CHAT, async (req, res) => {
        const body = await readJson(req)
        const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
        if (!agent) {
          reply(res, { success: false, error })
          return
        }
        const message = String(body.message ?? '')
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
        const images = Array.isArray(body.images) ? body.images : undefined
        reply(
          res,
          sessionId
            ? await agent.chat(sessionId, message, images ? { images } : undefined)
            : await agent.chat(message, images ? { images } : undefined)
        )
      })

      mountPost(DEV_AGENT_CHAT_STREAM, async (req, res) => {
        const startSse = (): void => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
        }
        const respondError = (message: string): void => {
          if (!res.headersSent) startSse()
          sendSse(res, 'done', { success: false, error: message })
          res.end()
        }

        try {
          const body = await readJson(req)
          const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
          if (!agent) {
            respondError(error ?? 'Agent not initialized')
            return
          }

          startSse()
          try {
            const message = String(body.message ?? '')
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
            const images = Array.isArray(body.images) ? body.images : undefined
            const onTrace = (event: Record<string, unknown>) => sendSse(res, 'trace', event)
            const chatOptions = images ? { onTrace, images } : { onTrace }
            const result = sessionId
              ? await agent.chat(sessionId, message, chatOptions)
              : await agent.chat(message, chatOptions)
            sendSse(res, 'done', result)
          } catch (chatError) {
            sendSse(res, 'done', {
              success: false,
              error: chatError instanceof Error ? chatError.message : String(chatError),
            })
          } finally {
            res.end()
          }
        } catch (streamError) {
          respondError(streamError instanceof Error ? streamError.message : String(streamError))
        }
      })

      mountPost(DEV_AGENT_ABORT, async (req, res) => {
        const body = await readJson(req)
        const { agent } = requireAgent(body.workspaceDir ?? process.cwd())
        if (agent) {
          if (typeof body.sessionId === 'string') await agent.abort(body.sessionId)
          else await agent.abort()
        }
        reply(res, { success: true })
      })

      mountPost(DEV_AGENT_SESSIONS_LIST, async (req, res) => {
        const body = await readJson(req)
        const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
        if (!agent) {
          reply(res, { success: false, error })
          return
        }
        const sessions = await agent.listSessions()
        reply(res, { success: true, sessions, currentId: agent.getCurrentSessionId?.() ?? null })
      })

      mountPost(DEV_AGENT_SESSIONS_OPEN, async (req, res) => {
        const body = await readJson(req)
        const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
        if (!agent) {
          reply(res, { success: false, error })
          return
        }
        reply(res, await agent.openSession(body.sessionId))
      })

      mountPost(DEV_AGENT_SESSIONS_CREATE, async (req, res) => {
        const body = await readJson(req)
        const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
        if (!agent) {
          reply(res, { success: false, error })
          return
        }
        reply(res, await agent.createSession())
      })

      mountPost(DEV_AGENT_SESSIONS_CLOSE, async (req, res) => {
        const body = await readJson(req)
        const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
        if (!agent) {
          reply(res, { success: false, error })
          return
        }
        await agent.closeSession(String(body.sessionId ?? ''))
        reply(res, { success: true })
      })

      mountPost(DEV_AGENT_SESSIONS_RENAME, async (req, res) => {
        const body = await readJson(req)
        const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
        if (!agent) {
          reply(res, { success: false, error })
          return
        }
        reply(res, await agent.renameSession(String(body.sessionId ?? ''), String(body.name ?? '')))
      })

      mountPost(DEV_AGENT_SESSIONS_DELETE, async (req, res) => {
        const body = await readJson(req)
        const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
        if (!agent) {
          reply(res, { success: false, error })
          return
        }
        reply(res, await agent.deleteSession(String(body.sessionId ?? '')))
      })

      const tabsPathFor = (workspaceDir: string): string =>
        path.join(workspaceDir, '.pi-workbench', 'chat-tabs.json')

      mountPost(DEV_AGENT_SESSIONS_TABS_GET, async (req, res) => {
        const body = await readJson(req)
        const workspaceDir = workspaceKey(body.workspaceDir ?? process.cwd())
        try {
          const raw = await readFile(tabsPathFor(workspaceDir), 'utf-8')
          const parsed = JSON.parse(raw) as { open?: string[]; active?: string | null }
          reply(res, {
            success: true,
            tabs: {
              open: Array.isArray(parsed.open) ? parsed.open : [],
              active: typeof parsed.active === 'string' ? parsed.active : null,
            },
          })
        } catch {
          reply(res, { success: true, tabs: { open: [], active: null } })
        }
      })

      mountPost(DEV_AGENT_SESSIONS_TABS_SET, async (req, res) => {
        const body = await readJson(req)
        const workspaceDir = workspaceKey(body.workspaceDir ?? process.cwd())
        const rawTabs =
          body.tabs && typeof body.tabs === 'object' && !Array.isArray(body.tabs)
            ? (body.tabs as { open?: unknown; active?: unknown })
            : {}
        await mkdir(path.dirname(tabsPathFor(workspaceDir)), { recursive: true })
        await writeFile(
          tabsPathFor(workspaceDir),
          JSON.stringify({ open: rawTabs.open ?? [], active: rawTabs.active ?? null }, null, 2),
          'utf-8'
        )
        reply(res, { success: true })
      })

      mountPost(DEV_AGENT_DISPOSE, async (req, res) => {
        const body = await readJson(req)
        const requested =
          typeof body.workspaceDir === 'string' && body.workspaceDir
            ? workspaceKey(body.workspaceDir)
            : null

        if (requested) {
          const agent = agents.get(requested)
          if (agent) {
            agents.delete(requested)
            await agent.dispose()
          }
        } else {
          // 没有指定工作区时释放全部实例
          await disposeAllAgents()
        }
        reply(res, { success: true })
      })
    },
  }
}
