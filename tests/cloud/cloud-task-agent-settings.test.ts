/**
 * 工单会话的压缩参数（§4.0 实测约束 1）。
 *
 * `models.json` 的 `contextWindow` 只有四档，写别的值会被静默回落成 128k；
 * 想让工单更早压缩只能改 `settings.json` 的 `compaction`。这里钉住三条：
 * 首次写入、幂等（不反复改写）、不覆盖文件里的其它字段。
 */

// @vitest-environment node

import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.env.TEMP ?? '/tmp',
  },
}))

const { taskRunnerInternals } = await import('../../electron/cloud/task-runner')
const { ensureTaskAgentSettings, TASK_COMPACTION_SETTINGS } = taskRunnerInternals

let tmpRoot = ''

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-settings-'))
})

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe('工单 agentDir 的 settings.json', () => {
  it('首次写入更激进的压缩参数', async () => {
    const agentDir = path.join(tmpRoot, 'fresh')
    await ensureTaskAgentSettings(agentDir)
    const parsed = JSON.parse(await fs.readFile(path.join(agentDir, 'settings.json'), 'utf-8'))
    expect(parsed.compaction).toMatchObject(TASK_COMPACTION_SETTINGS)
    // 比 SDK 默认（16384 / 20000）更早压缩：工单会话要的是“够用就好”，不是长上下文
    expect(parsed.compaction.reserveTokens).toBeLessThan(16384)
    expect(parsed.compaction.keepRecentTokens).toBeLessThan(20000)
  })

  it('保留文件里的其它字段，且重复调用不改写', async () => {
    const agentDir = path.join(tmpRoot, 'existing')
    await fs.mkdir(agentDir, { recursive: true })
    const file = path.join(agentDir, 'settings.json')
    await fs.writeFile(
      file,
      JSON.stringify({ theme: 'ink', compaction: { enabled: true, reserveTokens: 16384 } })
    )

    await ensureTaskAgentSettings(agentDir)
    const first = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(first)
    expect(parsed).toMatchObject({ theme: 'ink' })
    expect(parsed.compaction).toMatchObject(TASK_COMPACTION_SETTINGS)

    // 幂等：内容已经对上就不再重写（避免每次起工单都动机器上的配置文件）
    const before = await fs.stat(file)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await ensureTaskAgentSettings(agentDir)
    const after = await fs.stat(file)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })
})
