/**
 * 派活账本：最近 20 条、坏文件不炸、原子写。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { appendLedger, ledgerPath, readLedger } from '../electron/dispatch/ledger'

let tmp = ''

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dispatch-ledger-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const entry = (index: number) => ({
  taskId: `task-${index}`,
  workspaceId: 'ws-1',
  workspaceLabel: 'repo',
  state: 'completed' as const,
  summary: `done ${index}`,
  sessionId: `session-${index}`,
  at: 1_700_000_000_000 + index,
})

describe('dispatch ledger', () => {
  it('returns an empty list when nothing was written', () => {
    expect(readLedger(ledgerPath(tmp))).toEqual([])
  })

  it('writes the file (with its directory) on first append', () => {
    const file = ledgerPath(tmp)
    expect(fs.existsSync(path.dirname(file))).toBe(false)
    appendLedger(file, entry(1))
    expect(fs.existsSync(file)).toBe(true)
    expect(readLedger(file)).toHaveLength(1)
  })

  it('keeps newest first and caps at 20 entries', () => {
    const file = ledgerPath(tmp)
    for (let i = 0; i < 25; i += 1) appendLedger(file, entry(i))
    const entries = readLedger(file)
    expect(entries).toHaveLength(20)
    expect(entries[0].taskId).toBe('task-24')
    expect(entries[19].taskId).toBe('task-5')
  })

  it('survives a corrupted file by starting over', () => {
    const file = ledgerPath(tmp)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'nope', 'utf-8')
    appendLedger(file, entry(7))
    expect(readLedger(file).map((item) => item.taskId)).toEqual(['task-7'])
  })

  it('ignores entries with the wrong shape', () => {
    const file = ledgerPath(tmp)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ entries: [{ taskId: 'x' }, entry(2)] }), 'utf-8')
    expect(readLedger(file).map((item) => item.taskId)).toEqual(['task-2'])
  })
})
