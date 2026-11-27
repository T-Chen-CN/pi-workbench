import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const rootPkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as {
  version?: string
}

/** 过滤 @fontsource 中非中/英字体子集（西里尔/天城文/希腊/越南语），显著缩减公网包与内存占用 */
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
 * 云端 Web 控制台独立轻量构建（B1）：
 * 复用 `src/components/` 的流式 Markdown、思考过程、贴底滚动与设计系统组件，
 * 产出纯静态包到 `apps/cloud/web-dist/`，部署到服务器依然零构建。
 */
export default defineConfig({
  root: path.resolve(__dirname, 'apps/cloud/web-src'),
  publicDir: path.resolve(__dirname, 'apps/cloud/web-src/public'),
  base: '/',
  define: {
    __PI_CLOUD_WEB_VERSION__: JSON.stringify(rootPkg.version || '0.0.0'),
  },
  plugins: [fontSubsetFilter(), react()],
  css: {
    postcss: path.resolve(__dirname, 'postcss.config.js'),
  },
  build: {
    outDir: path.resolve(__dirname, 'apps/cloud/web-dist'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/katex') || id.includes('@streamdown/math')) {
            return 'katex'
          }
          if (
            id.includes('node_modules/@shikijs/core') ||
            id.includes('node_modules/@shikijs/engine-javascript') ||
            id.includes('node_modules/@shikijs/types') ||
            id.includes('node_modules/@shikijs/vscode-textmate')
          ) {
            return 'shiki-core'
          }
        },
      },
    },
  },
})
