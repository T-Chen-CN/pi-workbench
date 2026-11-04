import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mocks = vi.hoisted(() => {
  const state = { appDir: '' }
  return { state }
})

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => mocks.state.appDir },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import {
  applyVerdict,
  classifyToolWrite,
  isOpenWrite,
  LEDGER_MAX_ENTRIES,
  ledgerFile,
  makeWriteEntry,
  mutateLedger,
  pruneLedger,
  readLedger,
  reconcileWithHistory,
  recordCompleted,
  recordStarted,
  settleRun,
  writeLedger,
} from '../electron/cloud/ledger'
import type { CloudPendingWrite } from '../electron/cloud/types'

const entry = (id: string, overrides: Partial<CloudPendingWrite> = {}): CloudPendingWrite => ({
  id,
  runId: id.split(':')[0],
  sessionId: 's1',
  toolName: 'terminal',
  writeClass: 'external',
  summary: 'git push origin main',
  startedAt: 1_000,
  status: 'pending',
  ...overrides,
})

describe('分类表', () => {
  const classify = (summary: string, toolName = 'terminal') =>
    classifyToolWrite({ toolName, summary })

  it('flags external writes', () => {
    expect(classify('git push origin main')).toBe('external')
    expect(classify('git push -f origin main')).toBe('irreversible')
    expect(classify('curl -X POST https://api.example.com/x -d @body.json')).toBe('external')
    expect(classify('curl -s https://example.com')).toBeNull()
    expect(classify('scp ./a ubuntu@host:/tmp/')).toBe('external')
    expect(classify('npm publish --access public')).toBe('external')
    expect(classify('gh pr create --title x')).toBe('external')
  })

  it('flags system changes', () => {
    expect(classify('systemctl restart caddy')).toBe('system')
    expect(classify('apt-get install -y htop')).toBe('system')
    expect(classify('sudo -n whoami')).toBe('system')
    expect(classify('cat ~/.ssh/authorized_keys')).toBe('system')
  })

  it('flags irreversible ones, and it wins over system', () => {
    expect(classify('rm -rf /tmp/x')).toBe('irreversible')
    expect(classify('dd if=/dev/zero of=/dev/sda')).toBe('irreversible')
    expect(classify('chmod 777 /etc/passwd')).toBe('irreversible')
    // 同时命中 system 与 irreversible：取更重的
    expect(classify('sudo rm -rf /var/log')).toBe('irreversible')
  })

  it('ignores read-only commands and non-command tools', () => {
    expect(classify('ls -la')).toBeNull()
    expect(classify('git status')).toBeNull()
    // 别的工具即便参数里出现 curl 也不记账
    expect(classify('curl -X POST https://x', 'web_search')).toBeNull()
    expect(classify('')).toBeNull()
  })
})

describe('记账与结账', () => {
  it('records once and settles on completion', () => {
    let entries = recordStarted([], entry('run_1:c1'))
    entries = recordStarted(entries, entry('run_1:c1'))
    expect(entries).toHaveLength(1)

    entries = recordCompleted(entries, 'run_1', 'c1', true, 2_000)
    expect(entries[0]).toMatchObject({ status: 'done', settledAt: 2_000 })
    expect(isOpenWrite(entries[0])).toBe(false)
  })

  it('marks a failed command as failed, not done', () => {
    const entries = recordCompleted([entry('run_1:c1')], 'run_1', 'c1', false)
    expect(entries[0].status).toBe('failed')
  })

  it('leaves unrelated entries alone', () => {
    const before = [entry('run_1:c1'), entry('run_2:c2')]
    const after = recordCompleted(before, 'run_1', 'zzz', true)
    expect(after).toEqual(before)
  })

  it('turns whatever is still pending when the run ends into unknown', () => {
    const entries = settleRun([entry('run_1:c1'), entry('run_2:c2')], 'run_1', 3_000)
    expect(entries[0]).toMatchObject({ status: 'unknown', settledAt: 3_000 })
    expect(entries[1].status).toBe('pending')
  })
})

describe('历史复核', () => {
  it('infers completion from a matching tool_call_id', () => {
    const entries = reconcileWithHistory([entry('run_1:c1', { status: 'unknown' })], 's1', new Set(['c1']))
    expect(entries[0]).toMatchObject({ status: 'done', inferred: true })
  })

  it('keeps entries open when the history has no such call', () => {
    const before = [entry('run_1:c1', { status: 'unknown' })]
    expect(reconcileWithHistory(before, 's1', new Set(['other']))).toEqual(before)
  })

  it('does not touch another session', () => {
    const before = [entry('run_1:c1', { status: 'unknown', sessionId: 's2' })]
    expect(reconcileWithHistory(before, 's1', new Set(['c1']))).toEqual(before)
  })
})

describe('人工核对与剪枝', () => {
  it('records the three verdicts', () => {
    const base = [entry('run_1:c1', { status: 'unknown' })]
    expect(applyVerdict(base, 'run_1:c1', 'done')[0].status).toBe('confirmed_done')
    expect(applyVerdict(base, 'run_1:c1', 'missing')[0].status).toBe('confirmed_missing')
    expect(applyVerdict(base, 'run_1:c1', 'ignored')[0].status).toBe('ignored')
  })

  it('drops old settled rows but never open ones', () => {
    const now = 100 * 24 * 60 * 60 * 1000
    const old = { settledAt: 1 }
    const kept = pruneLedger(
      [
        entry('run_1:a', { status: 'done', ...old }),
        entry('run_1:b', { status: 'unknown', ...old }),
      ],
      now
    )
    expect(kept.map((item) => item.id)).toEqual(['run_1:b'])
  })

  it('caps the number of rows', () => {
    const many = Array.from({ length: LEDGER_MAX_ENTRIES + 10 }, (_, index) =>
      entry(`run_${index}:c`)
    )
    expect(pruneLedger(many, 1_000)).toHaveLength(LEDGER_MAX_ENTRIES)
  })
})

describe('落盘', () => {
  beforeAll(() => {
    mocks.state.appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ledger-'))
  })
  afterAll(() => {
    fs.rmSync(mocks.state.appDir, { recursive: true, force: true })
  })

  it('round-trips through atomic json', () => {
    writeLedger([entry('run_1:c1')])
    expect(readLedger()).toHaveLength(1)
    expect(fs.existsSync(ledgerFile())).toBe(true)
  })

  it('survives a corrupted file instead of crashing the view', () => {
    fs.writeFileSync(ledgerFile(), '{ not json', 'utf-8')
    expect(readLedger()).toEqual([])
  })

  it('drops rows with a broken shape', () => {
    fs.writeFileSync(
      ledgerFile(),
      JSON.stringify({
        version: 1,
        entries: [entry('run_1:c1'), { id: 1 }, { id: 'x', summary: 5 }],
      }),
      'utf-8'
    )
    expect(readLedger().map((item) => item.id)).toEqual(['run_1:c1'])
  })

  it('applies mutations through one read-modify-write', () => {
    writeLedger([entry('run_1:c1')])
    const after = mutateLedger((entries) => applyVerdict(entries, 'run_1:c1', 'done'))
    expect(after[0].status).toBe('confirmed_done')
    expect(readLedger()[0].status).toBe('confirmed_done')
  })
})

describe('makeWriteEntry', () => {
  it('keeps the id stable and truncates a long command', () => {
    const created = makeWriteEntry({
      runId: 'run_1',
      sessionId: 's1',
      toolCallId: 'c1',
      toolName: 'terminal',
      summary: 'x'.repeat(500),
      writeClass: 'external',
      now: 10,
    })
    expect(created.id).toBe('run_1:c1')
    expect(created.summary).toHaveLength(300)
    expect(created.startedAt).toBe(10)
    expect(created.status).toBe('pending')
  })
})
