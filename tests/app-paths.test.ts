import { describe, expect, it, vi } from 'vitest'
import * as path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '',
    getPath: () => '',
  },
}))

import { getBridgeEntryUrl } from '../electron/app-paths'

describe('getBridgeEntryUrl', () => {
  it('解析到仓库根目录下的 pi-bridge 构建产物', () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    const expected = pathToFileURL(path.join(repoRoot, 'pi-bridge', 'dist', 'index.js')).href
    expect(getBridgeEntryUrl()).toBe(expected)
  })

  it('不会拼出 dist-electron 内的多余层级', () => {
    expect(getBridgeEntryUrl()).not.toContain('dist-electron')
  })
})
