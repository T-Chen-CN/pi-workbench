/**
 * 工作单元回收（F-19a / A-43 / A-46）—— 终端侧。
 *
 * 覆盖三件事：
 * ① `closeUnit()` 只绑定 `cloud:<unitId>` 一次，并按 `release()` 的三态回执（脏树保留 / 已删）；
 * ② `units.json` 台账跟着回收走：脏树留着（还能再结束一次），回收成功就删；
 * ③ `sweepUnits()` 的干净判定真的读 `git status --porcelain`（ignored 文件不算脏），
 *    目录已不在时直接丢台账，让云端能收口。
 *
 * 不打真模型：这里不进入 `start()`，只驱动回收路径。
 */

// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.env.TEMP ?? '/tmp',
  },
}))

const { CloudTaskRunner } = await import('../electron/cloud/task-runner')

interface UnitClosedCall {
  unitId: string
  result: { removed: boolean; dirty: boolean; worktreePath?: string; branch?: string; error?: string }
}

let tmpRoot = ''
let dataDir = ''
let closed: UnitClosedCall[] = []
let states: Array<{ unitId: string; clean: boolean; worktreePath?: string }> = []
let releaseCalls: string[] = []
let bindCalls: Array<{ sessionId: string; path: string }> = []
/** 假协调器的绑定表：`release()` 会删绑定（真实行为），`bind()` 会重新挂上 */
let bindings = new Set<string>()
let releaseResult: {
  success: boolean
  removed?: boolean
  dirty?: boolean
  worktreePath?: string
  error?: string
} = {
  success: true,
  removed: true,
  dirty: false,
}

function makeRunner(): InstanceType<typeof CloudTaskRunner> {
  return new CloudTaskRunner({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    dataDir,
    getApiConfig: async () => null,
    getCoordinator: async () => ({
      bind: async (sessionId: string, path: string) => {
        bindCalls.push({ sessionId, path })
        bindings.add(sessionId)
        return { success: true }
      },
      getSessionBinding: () => ({ key: '', path: '', branch: null }),
      hasBinding: (sessionId: string) => bindings.has(sessionId),
      release: async (sessionId: string) => {
        releaseCalls.push(sessionId)
        // 真实 release() 先删绑定、再判干净：脏树也照样丢绑定，树留在磁盘上
        bindings.delete(sessionId)
        return { ...releaseResult }
      },
    }),
    onStatus: () => undefined,
    onWorktree: () => undefined,
    onMilestone: () => undefined,
    onQuestion: () => undefined,
    onResult: () => undefined,
    onFailed: () => undefined,
    onInterrupted: () => undefined,
    onUnitClosed: (unitId, result) => closed.push({ unitId, result }),
    onUnitState: (unitId, state) => states.push({ unitId, ...state }),
  })
}

async function writeUnits(units: Record<string, { repoPath: string; worktreePath: string; branch: string | null; createdAt: number }>) {
  await fs.writeFile(path.join(dataDir, 'units.json'), JSON.stringify(units, null, 2), 'utf-8')
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-units-'))
  dataDir = path.join(tmpRoot, 'data')

  // 干净工作树：真实 git 仓库，只有一个已提交文件
  const clean = path.join(tmpRoot, 'clean')
  await fs.mkdir(clean, { recursive: true })
  git(clean, ['init'])
  git(clean, ['config', 'user.email', 'test@example.com'])
  git(clean, ['config', 'user.name', 'Test'])
  await fs.writeFile(path.join(clean, 'a.txt'), 'a\n', 'utf-8')
  git(clean, ['add', '.'])
  git(clean, ['commit', '-m', 'init'])
  // ignored 文件不算脏：装了依赖的工作树仍然是「干净」
  await fs.writeFile(path.join(clean, '.gitignore'), 'node_modules/\n', 'utf-8')
  git(clean, ['add', '.gitignore'])
  git(clean, ['commit', '-m', 'ignore'])
  await fs.mkdir(path.join(clean, 'node_modules'), { recursive: true })
  await fs.writeFile(path.join(clean, 'node_modules', 'x.js'), 'x\n', 'utf-8')
})

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  closed = []
  states = []
  releaseCalls = []
  bindCalls = []
  bindings = new Set()
  releaseResult = { success: true, removed: true, dirty: false }
  await fs.rm(dataDir, { recursive: true, force: true })
  await fs.mkdir(dataDir, { recursive: true })
})

describe('closeUnit（F-19a）', () => {
  it('用一个合成绑定 id cloud:<unitId> 调 release，成功后删台账', async () => {
    const worktreePath = path.join(tmpRoot, 'clean')
    await writeUnits({
      'unit-a': { repoPath: worktreePath, worktreePath, branch: 'pi/wt-1', createdAt: 1 },
    })
    const runner = makeRunner()
    await runner.load()

    releaseResult = { success: true, removed: true, dirty: false, worktreePath }
    const result = await runner.closeUnit('unit-a')

    expect(result.ok).toBe(true)
    expect(releaseCalls).toEqual(['cloud:unit-a'])
    expect(closed).toHaveLength(1)
    expect(closed[0].result).toMatchObject({ removed: true, dirty: false, branch: 'pi/wt-1' })

    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'units.json'), 'utf-8'))
    expect(stored['unit-a']).toBeUndefined()
  })

  it('脏树：保留台账与工作树，回执 dirty，方便用户清理后再结束一次', async () => {
    const worktreePath = path.join(tmpRoot, 'clean')
    await writeUnits({
      'unit-b': { repoPath: worktreePath, worktreePath, branch: 'pi/wt-2', createdAt: 1 },
    })
    const runner = makeRunner()
    await runner.load()

    releaseResult = { success: true, removed: false, dirty: true, worktreePath }
    const result = await runner.closeUnit('unit-b')

    expect(result.ok).toBe(true)
    expect(closed[0].result).toMatchObject({ removed: false, dirty: true })
    // 台账还在：下一次「结束」还要用同一个 worktree
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'units.json'), 'utf-8'))
    expect(stored['unit-b']).toBeDefined()
  })

  it('脏树回执后绑定已释放：再次结束会先重挂再 release，不能空报成功', async () => {
    const worktreePath = path.join(tmpRoot, 'clean')
    await writeUnits({
      'unit-again': { repoPath: worktreePath, worktreePath, branch: 'pi/wt-5', createdAt: 1 },
    })
    const runner = makeRunner()
    await runner.load()
    // 派活时终端已经绑上过了
    bindings.add('cloud:unit-again')

    // 第一次：脏树，release 丢了绑定但树留着
    releaseResult = { success: true, removed: false, dirty: true, worktreePath }
    await runner.closeUnit('unit-again')
    expect(bindings.has('cloud:unit-again')).toBe(false)

    // 用户清理后再结束：必须先把绑定重挂上去，否则 release() 只会空转
    releaseResult = { success: true, removed: true, dirty: false, worktreePath }
    const result = await runner.closeUnit('unit-again')

    expect(bindCalls).toEqual([{ sessionId: 'cloud:unit-again', path: worktreePath }])
    expect(result.ok).toBe(true)
    expect(closed[closed.length - 1].result).toMatchObject({ removed: true, dirty: false })
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'units.json'), 'utf-8'))
    expect(stored['unit-again']).toBeUndefined()
  })

  it('没有台账（已回收过）也回执，让云端可以收口', async () => {
    const runner = makeRunner()
    await runner.load()
    const result = await runner.closeUnit('unit-missing')
    expect(result.ok).toBe(true)
    expect(closed[0]).toMatchObject({ unitId: 'unit-missing', result: { removed: false, dirty: false } })
  })

  it('删树失败：回执带 error 且台账不删（否则旧树变孤儿）', async () => {
    const worktreePath = path.join(tmpRoot, 'clean')
    await writeUnits({
      'unit-fail': { repoPath: worktreePath, worktreePath, branch: 'pi/wt-4', createdAt: 1 },
    })
    const runner = makeRunner()
    await runner.load()

    releaseResult = { success: false, removed: false, dirty: false, worktreePath, error: 'git worktree remove failed' }
    const result = await runner.closeUnit('unit-fail')

    expect(result).toMatchObject({ ok: false, error: 'git worktree remove failed' })
    expect(closed[0].result).toMatchObject({ removed: false, dirty: false, error: 'git worktree remove failed' })
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'units.json'), 'utf-8'))
    expect(stored['unit-fail']).toBeDefined()
  })

  it('准备阶段失败后立刻收到 closeUnit 不会被 starting 占位误拒（P-09 回归）', async () => {
    const worktreePath = path.join(tmpRoot, 'clean')
    let closePromise: Promise<{ ok: boolean; error?: string }> | null = null
    const runner = new CloudTaskRunner({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      dataDir,
      getApiConfig: async () => null,
      getCoordinator: async () => ({
        bind: async (sessionId: string) => {
          bindings.add(sessionId)
          return { success: true, worktree: { path: worktreePath, branch: 'pi/wt-race' } }
        },
        getSessionBinding: () => ({ key: '', path: worktreePath, branch: 'pi/wt-race' }),
        hasBinding: (sessionId: string) => bindings.has(sessionId),
        release: async (sessionId: string) => {
          releaseCalls.push(sessionId)
          bindings.delete(sessionId)
          return { success: true, removed: true, dirty: false, worktreePath }
        },
      }),
      onStatus: () => undefined,
      onWorktree: () => undefined,
      onMilestone: () => undefined,
      onQuestion: () => undefined,
      onResult: () => undefined,
      // 模拟云端收到 task_failed 后在同一个 tick 立刻回发 close_unit
      onFailed: () => {
        closePromise = runner.closeUnit('unit-race')
      },
      onInterrupted: () => undefined,
      onUnitClosed: (unitId, result) => closed.push({ unitId, result }),
      onUnitState: (unitId, state) => states.push({ unitId, ...state }),
    })
    await runner.load()

    await runner.start('T-race', {
      workUnitId: 'unit-race',
      deviceId: 'dev-1',
      repo: { workspacePath: worktreePath, baseBranch: 'main' },
      title: 'race',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      output: { summary: true, changeList: true, testResult: false },
      commit: false,
      authorizationId: 'auth-1',
    })

    expect(closePromise).not.toBeNull()
    const closeResult = await closePromise!
    expect(closeResult).toEqual({ ok: true, error: undefined })
    expect(releaseCalls).toEqual(['cloud:unit-race'])
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({
      unitId: 'unit-race',
      result: { removed: true, dirty: false },
    })
  })
})

describe('sweepUnits（A-43 兜底）', () => {
  it('干净工作树上报告 clean=true；脏树报 clean=false', async () => {
    const cleanPath = path.join(tmpRoot, 'clean')
    const dirtyPath = path.join(tmpRoot, 'dirty')
    await fs.mkdir(dirtyPath, { recursive: true })
    git(dirtyPath, ['init'])
    git(dirtyPath, ['config', 'user.email', 'test@example.com'])
    git(dirtyPath, ['config', 'user.name', 'Test'])
    await fs.writeFile(path.join(dirtyPath, 'a.txt'), 'a\n', 'utf-8')
    git(dirtyPath, ['add', '.'])
    git(dirtyPath, ['commit', '-m', 'init'])
    await fs.writeFile(path.join(dirtyPath, 'pending.txt'), 'wip\n', 'utf-8')

    await writeUnits({
      'unit-clean': { repoPath: cleanPath, worktreePath: cleanPath, branch: null, createdAt: 1 },
      'unit-dirty': { repoPath: dirtyPath, worktreePath: dirtyPath, branch: null, createdAt: 1 },
    })
    const runner = makeRunner()
    await runner.load()
    await runner.sweepUnits()

    expect(states).toEqual(
      expect.arrayContaining([
        { unitId: 'unit-clean', clean: true, worktreePath: cleanPath },
        { unitId: 'unit-dirty', clean: false, worktreePath: dirtyPath },
      ])
    )
  })

  it('工作树目录已经不在：丢台账并回执已结束，避免云端以为它还占着磁盘', async () => {
    await writeUnits({
      'unit-gone': {
        repoPath: path.join(tmpRoot, 'nowhere'),
        worktreePath: path.join(tmpRoot, 'nowhere'),
        branch: 'pi/wt-3',
        createdAt: 1,
      },
    })
    const runner = makeRunner()
    await runner.load()
    await runner.sweepUnits()

    expect(closed).toEqual([
      {
        unitId: 'unit-gone',
        result: { removed: false, dirty: false, worktreePath: path.join(tmpRoot, 'nowhere'), branch: 'pi/wt-3' },
      },
    ])
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'units.json'), 'utf-8'))
    expect(stored['unit-gone']).toBeUndefined()
    expect(releaseCalls).toEqual([])
  })
})
