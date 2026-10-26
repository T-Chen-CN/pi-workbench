import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupLegacySystemPaths, migratePiAgentHome } from '../electron/legacy-paths'

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

  it('removes the legacy userData and installer store on Windows', async () => {
    const roots = makeRoots()
    const legacyUserData = path.join(roots.appData, 'pi-workbench')
    const installerStore = path.join(roots.localAppData, 'pi-workbench-updater')
    fs.mkdirSync(legacyUserData, { recursive: true })
    fs.mkdirSync(installerStore, { recursive: true })
    fs.writeFileSync(path.join(installerStore, 'installer.exe'), 'x')

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

    expect(removed).toHaveLength(2)
    expect(fs.existsSync(legacyUserData)).toBe(false)
    expect(fs.existsSync(installerStore)).toBe(false)
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
    const fakeUserData = path.join(roots.appData, 'pi-workbench')
    fs.mkdirSync(fakeUserData, { recursive: true })

    const removed = await cleanupLegacySystemPaths({
      appDir: roots.appData,
      platform: 'win32',
      appDataPath: roots.appData,
      userDataPath: fakeUserData,
      localAppDataPath: roots.localAppData,
      cachePath: roots.cache,
      logger: silentLogger,
      retries: 1,
      delayMs: 0,
    })

    expect(removed).toEqual([])
    expect(fs.existsSync(fakeUserData)).toBe(true)
  })
})
