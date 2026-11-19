import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CLOUD_AGENT_REMOVED, runLegacyCleanups } from '../electron/legacy-cleanup'

let appDir: string
const silent = { info: vi.fn(), warn: vi.fn() }

/** 造出 0.9.x 用户盘上会有的那套残留 */
function seedLeftovers() {
  fs.mkdirSync(path.join(appDir, 'data', 'cloud-agent'), { recursive: true })
  fs.writeFileSync(path.join(appDir, 'data', 'cloud-agent', 'connection.json'), '{}')
  fs.writeFileSync(path.join(appDir, 'data', 'cloud-agent', 'audit.jsonl'), '')
  fs.mkdirSync(path.join(appDir, 'data', 'agent'), { recursive: true })
  fs.writeFileSync(path.join(appDir, 'data', 'agent', 'dispatch.json'), '{}')
  fs.writeFileSync(path.join(appDir, 'data', 'agent', 'dispatch-ledger.json'), '[]')
  fs.mkdirSync(path.join(appDir, 'cache', 'dispatch-traces'), { recursive: true })
  fs.writeFileSync(path.join(appDir, 'cache', 'dispatch-traces', 't1.json'), '{}')
}

const markerPath = () => path.join(appDir, 'config', 'migrations.json')

beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-legacy-cleanup-'))
  fs.mkdirSync(path.join(appDir, 'config'), { recursive: true })
  silent.info.mockClear()
  silent.warn.mockClear()
})

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true })
})

describe('legacy cleanup: cloud-agent-removed', () => {
  it('deletes every leftover path and writes the marker', () => {
    seedLeftovers()

    const executed = runLegacyCleanups(appDir, silent)

    expect(executed).toEqual([CLOUD_AGENT_REMOVED])
    expect(fs.existsSync(path.join(appDir, 'data', 'cloud-agent'))).toBe(false)
    expect(fs.existsSync(path.join(appDir, 'data', 'agent', 'dispatch.json'))).toBe(false)
    expect(fs.existsSync(path.join(appDir, 'data', 'agent', 'dispatch-ledger.json'))).toBe(false)
    expect(fs.existsSync(path.join(appDir, 'cache', 'dispatch-traces'))).toBe(false)

    const state = JSON.parse(fs.readFileSync(markerPath(), 'utf-8'))
    expect(typeof state.applied[CLOUD_AGENT_REMOVED]).toBe('number')
  })

  it('keeps unrelated data files untouched', () => {
    seedLeftovers()
    fs.writeFileSync(path.join(appDir, 'data', 'agent', 'models.json'), '{"keep":true}')
    fs.writeFileSync(path.join(appDir, 'data', 'workspaces.db'), 'keep')

    runLegacyCleanups(appDir, silent)

    expect(fs.readFileSync(path.join(appDir, 'data', 'agent', 'models.json'), 'utf-8')).toContain(
      'keep'
    )
    expect(fs.existsSync(path.join(appDir, 'data', 'workspaces.db'))).toBe(true)
  })

  it('is idempotent: the second launch does nothing', () => {
    seedLeftovers()
    runLegacyCleanups(appDir, silent)

    // 用户之后又手动放回来一份（例如从备份恢复），已执行过的迁移不再动它
    fs.mkdirSync(path.join(appDir, 'data', 'cloud-agent'), { recursive: true })
    const second = runLegacyCleanups(appDir, silent)

    expect(second).toEqual([])
    expect(fs.existsSync(path.join(appDir, 'data', 'cloud-agent'))).toBe(true)
  })

  it('does not throw when nothing is there', () => {
    expect(() => runLegacyCleanups(appDir, silent)).not.toThrow()
    expect(runLegacyCleanups(appDir, silent)).toEqual([])
  })

  it('stays retryable when the marker cannot be written', () => {
    seedLeftovers()
    // 用一个目录占据标记文件的位置：写入必然失败
    fs.mkdirSync(markerPath(), { recursive: true })
    // 读取时 atomic-json 会把 EISDIR 打到 console，属于预期噪音
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(runLegacyCleanups(appDir, silent)).toEqual([])
    expect(silent.warn).toHaveBeenCalled()

    // 障碍去掉后下一次启动会补上（此时已经没东西可删，只补标记）
    fs.rmdirSync(markerPath())
    expect(runLegacyCleanups(appDir, silent)).toEqual([CLOUD_AGENT_REMOVED])
    expect(fs.existsSync(markerPath())).toBe(true)
    quiet.mockRestore()
  })
})
