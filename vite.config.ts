import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { pathToFileURL } from 'url'
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'


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

/** 每次 Vite dev server 启动生成的一次性令牌；防本地网页跨站 POST 滥用开发桥 */
const DEV_AGENT_TOKEN = randomBytes(24).toString('hex')
const DEV_AGENT_HEADER = 'x-pi-dev-token'
const DEV_AGENT_MAX_BODY_BYTES = 16 * 1024 * 1024

function isTrustedDevBridgeRequest(req: any): { ok: true } | { ok: false; status: number; error: string } {
  const host = String(req.headers?.host ?? '').toLowerCase()
  if (host !== 'localhost:5173' && host !== '127.0.0.1:5173') {
    return { ok: false, status: 403, error: 'Untrusted Host header' }
  }
  const origin = req.headers?.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      const parsed = new URL(origin)
      const expected = parsed.protocol === 'http:' && (parsed.host.toLowerCase() === 'localhost:5173' || parsed.host.toLowerCase() === '127.0.0.1:5173')
      if (!expected) return { ok: false, status: 403, error: 'Cross-origin request rejected' }
    } catch {
      return { ok: false, status: 403, error: 'Malformed Origin header' }
    }
  }
  const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    return { ok: false, status: 415, error: 'Content-Type must be application/json' }
  }
  const rawToken = req.headers?.[DEV_AGENT_HEADER]
  const provided = typeof rawToken === 'string' ? rawToken : ''
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(DEV_AGENT_TOKEN, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 403, error: 'Missing or invalid dev bridge token' }
  }
  return { ok: true }
}

function devAgentBridge(): Plugin {
  return {
    name: 'pi-workbench-dev-agent-bridge',
    apply: 'serve',
    config() {
      return {
        define: {
          __PI_DEV_AGENT_TOKEN__: JSON.stringify(DEV_AGENT_TOKEN),
        },
      }
    },
    configureServer(server) {
      // 每个工作区一个 Agent 实例（Web 调试也能模拟多工作区）
      const agents = new Map<string, any>()

      // 统一前置守卫：所有 /__pi/agent/* 端点必须通过同源 + JSON + 一次性令牌校验
      server.middlewares.use('/__pi/agent', (req: any, res: any, next: any) => {
        if (req.method !== 'POST') return next()
        const check = isTrustedDevBridgeRequest(req)
        if (!check.ok) {
          res.statusCode = check.status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ success: false, error: check.error }))
          return
        }
        next()
      })

      const readJson = (req: any): Promise<any> =>
        new Promise((resolve, reject) => {
          const chunks: Buffer[] = []
          let size = 0
          req.on('data', (chunk: any) => {
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
          const images = Array.isArray(body.images) ? body.images : undefined
          reply(
            res,
            sessionId
              ? await agent.chat(sessionId, message, images ? { images } : undefined)
              : await agent.chat(message, images ? { images } : undefined)
          )
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
 * worker 允许 blob：Monaco 的语言 worker 通过 Blob 创建；
 * pw-file: 是主进程注册的只读文件协议，图片 / 音视频 / PDF / HTML 预览都走它。
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: pw-file:",
  "media-src 'self' pw-file:",
  "frame-src 'self' pw-file:",
  "worker-src 'self' blob:",
  // pdf.js 通过 XHR 从只读协议取 PDF 字节（协议只允许 GET/HEAD 且限定在受信任根内）
  "connect-src 'self' pw-file:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ')

export function contentSecurityPolicy(): Plugin {
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
 * 保留工作台常用开发语言的 Monaco 分词器（覆盖前端 / 后端 / 脚本 / 配置 / 容器）。
 * 其余冷门语言 register 模块替换为空模块，在完整支持主流开发语言的同时控制 Monaco chunk 体积。
 */
const KEEP_MONACO_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'json',
  'markdown',
  'html',
  'css',
  'scss',
  'less',
  'python',
  'rust',
  'go',
  'ruby',
  'yaml',
  'shell',
  'sql',
  'dockerfile',
  'cpp',
  'java',
  'powershell',
  'xml',
  'php',
  'csharp',
  'swift',
  'kotlin',
  'ini',
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

/** 过滤 @fontsource 中非中/英字体子集（西里尔/天城文/希腊/越南语），减少桌面产物冗余字体 */
const DROP_FONT_SUBSETS = /(?:cyrillic|devanagari|greek|vietnamese)/i

function fontSubsetFilter(): Plugin {
  return {
    name: 'pi-workbench-font-subset-filter',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@fontsource') || !id.endsWith('.css')) return null
      const filtered = code.replace(
        /(?:\/\*[^*]*\*\/\s*)?@font-face\s*\{[^}]*\}\s*/g,
        (block) => (DROP_FONT_SUBSETS.test(block) ? '' : block)
      )
      return filtered === code ? null : { code: filtered, map: null }
    },
  }
}

/**
 * pdf.js 的 CMap / 标准字体 / wasm 解码器以原始二进制静态文件随包分发（`dist/pdfjs/<group>/<file>`）。
 * 生产环境运行在 `pw-app://bundle`，开发态由 Vite dev middleware 直出，避免 Base64 33% 膨胀与 JS 解析开销。
 */
const PDFJS_ASSET_GROUPS = {
  cmaps: ['.bcmap'],
  standard_fonts: ['.pfb', '.ttf'],
  wasm: ['.wasm'],
} as const

/** 只读 PDF 预览不需要 XFA 表单脚本引擎（quickjs-eval.wasm ~469 KB），构建与开发态均排除 */
const EXCLUDED_PDFJS_WASM = new Set(['quickjs-eval.wasm'])

type PdfjsAssetGroup = keyof typeof PDFJS_ASSET_GROUPS

export function pdfjsAssets(): Plugin {
  const root = process.cwd()

  return {
    name: 'pi-workbench-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0]
        const match = /^\/pdfjs\/(cmaps|standard_fonts|wasm)\/([^/]+)$/.exec(pathname)
        if (!match) return next()
        const group = match[1] as PdfjsAssetGroup
        let filename: string
        try {
          filename = decodeURIComponent(match[2])
        } catch {
          res.statusCode = 400
          res.end('Bad Request')
          return
        }
        if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
          res.statusCode = 400
          res.end('Bad Request')
          return
        }
        const suffixes = PDFJS_ASSET_GROUPS[group]
        if (
          !(suffixes as readonly string[]).some((suffix) => filename.endsWith(suffix)) ||
          (group === 'wasm' && EXCLUDED_PDFJS_WASM.has(filename))
        ) {
          res.statusCode = 404
          res.end('Not Found')
          return
        }
        try {
          const bytes = await readFile(path.join(root, 'node_modules', 'pdfjs-dist', group, filename))
          res.setHeader(
            'Content-Type',
            filename.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'
          )
          res.end(bytes)
        } catch {
          res.statusCode = 404
          res.end('Not Found')
        }
      })
    },
    async generateBundle() {
      for (const [group, suffixes] of Object.entries(PDFJS_ASSET_GROUPS) as Array<
        [PdfjsAssetGroup, readonly string[]]
      >) {
        const dir = path.join(root, 'node_modules', 'pdfjs-dist', group)
        const files = (await readdir(dir)).filter(
          (name) =>
            suffixes.some((suffix) => name.endsWith(suffix)) &&
            !(group === 'wasm' && EXCLUDED_PDFJS_WASM.has(name))
        )
        for (const name of files) {
          const source = await readFile(path.join(dir, name))
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${group}/${name}`,
            source,
          })
        }
      }
    },
  }
}

/**
 * web-tree-sitter 运行时与 9 种主流语言语法 WASM 以原始二进制随包分发（`dist/tree-sitter/<file>`）。
 * 开发态由 Vite dev middleware 按需直出，生产环境经 `pw-app://bundle/tree-sitter/...` 读取。
 */
const TREE_SITTER_CORE_WASM = 'tree-sitter.wasm'
const TREE_SITTER_GRAMMAR_WASMS = [
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-go.wasm',
  'tree-sitter-rust.wasm',
  'tree-sitter-java.wasm',
  'tree-sitter-cpp.wasm',
  'tree-sitter-c.wasm',
] as const
const TREE_SITTER_GRAMMAR_SET = new Set<string>(TREE_SITTER_GRAMMAR_WASMS)

export function treeSitterAssets(): Plugin {
  const root = process.cwd()

  return {
    name: 'pi-workbench-tree-sitter-assets',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0]
        const match = /^\/tree-sitter\/([^/]+)$/.exec(pathname)
        if (!match) return next()
        let filename: string
        try {
          filename = decodeURIComponent(match[1])
        } catch {
          res.statusCode = 400
          res.end('Bad Request')
          return
        }
        if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
          res.statusCode = 400
          res.end('Bad Request')
          return
        }
        let targetPath: string | null = null
        if (filename === TREE_SITTER_CORE_WASM) {
          targetPath = path.join(root, 'node_modules', 'web-tree-sitter', TREE_SITTER_CORE_WASM)
        } else if (TREE_SITTER_GRAMMAR_SET.has(filename)) {
          targetPath = path.join(root, 'node_modules', 'tree-sitter-wasms', 'out', filename)
        }
        if (!targetPath) {
          res.statusCode = 404
          res.end('Not Found')
          return
        }
        try {
          const bytes = await readFile(targetPath)
          res.setHeader('Content-Type', 'application/wasm')
          res.end(bytes)
        } catch {
          res.statusCode = 404
          res.end('Not Found')
        }
      })
    },
    async generateBundle() {
      const coreSource = await readFile(
        path.join(root, 'node_modules', 'web-tree-sitter', TREE_SITTER_CORE_WASM)
      )
      this.emitFile({
        type: 'asset',
        fileName: `tree-sitter/${TREE_SITTER_CORE_WASM}`,
        source: coreSource,
      })
      for (const name of TREE_SITTER_GRAMMAR_WASMS) {
        const source = await readFile(
          path.join(root, 'node_modules', 'tree-sitter-wasms', 'out', name)
        )
        this.emitFile({
          type: 'asset',
          fileName: `tree-sitter/${name}`,
          source,
        })
      }
    },
  }
}

export default defineConfig({
  plugins: [
    fontSubsetFilter(),
    react(),
    pdfjsAssets(),
    treeSitterAssets(),
    devAgentBridge(),
    contentSecurityPolicy(),
    monacoLanguageFilter(),
  ],
  root: 'src',  // 设置根目录为 src
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
        // Monaco / Mermaid 等重型引擎独立分包，按需懒加载，避免主 chunk 过大
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
          // KaTeX 与 @streamdown/math 独立分包，避免在 markdown 与 mermaid chunk 中重复打包
          if (
            id.includes('node_modules/katex') ||
            id.includes('@streamdown/math') ||
            id.includes('rehype-katex') ||
            id.includes('remark-math')
          ) {
            return 'katex'
          }
          if (id.includes('node_modules/mermaid') || id.includes('@streamdown/mermaid')) {
            return 'mermaid'
          }
          if (
            id.includes('remark-') ||
            id.includes('rehype-') ||
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
