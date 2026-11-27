import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupLegacySystemPaths,
  migrateLegacyInstallDirSync,
  migratePiAgentHome,
} from '../../electron/legacy-paths'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-legacy-'))
  tempDirs.push(dir)
  return dir
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('migrateLegacyInstallDirSync（旧便携安装目录 → 标准数据目录）', () => {
  it('copies config/data/logs/drafts without overwriting existing files, writes marker, and archives legacy folders', () => {
    const installDir = makeTempDir()
    const dataDir = makeTempDir()
    fs.mkdirSync(path.join(installDir, 'config'), { recursive: true })
    fs.mkdirSync(path.join(installDir, 'data', 'agent', 'sessions'), { recursive: true })
    fs.mkdirSync(path.join(installDir, 'data', 'profile'), { recursive: true })
    fs.mkdirSync(path.join(installDir, 'logs'), { recursive: true })
    fs.mkdirSync(path.join(installDir, 'cache', 'drafts'), { recursive: true })

    fs.writeFileSync(path.join(installDir, 'config', 'settings.json'), '{"theme":"dark"}')
    fs.writeFileSync(path.join(installDir, 'config', 'credentials.json'), '{"enc":true}')
    fs.writeFileSync(path.join(installDir, 'data', 'workspaces.db'), 'sqlite-bytes')
    fs.writeFileSync(path.join(installDir, 'data', 'agent', 'sessions', 's1.jsonl'), '{"id":"1"}')
    fs.writeFileSync(path.join(installDir, 'data', 'profile', 'SingletonLock'), 'lock')
    fs.writeFileSync(path.join(installDir, 'logs', 'main.log'), 'hello')
    fs.writeFileSync(path.join(installDir, 'cache', 'drafts', 'd1.json'), '{"content":"draft"}')

    // 目标里已有 settings.json 时绝不覆盖
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config', 'settings.json'), '{"theme":"light"}')

    const result = migrateLegacyInstallDirSync({
      installDir,
      dataDir,
      logger: silentLogger,
    })

    expect(result.needed).toBe(true)
    expect(result.migratedFiles).toBe(5)
    expect(result.skippedFiles).toBe(1)
    expect(result.archivedLegacy).toBe(true)

    expect(fs.readFileSync(path.join(dataDir, 'config', 'settings.json'), 'utf8')).toBe(
      '{"theme":"light"}'
    )
    expect(fs.readFileSync(path.join(dataDir, 'config', 'credentials.json'), 'utf8')).toBe(
      '{"enc":true}'
    )
    expect(fs.readFileSync(path.join(dataDir, 'data', 'workspaces.db'), 'utf8')).toBe('sqlite-bytes')
    expect(fs.readFileSync(path.join(dataDir, 'data', 'agent', 'sessions', 's1.jsonl'), 'utf8')).toBe(
      '{"id":"1"}'
    )
    expect(fs.readFileSync(path.join(dataDir, 'cache', 'drafts', 'd1.json'), 'utf8')).toBe(
      '{"content":"draft"}'
    )
    // Chromium 锁文件不搬运
    expect(fs.existsSync(path.join(dataDir, 'data', 'profile', 'SingletonLock'))).toBe(false)
    // 写入迁移完成标记，旧目录已归档
    expect(fs.existsSync(path.join(dataDir, 'config', '.migrated-from-install-dir'))).toBe(true)
    expect(fs.existsSync(path.join(installDir, '.legacy-data-backup', 'config', 'credentials.json'))).toBe(
      true
    )

    // 幂等：再次调用直接跳过
    const second = migrateLegacyInstallDirSync({ installDir, dataDir, logger: silentLogger })
    expect(second.needed).toBe(false)
    expect(second.reason).toBe('already-migrated')
  })

  it('skips when installDir === dataDir (portable/dev) or when no legacy data exists', () => {
    const dir = makeTempDir()
    expect(
      migrateLegacyInstallDirSync({ installDir: dir, dataDir: dir, logger: silentLogger }).reason
    ).toBe('same-directory')

    const emptyInstall = makeTempDir()
    const dataDir = makeTempDir()
    expect(
      migrateLegacyInstallDirSync({
        installDir: emptyInstall,
        dataDir,
        logger: silentLogger,
      }).reason
    ).toBe('no-legacy-data')
  })
})

describe('migratePiAgentHome', () => {
  it('migrates new files, backs up conflicts, then removes the legacy directory', () => {
    const home = makeTempDir()
    const agentDir = makeTempDir()
    const legacy = path.join(home, '.pi', 'agent')
    fs.mkdirSync(path.join(legacy, 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'auth.json'), 'legacy-auth')
    fs.writeFileSync(path.join(legacy, 'settings.json'), 'legacy-settings')
    fs.writeFileSync(path.join(legacy, 'sessions', 'a.jsonl'), 'session')
    fs.writeFileSync(path.join(agentDir, 'settings.json'), 'app-settings')

    const result = migratePiAgentHome({
      homeDir: home,
      agentDir,
      logger: silentLogger,
      isPiCliAvailable: () => false,
    })

    expect(result.found).toBe(true)
    expect(result.removed).toBe(true)
    expect(fs.existsSync(path.join(home, '.pi'))).toBe(false)
    expect(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8')).toBe('legacy-auth')
    expect(fs.readFileSync(path.join(agentDir, 'sessions', 'a.jsonl'), 'utf8')).toBe('session')
    // 应用自己的文件不被覆盖，来源备份到 legacy-home
    expect(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')).toBe('app-settings')
    expect(fs.readFileSync(path.join(agentDir, 'legacy-home', 'settings.json'), 'utf8')).toBe(
      'legacy-settings'
    )
  })

  it('leaves the legacy directory alone when a Pi CLI is present', () => {
    const home = makeTempDir()
    const agentDir = makeTempDir()
    const legacy = path.join(home, '.pi', 'agent')
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'auth.json'), 'legacy-auth')

    const result = migratePiAgentHome({
      homeDir: home,
      agentDir,
      logger: silentLogger,
      isPiCliAvailable: () => true,
    })

    expect(result.reason).toBe('pi-cli-present')
    expect(fs.existsSync(path.join(home, '.pi'))).toBe(true)
    expect(fs.existsSync(path.join(agentDir, 'auth.json'))).toBe(false)
  })

  it('does nothing when there is no legacy directory', () => {
    const result = migratePiAgentHome({
      homeDir: makeTempDir(),
      agentDir: makeTempDir(),
      logger: silentLogger,
    })
    expect(result.found).toBe(false)
  })
})

describe('cleanupLegacySystemPaths', () => {
  function makeRoots() {
    const appDir = makeTempDir()
    const appData = makeTempDir()
    const localAppData = makeTempDir()
    const cache = makeTempDir()
    const userData = path.join(appDir, 'data', 'profile')
    return { appDir, appData, localAppData, cache, userData }
  }

  it('clears legacy LOCALAPPDATA updater caches on Windows while preserving %APPDATA%\\pi-workbench', async () => {
    const roots = makeRoots()
    const standardDataDir = path.join(roots.appData, 'pi-workbench')
    const installerStore = path.join(roots.localAppData, 'pi-workbench-updater')
    const legacyUpdateCache = path.join(roots.localAppData, 'Pi-Workbench-Update')
    const legacyUpdateFlag = path.join(roots.localAppData, 'Pi-Workbench-Update.flag')
    fs.mkdirSync(standardDataDir, { recursive: true })
    fs.mkdirSync(installerStore, { recursive: true })
    fs.mkdirSync(legacyUpdateCache, { recursive: true })
    fs.writeFileSync(path.join(installerStore, 'installer.exe'), 'x')
    fs.writeFileSync(legacyUpdateFlag, 'installed')

    const removed = await cleanupLegacySystemPaths({
      appDir: roots.appDir,
      platform: 'win32',
      appDataPath: roots.appData,
      userDataPath: roots.userData,
      localAppDataPath: roots.localAppData,
      cachePath: roots.cache,
      logger: silentLogger,
      retries: 1,
      delayMs: 0,
    })

    expect(removed).toHaveLength(3)
    // 绝不误删标准数据目录（即使在便携模式下运行）
    expect(fs.existsSync(standardDataDir)).toBe(true)
    expect(fs.existsSync(installerStore)).toBe(false)
    expect(fs.existsSync(legacyUpdateCache)).toBe(false)
    expect(fs.existsSync(legacyUpdateFlag)).toBe(false)
  })

  it('keeps the macOS appData directory but clears the updater cache', async () => {
    const roots = makeRoots()
    const current = path.join(roots.appData, 'pi-workbench')
    const legacyCache = path.join(roots.cache, 'pi-workbench-updater')
    fs.mkdirSync(current, { recursive: true })
    fs.mkdirSync(legacyCache, { recursive: true })

    await cleanupLegacySystemPaths({
      appDir: roots.appDir,
      platform: 'darwin',
      appDataPath: roots.appData,
      userDataPath: current,
      cachePath: roots.cache,
      logger: silentLogger,
      retries: 1,
      delayMs: 0,
    })

    expect(fs.existsSync(current)).toBe(true)
    expect(fs.existsSync(legacyCache)).toBe(false)
  })

  it('never removes the current userData or anything inside the app directory', async () => {
    const roots = makeRoots()
    const insideUpdater = path.join(roots.appDir, 'pi-workbench-updater')
    fs.mkdirSync(insideUpdater, { recursive: true })

    const removed = await cleanupLegacySystemPaths({
      appDir: roots.appDir,
      platform: 'win32',
      appDataPath: roots.appData,
      userDataPath: roots.userData,
      localAppDataPath: roots.appDir,
      cachePath: roots.cache,
      logger: silentLogger,
      retries: 1,
      delayMs: 0,
    })

    expect(removed).toEqual([])
    expect(fs.existsSync(insideUpdater)).toBe(true)
  })
})
