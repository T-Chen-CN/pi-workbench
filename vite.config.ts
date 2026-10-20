import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { pathToFileURL } from 'url'
import { existsSync } from 'fs'
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

      const workspaceKey = (value: unknown): string | null => {
        if (typeof value !== 'string' || !value) return null
        const resolved = path.resolve(value)
        return existsSync(resolved) ? resolved : null
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
        if (!key) return { key: null, agent: null, error: 'Workspace does not exist' }
        const agent = agents.get(key)
        if (!agent) return { key, agent: null, error: 'Agent not initialized for this workspace' }
        return { key, agent, error: null }
      }

      server.middlewares.use(DEV_AGENT_INIT, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const workspaceDir = workspaceKey(body.workspaceDir)
          if (!workspaceDir) {
            return reply(res, { success: false, error: 'Workspace does not exist' })
          }

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
          reply(res, await agent.chat(String(body.message ?? '')))
        } catch (error) {
          reply(res, { success: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      server.middlewares.use(DEV_AGENT_CHAT_STREAM, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        const body = await readJson(req)
        const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
        if (!agent) return reply(res, { success: false, error })

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        try {
          const result = await agent.chat(String(body.message ?? ''), {
            onTextDelta: (delta: string) => sendSse(res, 'delta', { delta }),
          })
          sendSse(res, 'done', result)
        } catch (chatError) {
          sendSse(res, 'done', {
            success: false,
            error: chatError instanceof Error ? chatError.message : String(chatError),
          })
        } finally {
          res.end()
        }
      })

      server.middlewares.use(DEV_AGENT_ABORT, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const { agent } = requireAgent(body.workspaceDir ?? process.cwd())
          if (agent) await agent.abort()
          reply(res, { success: true })
        } catch (error) {
          reply(res, { success: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      server.middlewares.use(DEV_AGENT_HISTORY, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const { agent, error } = requireAgent(body.workspaceDir ?? process.cwd())
          if (!agent) return reply(res, { success: false, error })
          const history = typeof agent.getSessionMessages === 'function'
            ? agent.getSessionMessages()
            : agent.getMessageHistory()
          reply(res, { success: true, history })
        } catch (error) {
          reply(res, { success: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      server.middlewares.use(DEV_AGENT_DISPOSE, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const workspaceDir = workspaceKey(body.workspaceDir)
          if (workspaceDir) {
            const agent = agents.get(workspaceDir)
            if (agent) {
              await agent.dispose()
              agents.delete(workspaceDir)
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

export default defineConfig({
  plugins: [react(), devModelsProxy(), devAgentBridge(), contentSecurityPolicy()],
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
          if (!id.includes('node_modules')) return
          if (id.includes('monaco-editor')) return 'monaco'
          if (
            id.includes('react-markdown') ||
            id.includes('remark-') ||
            id.includes('rehype-') ||
            id.includes('highlight.js') ||
            id.includes('lowlight') ||
            id.includes('micromark') ||
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
