import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const dirs = vi.hoisted(() => ({ appDir: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => dirs.appDir,
    getPath: () => dirs.appDir,
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (buffer: Buffer) => Buffer.from(buffer).toString('utf-8').slice(4),
  },
}))

dirs.appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cloud-active-run-'))

import {
  activeRunFile,
  clearActiveRun,
  readActiveRun,
  writeActiveRun,
} from '../electron/cloud/active-run'

afterAll(() => {
  fs.rmSync(dirs.appDir, { recursive: true, force: true })
})

describe('active-run 记录', () => {
  beforeEach(() => {
    clearActiveRun()
  })

  it('round-trips the run that was last started', () => {
    expect(readActiveRun()).toBeNull()
    writeActiveRun({ runId: 'run_1', sessionId: 's_1', startedAt: 1_700_000_000_000 })
    expect(readActiveRun()).toEqual({
      runId: 'run_1',
      sessionId: 's_1',
      startedAt: 1_700_000_000_000,
    })
  })

  it('treats a missing session id as unknown rather than an empty string', () => {
    writeActiveRun({ runId: 'run_2', sessionId: null, startedAt: 1 })
    expect(readActiveRun()?.sessionId).toBeNull()
  })

  it('ignores a corrupt or empty record instead of throwing', () => {
    fs.mkdirSync(path.dirname(activeRunFile()), { recursive: true })
    fs.writeFileSync(activeRunFile(), '{ not json')
    expect(readActiveRun()).toBeNull()
    fs.writeFileSync(activeRunFile(), JSON.stringify({ sessionId: 's_1' }))
    expect(readActiveRun()).toBeNull()
  })

  it('only clears the record of the run that just finished', () => {
    writeActiveRun({ runId: 'run_3', sessionId: 's_3', startedAt: 1 })
    clearActiveRun('run_other')
    expect(readActiveRun()?.runId).toBe('run_3')
    clearActiveRun('run_3')
    expect(readActiveRun()).toBeNull()
  })
})
