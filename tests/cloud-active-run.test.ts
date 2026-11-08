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
  activeRunForSession,
  clearActiveRun,
  readActiveRun,
  readActiveRuns,
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

  it('keeps one record per run so two sessions can be running at once', () => {
    writeActiveRun({ runId: 'run_a', sessionId: 's_a', startedAt: 1 })
    writeActiveRun({ runId: 'run_b', sessionId: 's_b', startedAt: 2 })
    expect(readActiveRuns().map((row) => row.runId)).toEqual(['run_a', 'run_b'])

    // 按会话找：重启后每个会话各自接回自己那一轮
    expect(activeRunForSession('s_b')?.runId).toBe('run_b')
    expect(activeRunForSession('missing')).toBeNull()

    clearActiveRun('run_a')
    expect(readActiveRuns().map((row) => row.runId)).toEqual(['run_b'])
  })

  it('reads the old single-record file and rewrites it in the new shape', () => {
    fs.mkdirSync(path.dirname(activeRunFile()), { recursive: true })
    fs.writeFileSync(
      activeRunFile(),
      JSON.stringify({ runId: 'run_old', sessionId: 's_old', startedAt: 7 })
    )
    expect(readActiveRuns().map((row) => row.runId)).toEqual(['run_old'])

    writeActiveRun({ runId: 'run_new', sessionId: 's_new', startedAt: 8 })
    const raw = JSON.parse(fs.readFileSync(activeRunFile(), 'utf-8')) as {
      runs?: Array<{ runId: string }>
    }
    expect(raw.runs?.map((row) => row.runId)).toEqual(['run_old', 'run_new'])
  })

  it('does not duplicate a run rewritten with a newer timestamp', () => {
    writeActiveRun({ runId: 'run_x', sessionId: 's_x', startedAt: 1 })
    writeActiveRun({ runId: 'run_x', sessionId: 's_x', startedAt: 2 })
    expect(readActiveRuns()).toHaveLength(1)
    expect(readActiveRuns()[0]?.startedAt).toBe(2)
  })

  it('only clears the record of the run that just finished', () => {
    writeActiveRun({ runId: 'run_3', sessionId: 's_3', startedAt: 1 })
    clearActiveRun('run_other')
    expect(readActiveRun()?.runId).toBe('run_3')
    clearActiveRun('run_3')
    expect(readActiveRun()).toBeNull()
  })
})
