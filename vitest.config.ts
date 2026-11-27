import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^pi-bridge\/protocol$/, replacement: path.resolve(rootDir, 'pi-bridge/src/protocol.ts') },
      { find: /^pi-bridge\/presets$/, replacement: path.resolve(rootDir, 'pi-bridge/src/presets.ts') },
      { find: /^pi-bridge\/images$/, replacement: path.resolve(rootDir, 'pi-bridge/src/images.ts') },
      { find: /^pi-bridge\/mcp$/, replacement: path.resolve(rootDir, 'pi-bridge/src/mcp.ts') },
      { find: /^pi-bridge\/atomic-json$/, replacement: path.resolve(rootDir, 'pi-bridge/src/atomic-json.ts') },
      { find: /^pi-bridge$/, replacement: path.resolve(rootDir, 'pi-bridge/src/index.ts') },
    ],
  },
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
