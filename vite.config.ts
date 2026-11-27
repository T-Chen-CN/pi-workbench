import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { devAgentBridge } from './scripts/vite-dev-agent-bridge'
import { fontSubsetFilter } from './scripts/vite-font-subset-filter'

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
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0]
        const match = /^\/pdfjs\/(cmaps|standard_fonts|wasm)\/([^/]+)$/.exec(pathname)
        if (!match) {
          next()
          return
        }
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
        void readFile(path.join(root, 'node_modules', 'pdfjs-dist', group, filename))
          .then((bytes) => {
            res.setHeader(
              'Content-Type',
              filename.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'
            )
            res.end(bytes)
          })
          .catch(() => {
            res.statusCode = 404
            res.end('Not Found')
          })
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
  root: 'src', // 设置根目录为 src
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
    outDir: '../dist', // 输出到上一级的 dist 目录
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
          const normalizedId = id.replace(/\\/g, '/')
          if (
            normalizedId.includes('/node_modules/react-dom/') ||
            normalizedId.includes('/node_modules/react/') ||
            normalizedId.includes('/node_modules/scheduler/')
          ) {
            return 'react-vendor'
          }
          if (normalizedId.includes('/node_modules/zustand/') || normalizedId.includes('/node_modules/lucide-react/')) {
            return 'vendor'
          }
        },
      },
    },
  },
  base: './',
})
