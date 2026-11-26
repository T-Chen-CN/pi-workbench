import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

/**
 * 云端 Web 控制台独立轻量构建（B1）：
 * 复用 `src/components/` 的流式 Markdown、思考过程、贴底滚动与设计系统组件，
 * 产出纯静态包到 `apps/cloud/web-dist/`，部署到服务器依然零构建。
 */
export default defineConfig({
  root: path.resolve(__dirname, 'apps/cloud/web-src'),
  publicDir: path.resolve(__dirname, 'apps/cloud/web-src/public'),
  base: '/',
  plugins: [react()],
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
          if (id.includes('node_modules/mermaid') || id.includes('@streamdown/mermaid')) {
            return 'mermaid'
          }
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
