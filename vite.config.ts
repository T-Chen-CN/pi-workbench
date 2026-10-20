import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { pathToFileURL } from 'url'
import { existsSync } from 'fs'

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
const DEV_AGENT_DISPOSE = '/__pi/agent/dispose'
const DEV_AGENT_HISTORY = '/__pi/agent/history'

function devAgentBridge(): Plugin {
  return {
    name: 'pi-workbench-dev-agent-bridge',
    apply: 'serve',
    configureServer(server) {
      let agentManager: any = null

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

      server.middlewares.use(DEV_AGENT_INIT, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          const body = await readJson(req)
          const bridgePath = path.resolve(process.cwd(), 'pi-bridge/dist/index.js')
          const { AgentManager } = await import(pathToFileURL(bridgePath).href)

          // 重新初始化前先释放旧实例
          if (agentManager) {
            try {
              await agentManager.dispose()
            } catch (error) {
              console.warn('[dev-agent] dispose failed:', error)
            }
            agentManager = null
          }

          agentManager = new AgentManager()
          // Web 模式没有目录选择器：优先使用存在的路径，否则退回项目根目录
          const workspaceDir =
            body.workspaceDir && existsSync(body.workspaceDir) ? body.workspaceDir : process.cwd()
          const agentDir = path.resolve(process.cwd(), 'cache/temp/web-agent')

          const result = await agentManager.initialize({
            workspaceDir,
            agentDir,
            apiConfig: body.apiConfig,
          })
          reply(res, result)
        } catch (error) {
          reply(res, { success: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      server.middlewares.use(DEV_AGENT_CHAT, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          if (!agentManager) {
            return reply(res, { success: false, error: 'Agent not initialized' })
          }
          const body = await readJson(req)
          reply(res, await agentManager.chat(String(body.message ?? '')))
        } catch (error) {
          reply(res, { success: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      server.middlewares.use(DEV_AGENT_HISTORY, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          if (!agentManager) {
            return reply(res, { success: false, error: 'Agent not initialized' })
          }
          const history = typeof agentManager.getSessionMessages === 'function'
            ? agentManager.getSessionMessages()
            : agentManager.getMessageHistory()
          reply(res, { success: true, history })
        } catch (error) {
          reply(res, { success: false, error: error instanceof Error ? error.message : String(error) })
        }
      })

      server.middlewares.use(DEV_AGENT_DISPOSE, async (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        try {
          if (agentManager) {
            await agentManager.dispose()
            agentManager = null
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
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) {
            return 'react-vendor'
          }
          if (id.includes('zustand')) return 'vendor'
        },
      },
    },
  },
  base: './',
})
