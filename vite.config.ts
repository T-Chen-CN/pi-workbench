import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
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
  },
  base: './',
})
