import { describe, expect, it } from 'vitest'
import { isIgnoredWatchPath } from '../electron/watch-filter'

describe('isIgnoredWatchPath', () => {
  it('ignores dependency, build and app-data directories', () => {
    const ignored = [
      'node_modules/react/index.js',
      'src/node_modules/@types/node/index.d.ts',
      '.git/config',
      '.pi-workbench/sessions/a.json',
      '.pi-workbench/plugins/git/index.js',
      '.pi-workbench/drafts/a.txt',
      '.pi-worktrees/demo-abc123/.pi-workbench/settings.json',
      'dist/assets/index.js',
      'dist-electron/main.js',
      'release/Pi Workbench.exe',
      'cache/temp/file.txt',
    ]

    for (const path of ignored) {
      expect(isIgnoredWatchPath(path), path).toBe(true)
    }
  })

  it('accepts normal source files', () => {
    const accepted = [
      'src/index.ts',
      'docs/readme.md',
      'src/cacheUtils.ts',
      'src/distance.ts',
      'src/.pi-worktreesBackup/file.ts',
      'package.json',
    ]

    for (const path of accepted) {
      expect(isIgnoredWatchPath(path), path).toBe(false)
    }
  })

  // 会话绑定工作树后，源码就在 .pi-workbench/worktrees 下：不放行的话 Agent 改完文件编辑器不刷新
  it('accepts source files inside bound worktrees', () => {
    const accepted = [
      '.pi-workbench/worktrees/01a18458/src/index.ts',
      '.pi-workbench/worktrees/01a18458/package.json',
      '.pi-worktrees/demo-abc123/src/main.ts'
    ]

    for (const path of accepted) {
      expect(isIgnoredWatchPath(path), path).toBe(false)
    }
  })

  it('still ignores build output inside worktrees', () => {
    expect(isIgnoredWatchPath('.pi-workbench/worktrees/01a18458/node_modules/x/index.js')).toBe(true)
    expect(isIgnoredWatchPath('.pi-workbench/worktrees/01a18458/dist/main.js')).toBe(true)
    expect(isIgnoredWatchPath('.pi-workbench/worktrees/01a18458/.git/HEAD')).toBe(true)
  })

  it('handles Windows separators', () => {
    expect(isIgnoredWatchPath('node_modules\\react\\index.js')).toBe(true)
    expect(isIgnoredWatchPath('src\\index.ts')).toBe(false)
    expect(isIgnoredWatchPath('.pi-workbench\\worktrees\\01a18458\\src\\index.ts')).toBe(false)
  })
})
