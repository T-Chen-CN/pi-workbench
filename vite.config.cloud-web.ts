import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fontSubsetFilter } from './scripts/vite-font-subset-filter'

const rootPkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as {
  version?: string
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
