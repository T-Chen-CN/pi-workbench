import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { FileLogger, installConsoleTee } from '../../electron/logger'

let logDir: string
let logger: FileLogger | null
let restoreTee: (() => void) | null

beforeEach(async () => {
  logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-logger-test-'))
  logger = null
  restoreTee = null
})

afterEach(async () => {
  restoreTee?.()
  logger?.close()
  await fs.rm(logDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('FileLogger', () => {
  it('writes timestamped lines with a level', async () => {
    logger = new FileLogger({ logDir })
    logger.write('INFO', ['hello', { a: 1 }])
    logger.write('ERROR', [new Error('boom')])
    logger.close()

    const content = await fs.readFile(path.join(logDir, 'main.log'), 'utf-8')

    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[INFO\] hello \{"a":1\}$/m)
    expect(content).toContain('[ERROR]')
    expect(content).toContain('Error: boom')
  })

  it('appends across logger instances', async () => {
    const first = new FileLogger({ logDir })
    first.write('INFO', ['one'])
    first.close()

    const second = new FileLogger({ logDir })
    second.write('INFO', ['two'])
    second.close()

    const content = await fs.readFile(path.join(logDir, 'main.log'), 'utf-8')
    expect(content).toContain('one')
    expect(content).toContain('two')
  })

  it('rotates to a .1 backup when the size limit is exceeded', async () => {
    logger = new FileLogger({ logDir, maxBytes: 120 })
    logger.write('INFO', ['first-line-that-takes-up-space'])
    logger.write('WARN', ['second-line-pushes-over-limit'])
    logger.write('INFO', ['written-to-new-file'])
    logger.close()

    const current = await fs.readFile(path.join(logDir, 'main.log'), 'utf-8')
    const backup = await fs.readFile(path.join(logDir, 'main.log.1'), 'utf-8')

    expect(backup).toContain('first-line-that-takes-up-space')
    expect(backup).toContain('second-line-pushes-over-limit')
    expect(current).toContain('written-to-new-file')
    expect(current).not.toContain('first-line')
  })

  it('caps rotated log files to maxFiles (default 3) and removes stale higher generations', async () => {
    await fs.writeFile(path.join(logDir, 'main.log.3'), 'stale-3', 'utf-8')
    await fs.writeFile(path.join(logDir, 'main.log.4'), 'stale-4', 'utf-8')

    logger = new FileLogger({ logDir, maxBytes: 80, maxFiles: 3 })
    // 启动时已清理越界旧轮转
    await expect(fs.access(path.join(logDir, 'main.log.3'))).rejects.toThrow()
    await expect(fs.access(path.join(logDir, 'main.log.4'))).rejects.toThrow()

    for (let i = 1; i <= 6; i += 1) {
      logger.write('INFO', [`rotation-entry-${i}-${'x'.repeat(50)}`])
    }
    logger.write('INFO', ['tail'])
    logger.close()

    const files = (await fs.readdir(logDir)).sort()
    expect(files).toEqual(['main.log', 'main.log.1', 'main.log.2'])
    expect(await fs.readFile(path.join(logDir, 'main.log'), 'utf-8')).toContain('tail')
    expect(await fs.readFile(path.join(logDir, 'main.log.1'), 'utf-8')).toContain('rotation-entry-6')
    expect(await fs.readFile(path.join(logDir, 'main.log.2'), 'utf-8')).toContain('rotation-entry-5')
  })

  it('flushes in-flight async batches in order without losing lines when close() runs immediately', async () => {
    logger = new FileLogger({ logDir })
    logger.write('INFO', ['first-in-flight'])
    const flushPromise = logger.flushAsync()
    logger.write('INFO', ['second-pending'])
    logger.close()
    await flushPromise

    const content = await fs.readFile(path.join(logDir, 'main.log'), 'utf-8')
    const firstIdx = content.indexOf('first-in-flight')
    const secondIdx = content.indexOf('second-pending')
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(secondIdx).toBeGreaterThan(firstIdx)
    // 同一行不能被异步链与同步 close 重复写两次
    expect(content.match(/first-in-flight/g)).toHaveLength(1)
  })
})

describe('installConsoleTee', () => {
  it('mirrors console output into the log file and restores console', async () => {
    logger = new FileLogger({ logDir })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    restoreTee = installConsoleTee(logger)
    console.log('hello from console')
    console.error('something failed')
    restoreTee()
    restoreTee = null
    logger.close()

    const content = await fs.readFile(path.join(logDir, 'main.log'), 'utf-8')
    expect(content).toContain('[INFO] hello from console')
    expect(content).toContain('[ERROR] something failed')
    expect(logSpy).toHaveBeenCalledWith('hello from console')
    expect(errorSpy).toHaveBeenCalledWith('something failed')
  })
})
