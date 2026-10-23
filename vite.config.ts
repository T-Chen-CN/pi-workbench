import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { pathToFileURL } from 'url'
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { createHash } from 'crypto'

/**
 * 仅开发模式使用的模型列表代理。
 *
 * 浏览器里没有 Electron 主进程，无法直接请求供应商 API（且多数供应商不允许跨域），
 * 因此由 Vite dev server 代发请求，让纯 Web 调试也能真实拉取模型列表。
 * API Key 通过请求头传递，不写入 URL / 日志。
 */
const DEV_MODELS_ENDPOINT = '/__pi/fetch-models'

function devModelsProxy(): Plugin {
  return {
    name: 'pi-workbench-dev-models-proxy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(DEV_MODELS_ENDPOINT, async (req, res) => {
        const reply = (body: { success: boolean; models: string[]; error?: string }) => {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }

        try {
          const requestUrl = new URL(req.url ?? '', 'http://localhost')
          const apiUrl = (requestUrl.searchParams.get('apiUrl') ?? '').trim().replace(/\/+$/, '')
          const provider = requestUrl.searchParams.get('provider') ?? 'custom'
          const apiKey = String(req.headers['x-pi-api-key'] ?? '')

          if (!/^https?:\/\//i.test(apiUrl)) {
            return reply({ success: false, models: [], error: 'Invalid API URL' })
          }

          const headers: Record<string, string> = provider === 'anthropic'
            ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            : { Authorization: `Bearer ${apiKey}` }

          const response = await fetch(`${apiUrl}/models`, { headers })
          if (!response.ok) {
            const text = await response.text().catch(() => '')
            return reply({
              success: false,
              models: [],
              error: `HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`,
            })
          }

          const data: any = await response.json()
          const list = Array.isArray(data?.data) ? data.data
            : Array.isArray(data?.models) ? data.models
            : Array.isArray(data) ? data
            : []
          const models: string[] = list
            .map((m: any) => (typeof m === 'string' ? m : m?.id))
            .filter(Boolean)

          reply({ success: true, models })
        } catch (error) {
          reply({
            success: false,
            models: [],
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
    },
  }
}

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
const DEV_AGENT_HISTORY = '/__pi/agent/history'
const DEV_AGENT_IS_INITIALIZED = '/__pi/agent/isInitialized'
const DEV_AGENT_SESSIONS_LIST = '/__pi/agent/sessions/list'
const DEV_AGENT_SESSIONS_OPEN = '/__pi/agent/sessions/open'
const DEV_AGENT_SESSIONS_CREATE = '/__pi/agent/sessions/create'
const DEV_AGENT_SESSIONS_CLOSE = '/__pi/agent/sessions/close'
const DEV_AGENT_SESSIONS_RENAME = '/__pi/agent/sessions/rename'
const DEV_AGENT_SESSIONS_DELETE = '/__pi/agent/sessions/delete'
const DEV_AGENT_SESSIONS_TABS_GET = '/__pi/agent/sessions/tabs/get'
const DEV_AGENT_SESSIONS_TABS_SET = '/__pi/agent/sessions/tabs/set'

function devAgentBridge(): Plugin {
  return {
    name: 'pi-workbench-dev-agent-bridge',
    apply: 'serve',
    configureServer(server) {
      // 每个工作区一个 Agent 实例（Web 调试也能模拟多工作区）
      const agents = new Map<string, any>()

      const readJson = (req: any): Promise<any> =>
        new Promise((resolve, reject) => {
          let data = ''
          req.on('data', (chunk: any) => { data += chunk })
          req.on('end', () => {
            try {
              resolve(data ? JSON.parse(data) : {})
            } catch (error) {
              reject(error)
            }
          })
          req.on('error', reject)
        })

      const reply = (res: any, body: unknown) => {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(body))
      }

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

      const sendSse = (res: any, event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      const requireAgent = (workspaceDir: unknown) => {
        const key = workspaceKey(workspaceDir)
        const agent = agents.get(key)
        if (!agent) return { key, agent: null, error: 'Agent not initialized for this workspace' }
        return { key, agent, error: null }
      }

      server.middlewares.use(DEV_AGENT_INIT, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const workspaceDir = workspaceKey(body.workspaceDir)

          const bridgePath = path.resolve(process.cwd(), 'pi-bridge/dist/index.js')
          const { AgentManager } = await import(pathToFileURL(bridgePath).href)

          // 同一工作区重新初始化前先释放旧实例
          const existing = agents.get(workspaceDir)
          if (existing) {
            try {
              await existing.dispose()
            } catch (error) {
              console.warn('[dev-agent] dispose failed:', error)
            }
            agents.delete(workspaceDir)
          }

          const agentManager = new AgentManager()
          const result = await agentManager.initialize({
            workspaceDir,
            agentDir: agentDirFor(workspaceDir),
            apiConfig: body.apiConfig,
            // Web dev 桥没有审批 UI：开发环境显式允许全部工具
            getPermissionPolicy: () => ({
              read: 'allow',
              write: 'allow',
              command: 'allow',
              other: 'allow',
            }),
          })
          if (result.success) {
            agents.set(workspaceDir, agentManager)
          } else {
            await agentManager.dispose().catch(() => undefined)
          }
          reply(res, result)
        } catch (error) {
          reply(res, { success: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      server.middlewares.use(DEV_AGENT_CHAT, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
          if (!agent) return reply(res, { success: false, error })
          const message = String(body.message ?? '')
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
          reply(res, sessionId ? await agent.chat(sessionId, message) : await agent.chat(message))
        } catch (error) {
          reply(res, { success: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      server.middlewares.use(DEV_AGENT_CHAT_STREAM, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()

        const startSse = () => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
        }
        const respondError = (message: string) => {
          if (!res.headersSent) startSse()
          sendSse(res, 'done', { success: false, error: message })
          res.end()
        }

        try {
          const body = await readJson(req)
          const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
          if (!agent) return respondError(error ?? 'Agent not initialized')

          startSse()
          try {
            const message = String(body.message ?? '')
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
            const onTrace = (event: Record<string, unknown>) => sendSse(res, 'trace', event)
            const result = sessionId
              ? await agent.chat(sessionId, message, { onTrace })
              : await agent.chat(message, { onTrace })
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

      server.middlewares.use(DEV_AGENT_ABORT, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const { agent } = requireAgent(body.workspaceDir ?? process.cwd())
          if (agent) {
            if (typeof body.sessionId === 'string') await agent.abort(body.sessionId)
            else await agent.abort()
          }
          reply(res, { success: true })
        } catch (error) {
          reply(res, { success: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      server.middlewares.use(DEV_AGENT_IS_INITIALIZED, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const { agent } = requireAgent(body.workspaceDir ?? process.cwd())
          reply(res, { success: true, initialized: Boolean(agent) })
        } catch (error) {
          reply(res, { success: false, initialized: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      server.middlewares.use(DEV_AGENT_HISTORY, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
          if (!agent) return reply(res, { success: false, error })
          const history = typeof agent.getSessionMessages === 'function'
            ? agent.getSessionMessages(body.sessionId)
            : agent.getMessageHistory(body.sessionId)
          reply(res, { success: true, history })
        } catch (error) {
          reply(res, { success: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      server.middlewares.use(DEV_AGENT_SESSIONS_LIST, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
          if (!agent) return reply(res, { success: false, error })
          const sessions = await agent.listSessions()
          reply(res, { success: true, sessions, currentId: agent.getCurrentSessionId?.() ?? null })
        } catch (caught) {
          reply(res, { success: false, error: caught instanceof Error ? caught.message : String(caught) })
        }
      })

      server.middlewares.use(DEV_AGENT_SESSIONS_OPEN, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
          if (!agent) return reply(res, { success: false, error })
          reply(res, await agent.openSession(body.sessionId))
        } catch (caught) {
          reply(res, { success: false, error: caught instanceof Error ? caught.message : String(caught) })
        }
      })

      server.middlewares.use(DEV_AGENT_SESSIONS_CREATE, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
          if (!agent) return reply(res, { success: false, error })
          reply(res, await agent.createSession())
        } catch (caught) {
          reply(res, { success: false, error: caught instanceof Error ? caught.message : String(caught) })
        }
      })

      server.middlewares.use(DEV_AGENT_SESSIONS_CLOSE, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
          if (!agent) return reply(res, { success: false, error })
          await agent.closeSession(String(body.sessionId ?? ''))
          reply(res, { success: true })
        } catch (caught) {
          reply(res, { success: false, error: caught instanceof Error ? caught.message : String(caught) })
        }
      })

      server.middlewares.use(DEV_AGENT_SESSIONS_RENAME, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
          if (!agent) return reply(res, { success: false, error })
          reply(res, await agent.renameSession(String(body.sessionId ?? ''), String(body.name ?? '')))
        } catch (caught) {
          reply(res, { success: false, error: caught instanceof Error ? caught.message : String(caught) })
        }
      })

      server.middlewares.use(DEV_AGENT_SESSIONS_DELETE, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
          if (!agent) return reply(res, { success: false, error })
          reply(res, await agent.deleteSession(String(body.sessionId ?? '')))
        } catch (caught) {
          reply(res, { success: false, error: caught instanceof Error ? caught.message : String(caught) })
        }
      })

      const tabsPathFor = (workspaceDir: string): string =>
        path.join(workspaceDir, '.pi-workbench', 'chat-tabs.json')

      server.middlewares.use(DEV_AGENT_SESSIONS_TABS_GET, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
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
        } catch (caught) {
          reply(res, { success: false, error: caught instanceof Error ? caught.message : String(caught) })
        }
      })

      server.middlewares.use(DEV_AGENT_SESSIONS_TABS_SET, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const workspaceDir = workspaceKey(body.workspaceDir ?? process.cwd())
          const tabs = body.tabs ?? {}
          await mkdir(path.dirname(tabsPathFor(workspaceDir)), { recursive: true })
          await writeFile(
            tabsPathFor(workspaceDir),
            JSON.stringify({ open: tabs.open ?? [], active: tabs.active ?? null }, null, 2),
            'utf-8'
          )
          reply(res, { success: true })
        } catch (caught) {
          reply(res, { success: false, error: caught instanceof Error ? caught.message : String(caught) })
        }
      })

      server.middlewares.use(DEV_AGENT_DISPOSE, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const requested =
            typeof body.workspaceDir === 'string' && body.workspaceDir
              ? workspaceKey(body.workspaceDir)
              : null

          if (requested) {
            const agent = agents.get(requested)
            if (agent) {
              await agent.dispose()
              agents.delete(requested)
            }
          } else {
            // 没有指定工作区时释放全部实例
            for (const [key, agent] of [...agents.entries()]) {
              try {
                await agent.dispose()
              } catch (error) {
                console.warn('[dev-agent] dispose failed:', error)
              }
              agents.delete(key)
            }
          }
          reply(res, { success: true })
        } catch (error) {
          reply(res, { success: false, error: error instanceof Error ? error.message : String(error) })
        }
      })
    },
  }
}

/**
 * 仅生产构建注入 CSP。
 *
 * 开发模式需要 Vite HMR 的内联脚本和 WebSocket，因此不在 dev 下启用。
 * style 允许 inline：Monaco 会在运行时注入 <style>；
 * worker 允许 blob：Monaco 的语言 worker 通过 Blob 创建。
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' http: https:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'pi-workbench-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: CONTENT_SECURITY_POLICY,
          },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

/**
 * 只保留工作台实际使用的 Monaco 语言分词器。
 * editor.main 会注册几十种语言；把未使用的 register 模块替换为空模块，
 * 可以在不改变入口与特性装配的前提下减小 Monaco chunk。
 */
const KEEP_MONACO_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'json',
  'markdown',
  'html',
  'css',
  'python',
  'rust',
  'go',
  'ruby',
])
const EMPTY_MONACO_MODULE = '\0monaco-language-filter:empty'

function monacoLanguageFilter(): Plugin {
  return {
    name: 'monaco-language-filter',
    enforce: 'pre',
    resolveId(source) {
      const match = source.match(/\/languages\/definitions\/([^/]+)\/register(?:\.js)?$/)
      if (match && !KEEP_MONACO_LANGUAGES.has(match[1])) return EMPTY_MONACO_MODULE
      return null
    },
    load(id) {
      if (id === EMPTY_MONACO_MODULE) return 'export {}'
      return null
    },
  }
}

export default defineConfig({
  plugins: [react(), devModelsProxy(), devAgentBridge(), contentSecurityPolicy(), monacoLanguageFilter()],
  root: 'src',  // 设置根目录为 src
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  // Monaco 的 worker 入口需要由 Vite 直接处理，不能被依赖预打包
  optimizeDeps: {
    exclude: ['monaco-editor'],
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: '../dist',  // 输出到上一级的 dist 目录
    emptyOutDir: true,
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        // Monaco 体积约 3.5MB，与业务代码分开，避免主 chunk 过大
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            // Vite 的 preload helper 是虚拟模块，若落进 monaco chunk 会让入口静态依赖它
            if (id.includes('vite/preload-helper') || id.includes('vite/preload')) {
              return 'vendor'
            }
            return
          }
          if (id.includes('monaco-editor')) {
            return 'monaco'
          }
          if (
            id.includes('react-markdown') ||
            id.includes('remark-') ||
            id.includes('rehype-') ||
            id.includes('highlight.js') ||
            id.includes('lowlight') ||
            id.includes('micromark') ||
            id.includes('/marked/') ||
            id.includes('/mdast') ||
            id.includes('/hast') ||
            id.includes('/unified/') ||
            id.includes('/unist')
          ) {
            return 'markdown'
          }
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) {
            return 'react-vendor'
          }
          if (id.includes('zustand') || id.includes('lucide-react')) return 'vendor'
        },
      },
    },
  },
  base: './',
})
