import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Windows 上 git 相关用例在并行跑全量时可能超过默认 5s
    testTimeout: 15000,
  },
})
