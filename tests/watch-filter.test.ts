import { describe, expect, it } from 'vitest'
import { isIgnoredWatchPath } from '../electron/watch-filter'

describe('isIgnoredWatchPath', () => {
  it('ignores dependency, build and app-data directories', () => {
    const ignored = [
      'node_modules/react/index.js',
      'src/node_modules/@types/node/index.d.ts',
      '.git/config',
      '.pi-workbench/sessions/a.json',
      '.pi-worktrees/demo-abc123/src/index.ts',
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

  it('handles Windows separators', () => {
    expect(isIgnoredWatchPath('node_modules\\react\\index.js')).toBe(true)
    expect(isIgnoredWatchPath('src\\index.ts')).toBe(false)
  })
})
