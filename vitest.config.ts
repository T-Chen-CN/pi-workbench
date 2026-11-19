import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Windows 上 git 相关用例在并行跑全量时可能超过默认 5s
    testTimeout: 15000,
    // main-ipc / cloud-server 这类要拉起整个主进程依赖图的文件，并行跑全量时
    // 单个 beforeAll 的模块加载会超过默认 10s
    hookTimeout: 20000,
  },
})
