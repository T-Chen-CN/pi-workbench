import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  cleanupInstalledUpdaterCache,
  cleanupTempCache,
  pruneOrphanDrafts,
  rotateTerminalLogs,
  runStartupCacheMaintenance,
} from '../../electron/cache-maintenance'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 28, 12, 0, 0)

let rootDir: string

async function writeAgedFile(filePath: string, content: string | Buffer, ageMs: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
  const ts = (NOW - ageMs) / 1000
  await fs.utimes(filePath, ts, ts)
}

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cache-maint-'))
})

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true })
})

describe('cleanupInstalledUpdaterCache', () => {
  it('removes pending/ and clears flag when updater flag exists while keeping differential base', async () => {
    const updaterDir = path.join(rootDir, 'cache', 'pi-workbench-updater')
    const pendingFile = path.join(updaterDir, 'pending', 'Setup.exe')
    const installer = path.join(updaterDir, 'installer.exe')
    const blockmap = path.join(updaterDir, 'current.blockmap')
    const flag = path.join(rootDir, 'cache', 'pi-workbench-updater.flag')

    await writeAgedFile(pendingFile, 'pending-installer', 1000)
    await writeAgedFile(installer, 'base-exe', 1000)
    await writeAgedFile(blockmap, 'base-map', 1000)
    await writeAgedFile(flag, 'installed', 1000)

    const result = await cleanupInstalledUpdaterCache(rootDir, { now: NOW })

    expect(result.removedPending).toBe(true)
    expect(result.clearedFlag).toBe(true)
    expect(result.removedFiles).toBe(1)
    expect(result.freedBytes).toBeGreaterThan(0)
    await expect(fs.access(path.join(updaterDir, 'pending'))).rejects.toThrow()
    await expect(fs.access(flag)).rejects.toThrow()
    await expect(fs.access(installer)).resolves.toBeUndefined()
    await expect(fs.access(blockmap)).resolves.toBeUndefined()
  })

  it('prunes stale pending downloads older than 7 days while keeping fresh ones', async () => {
    const pendingDir = path.join(rootDir, 'cache', 'pi-workbench-updater', 'pending')
    const oldFile = path.join(pendingDir, 'old-setup.exe')
    const freshFile = path.join(pendingDir, 'fresh-setup.exe')

    await writeAgedFile(oldFile, 'stale-payload', 8 * DAY_MS)
    await writeAgedFile(freshFile, 'fresh-payload', 2 * DAY_MS)

    const partial = await cleanupInstalledUpdaterCache(rootDir, { now: NOW })
    expect(partial.removedFiles).toBe(1)
    expect(partial.removedPending).toBe(false)
    await expect(fs.access(oldFile)).rejects.toThrow()
    await expect(fs.access(freshFile)).resolves.toBeUndefined()

    // 全部超期后，pending 目录本身一并回收
    const staleTs = (NOW - 10 * DAY_MS) / 1000
    await fs.utimes(freshFile, staleTs, staleTs)
    const full = await cleanupInstalledUpdaterCache(rootDir, { now: NOW })
    expect(full.removedFiles).toBe(1)
    expect(full.removedPending).toBe(true)
    await expect(fs.access(pendingDir)).rejects.toThrow()
  })
})

describe('cleanupTempCache', () => {
  it('deletes expired temp files older than 7 days and enforces maxTotalBytes oldest-first', async () => {
    const tempDir = path.join(rootDir, 'cache', 'temp')
    const expired = path.join(tempDir, 'tool-result-expired.txt')
    const nestedExpired = path.join(tempDir, 'sub', 'old.txt')
    const oldest = path.join(tempDir, 'tool-result-1.txt')
    const middle = path.join(tempDir, 'tool-result-2.txt')
    const newest = path.join(tempDir, 'tool-result-3.txt')

    await writeAgedFile(expired, 'x'.repeat(50), 9 * DAY_MS)
    await writeAgedFile(nestedExpired, 'y'.repeat(50), 10 * DAY_MS)
    await writeAgedFile(oldest, 'a'.repeat(60), 4 * DAY_MS)
    await writeAgedFile(middle, 'b'.repeat(60), 2 * DAY_MS)
    await writeAgedFile(newest, 'c'.repeat(60), 1 * DAY_MS)

    const result = await cleanupTempCache(rootDir, {
      maxAgeMs: 7 * DAY_MS,
      maxTotalBytes: 120,
      now: NOW,
    })

    // 2 个超期文件 + 1 个超出 120 字节预算的最旧文件被删除
    expect(result.removedFiles).toBe(3)
    expect(result.freedBytes).toBe(160)
    await expect(fs.access(expired)).rejects.toThrow()
    await expect(fs.access(path.join(tempDir, 'sub'))).rejects.toThrow()
    await expect(fs.access(oldest)).rejects.toThrow()
    await expect(fs.access(middle)).resolves.toBeUndefined()
    await expect(fs.access(newest)).resolves.toBeUndefined()
  })
})

describe('pruneOrphanDrafts', () => {
  it('removes drafts older than 30 days and keeps recent drafts', async () => {
    const draftsDir = path.join(rootDir, 'cache', 'drafts')
    const staleDraft = path.join(draftsDir, 'stale.json')
    const staleBak = path.join(draftsDir, 'stale.json.bak')
    const staleTmp = path.join(draftsDir, '.stale.123.tmp')
    const freshDraft = path.join(draftsDir, 'fresh.json')

    await writeAgedFile(staleDraft, '{"content":"old"}', 31 * DAY_MS)
    await writeAgedFile(staleBak, '{"content":"old-bak"}', 45 * DAY_MS)
    await writeAgedFile(staleTmp, '{"content":"tmp"}', 32 * DAY_MS)
    await writeAgedFile(freshDraft, '{"content":"keep"}', 5 * DAY_MS)

    const result = await pruneOrphanDrafts(rootDir, { now: NOW })

    expect(result.removedFiles).toBe(3)
    await expect(fs.access(staleDraft)).rejects.toThrow()
    await expect(fs.access(staleBak)).rejects.toThrow()
    await expect(fs.access(staleTmp)).rejects.toThrow()
    await expect(fs.access(freshDraft)).resolves.toBeUndefined()
  })
})

describe('rotateTerminalLogs', () => {
  it('rotates oversized terminal logs and prunes rotated backups beyond keep', async () => {
    const metaDir = path.join(rootDir, '.pi-workbench')
    await fs.mkdir(metaDir, { recursive: true })
    const logPath = path.join(metaDir, 'terminal-term-1.log')
    await fs.writeFile(logPath, 'A'.repeat(200), 'utf-8')
    await fs.writeFile(`${logPath}.1`, 'prev-1', 'utf-8')
    await fs.writeFile(`${logPath}.2`, 'prev-2', 'utf-8')
    await fs.writeFile(`${logPath}.3`, 'prev-3', 'utf-8')
    await fs.writeFile(`${logPath}.4`, 'prev-4-excess', 'utf-8')
    await fs.writeFile(`${logPath}.5`, 'prev-5-excess', 'utf-8')

    const result = await rotateTerminalLogs(rootDir, { maxBytes: 100, keep: 3 })

    expect(result.rotated).toBe(1)
    expect(await fs.readFile(`${logPath}.1`, 'utf-8')).toBe('A'.repeat(200))
    expect(await fs.readFile(`${logPath}.2`, 'utf-8')).toBe('prev-1')
    expect(await fs.readFile(`${logPath}.3`, 'utf-8')).toBe('prev-2')
    await expect(fs.access(logPath)).rejects.toThrow()
    await expect(fs.access(`${logPath}.4`)).rejects.toThrow()
    await expect(fs.access(`${logPath}.5`)).rejects.toThrow()
  })

  it('prunes orphan rotated logs beyond keep even when base log is small', async () => {
    const metaDir = path.join(rootDir, '.pi-workbench')
    await fs.mkdir(metaDir, { recursive: true })
    const logPath = path.join(metaDir, 'terminal-term-2.log')
    await fs.writeFile(logPath, 'small', 'utf-8')
    await fs.writeFile(`${logPath}.1`, 'b1', 'utf-8')
    await fs.writeFile(`${logPath}.4`, 'b4', 'utf-8')

    const result = await rotateTerminalLogs(rootDir, { maxBytes: 1024, keep: 3 })
    expect(result.rotated).toBe(0)
    expect(result.pruned).toBe(1)
    await expect(fs.access(`${logPath}.1`)).resolves.toBeUndefined()
    await expect(fs.access(`${logPath}.4`)).rejects.toThrow()
  })
})

describe('runStartupCacheMaintenance', () => {
  it('runs all cleanup phases asynchronously and summarizes results', async () => {
    await writeAgedFile(
      path.join(rootDir, 'cache', 'pi-workbench-updater', 'pending', 'old.exe'),
      'old-exe',
      10 * DAY_MS
    )
    await writeAgedFile(path.join(rootDir, 'cache', 'temp', 'tool-result-1.txt'), 'temp', 10 * DAY_MS)
    await writeAgedFile(path.join(rootDir, 'cache', 'drafts', 'orphan.json'), '{}', 40 * DAY_MS)

    const logger = { log: vi.fn(), warn: vi.fn() }
    const summary = await runStartupCacheMaintenance(rootDir, { logger, now: NOW })

    expect(summary.updater.removedFiles).toBe(1)
    expect(summary.temp.removedFiles).toBe(1)
    expect(summary.drafts.removedFiles).toBe(1)
    expect(logger.log).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
