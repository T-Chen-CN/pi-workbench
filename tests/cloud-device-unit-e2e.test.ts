/**
 * C-05 端到端：真实云端 + 真实 DeviceAgent + 真实 git worktree 的回收闭环。
 *
 * 已有的 `cloud-server-e2e.test.ts` 用假设备通道验证云端判定，`cloud-unit-close.test.ts` 用
 * 假协调器验证终端三态。这里把两头接起来跑真家伙：工单真的在磁盘上建出 worktree，结束后
 * 真的删目录/删分支，脏树真的留下来并能手动再结束一次。
 *
 * 不打真模型：`getApiConfig()` 返回 null，工单在 `ensureManager()` 处必然失败——正好覆盖
 * 「执行器报错也要把 worktreeClean 报上去」这条回收前提。
 */

// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'
import { CLOUD_PROTOCOL_VERSION } from 'pi-bridge'
import { createCloudServer, type CloudServer } from '../apps/cloud/src/main'

const execFileAsync = promisify(execFile)

const linkState: { record: any; token: string; baseUrl: string } = {
  record: null,
  token: '',
  baseUrl: '',
}

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.env.TEMP ?? '/tmp',
  },
}))

// 配对凭据由本测试直接写进内存，不碰 safeStorage
vi.mock('../electron/cloud/link-store.js', () => ({
  readCloudLink: () => linkState.record,
  readCloudToken: () => linkState.token,
  touchCloudLink: async () => undefined,
  saveCloudLink: async (input: any) => {
    linkState.record = { ...input, pairedAt: Date.now() }
    return linkState.record
  },
  clearCloudLink: async () => {
    linkState.record = null
  },
  normalizeBaseUrl: (input: string) => input,
  wsUrl: (base: string, pathname: string) => `${base.replace(/^http/, 'ws')}${pathname}`,
}))

const { DeviceAgent } = await import('../electron/cloud/device-agent')
const { WorktreeCoordinator } = await import('../electron/worktree-coordinator')

let tmpRoot = ''
let repo = ''
let deviceDataDir = ''
let server: CloudServer
let base = ''
let cookie = ''
let deviceId = ''
let agent: InstanceType<typeof DeviceAgent>

/** 协调器调用记录：绑定了哪些新工作树、回收了多少次 */
const coordinatorCalls = { newBinds: [] as string[], releases: [] as string[] }

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', cookie, ...extra }
}

async function waitFor<T>(probe: () => T | Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function git(args: string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repo }).then((result) => result.stdout.trim())
}

async function authorize(quota: number): Promise<string> {
  const response = await fetch(`${base}/v1/authorizations`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      planText: 'e2e plan',
      items: [{ deviceId, workspacePath: repo }],
      quota,
    }),
  })
  const body = (await response.json()) as { authorization: { id: string } }
  return body.authorization.id
}

async function dispatchTask(
  authorizationId: string,
  workUnitId: string,
  title: string
): Promise<string> {
  const outcome = await server.dispatcher.dispatch({
    authorizationId,
    workUnitId,
    deviceId,
    workspacePath: repo,
    title,
    background: 'b',
    goal: title,
    acceptance: 'a',
    commit: false,
  })
  if (!outcome.ok) throw new Error(`dispatch failed: ${outcome.message}`)
  return outcome.task.id
}

/** 工单在这个测试里一定失败（没有 API 配置），等它进终态 */
async function waitTerminal(taskId: string): Promise<void> {
  await waitFor(() => {
    const task = server.store.findTask(taskId)
    return task && ['failed', 'done', 'cancelled', 'interrupted'].includes(task.status) ? task : null
  }, `task ${taskId} terminal`)
}

async function closeUnit(unitId: string): Promise<number> {
  const response = await fetch(`${base}/v1/units/${encodeURIComponent(unitId)}/close`, {
    method: 'POST',
    headers: headers(),
  })
  return response.status
}

async function readUnitsLedger(): Promise<Record<string, any>> {
  try {
    return JSON.parse(await fs.readFile(path.join(deviceDataDir, 'units.json'), 'utf-8'))
  } catch {
    return {}
  }
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-unit-e2e-'))
  repo = path.join(tmpRoot, 'repo')
  deviceDataDir = path.join(tmpRoot, 'device')
  await fs.mkdir(repo, { recursive: true })
  await fs.writeFile(path.join(repo, 'README.md'), '# e2e repo\n')
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 'e2e@example.com'])
  await git(['config', 'user.name', 'e2e'])
  await git(['add', '.'])
  await git(['commit', '-q', '-m', 'init'])

  server = await createCloudServer(
    {
      dataDir: path.join(tmpRoot, 'cloud'),
      workspaceDir: path.join(tmpRoot, 'cloud-workspace'),
      agentDir: path.join(tmpRoot, 'cloud-agent'),
      port: 0,
      encryptionKey: Buffer.alloc(32, 9),
      cookieSecret: 'unit-e2e-secret',
      secureCookies: false,
      version: 'e2e',
    },
    // 本测试不推云端配置；探测替身只是防止误打外网
    { probeConfig: async () => ({ ok: true }) }
  )
  const port = await server.listen()
  base = `http://127.0.0.1:${port}`

  await fetch(`${base}/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'password-1234' }),
  })
  const login = await fetch(`${base}/v1/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'password-1234' }),
  })
  cookie = (login.headers.getSetCookie?.() ?? [])[0].split(';')[0]

  const codeResponse = await fetch(`${base}/v1/pair/code`, { method: 'POST', headers: headers() })
  const { code } = (await codeResponse.json()) as { code: string }
  const pair = await fetch(`${base}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      deviceName: 'unit-e2e-device',
      platform: 'win32',
      workspaces: [{ path: repo, name: 'repo', isGit: true }],
    }),
  })
  const paired = (await pair.json()) as { deviceId: string; token: string }
  deviceId = paired.deviceId
  linkState.baseUrl = base
  linkState.token = paired.token
  linkState.record = {
    baseUrl: base,
    deviceId,
    deviceName: 'unit-e2e-device',
    token: 'enc:stub',
    pairedAt: Date.now(),
  }

  // 脏树场景需要「台账里已经有一棵挂着改动的树」：台账只在构造时读盘，所以先种再起 agent
  const seeded = await WorktreeCoordinator.forWorkspace(repo)
  if (!seeded) throw new Error('repo is not a git workspace')
  const bound = await seeded.bind('cloud:unit-dirty', 'new')
  if (!bound.success || !bound.worktree) throw new Error('failed to seed worktree')
  await fs.writeFile(path.join(bound.worktree.path, 'wip.txt'), 'uncommitted work\n')
  await fs.mkdir(deviceDataDir, { recursive: true })
  await fs.writeFile(
    path.join(deviceDataDir, 'units.json'),
    JSON.stringify({
      'unit-dirty': {
        repoPath: repo,
        worktreePath: bound.worktree.path,
        branch: bound.worktree.branch,
        base: 'main',
        createdAt: Date.now(),
      },
    })
  )

  agent = new (DeviceAgent as any)({
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    dataDir: deviceDataDir,
    getWorkspaces: async () => [{ path: repo, name: 'repo', isGit: true, defaultBranch: 'main' }],
    getApiConfig: async () => null,
    getCoordinator: async (repoPath: string) => {
      const coordinator = await WorktreeCoordinator.forWorkspace(repoPath)
      if (!coordinator) return null
      // 记录真实调用：绑定了哪些新树、回收了几次
      const bind = coordinator.bind.bind(coordinator)
      const release = coordinator.release.bind(coordinator)
      coordinator.bind = async (sessionId: string, target: string, branch?: string) => {
        const result = await bind(sessionId, target, branch)
        if (target === 'new' && result.success && result.worktree) {
          coordinatorCalls.newBinds.push(result.worktree.path)
        }
        return result
      }
      coordinator.release = async (sessionId: string) => {
        coordinatorCalls.releases.push(sessionId)
        return release(sessionId)
      }
      return coordinator
    },
    onStateChange: () => undefined,
  })
  await agent.start()
  await waitFor(
    () => server.dispatcher.deviceSnapshots().find((item) => item.id === deviceId)?.online,
    'device online'
  )
}, 60_000)

afterAll(async () => {
  await agent?.stop().catch(() => undefined)
  await server?.close().catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 200))
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe('工作单元回收（真实 worktree）', () => {
  it('干净树：工单失败后自动回收，目录与无提交的分支一起消失（A-43）', async () => {
    const authorizationId = await authorize(1)
    const taskId = await dispatchTask(authorizationId, 'unit-clean', 'clean unit')

    await waitTerminal(taskId)
    expect(server.store.findTask(taskId)?.status).toBe('failed')

    // 云端发出回收请求 → 设备回执 → 云端落 closedAt
    const unit = (await waitFor(() => {
      const current = server.store.findUnit('unit-clean')
      return current && current.closedAt !== null ? current : null
    }, 'unit closed'))!
    expect(unit.worktreePath).toBeTruthy()
    expect(unit.dirtyAt).toBeUndefined()

    // 磁盘真的没了：目录不存在、分支（没有新提交）也删掉、台账清空
    await waitFor(async () => {
      try {
        await fs.access(unit.worktreePath!)
        return null
      } catch {
        return true
      }
    }, 'worktree removed')
    // 分支：没新提交就连分支一起删（beforeAll 里种下的另一个单元的分支不参与判断）
    expect(await git(['branch', '--list', unit.branch!])).toBe('')
    expect(Object.keys(await readUnitsLedger())).not.toContain('unit-clean')
    expect(coordinatorCalls.releases).toContain('cloud:unit-clean')
  }, 40_000)

  it('同一单元连派 3 张：只建一棵树、只回收一次（A-42 / A-46）', async () => {
    const authorizationId = await authorize(3)
    const bindsBefore = coordinatorCalls.newBinds.length
    const releasesBefore = coordinatorCalls.releases.length

    const taskIds: string[] = []
    for (const index of [1, 2, 3]) {
      taskIds.push(await dispatchTask(authorizationId, 'unit-multi', `multi ${index}`))
    }
    for (const taskId of taskIds) await waitTerminal(taskId)

    const unit = (await waitFor(() => {
      const current = server.store.findUnit('unit-multi')
      return current && current.closedAt !== null ? current : null
    }, 'multi unit closed'))!

    // 一棵树：整个过程中只为这个单元新建过一次工作树
    expect(coordinatorCalls.newBinds.length - bindsBefore).toBe(1)
    // 一次回收：前两张结束时不回收（否则第二张会在新树里丢掉前序改动）
    const releases = coordinatorCalls.releases.slice(releasesBefore)
    expect(releases.filter((id) => id === 'cloud:unit-multi')).toHaveLength(1)

    expect(await git(['branch', '--list', unit.branch!])).toBe('')
    expect(Object.keys(await readUnitsLedger())).not.toContain('unit-multi')
    expect(unit.closeRequestedAt).toBeUndefined()
  }, 60_000)

  it('脏树：不自动回收；手动结束按回执标「待清理」，清理后再结束才真删（A-43）', async () => {
    const authorizationId = await authorize(1)
    const taskId = await dispatchTask(authorizationId, 'unit-dirty', 'dirty unit')

    await waitTerminal(taskId)
    // 有未提交文件 → 云端不会自动发回收请求
    const afterTask = (await waitFor(() => server.store.findUnit('unit-dirty'), 'dirty unit'))!
    expect(afterTask.closeRequestedAt).toBeUndefined()
    expect(afterTask.closedAt).toBeNull()
    await fs.access(afterTask.worktreePath!) // 树还在

    // 手动结束：设备回 dirty → 云端标 dirtyAt，但仍未结束
    expect(await closeUnit('unit-dirty')).toBe(200)
    const dirtyReply = (await waitFor(() => {
      const current = server.store.findUnit('unit-dirty')
      return current?.dirtyAt ? current : null
    }, 'dirty receipt'))!
    expect(dirtyReply.closedAt).toBeNull()
    await fs.access(dirtyReply.worktreePath!) // 树仍然保留
    expect(Object.keys(await readUnitsLedger())).toContain('unit-dirty')

    // 用户清理后（这里直接删掉未提交文件）再点一次：重挂绑定后真删
    await fs.rm(path.join(dirtyReply.worktreePath!, 'wip.txt'))
    expect(await closeUnit('unit-dirty')).toBe(200)
    const closed = (await waitFor(() => {
      const current = server.store.findUnit('unit-dirty')
      return current && current.closedAt !== null ? current : null
    }, 'dirty unit closed'))!
    expect(closed.dirtyAt).toBeUndefined()
    await expect(fs.access(closed.worktreePath!)).rejects.toThrow()
    expect(Object.keys(await readUnitsLedger())).not.toContain('unit-dirty')
  }, 60_000)

  it('单元已结束时再派活 → 云端直接拒绝（不会复活已删的树）', async () => {
    const authorizationId = await authorize(1)
    const outcome = await server.dispatcher.dispatch({
      authorizationId,
      workUnitId: 'unit-clean',
      deviceId,
      workspacePath: repo,
      title: 'revive',
      background: 'b',
      goal: 'g',
      acceptance: 'a',
      commit: false,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('unit-closed')
  })

  it('设备通道用的是同一套协议版本（回归：终端不认新帧时会走重发兜底）', async () => {
    expect(CLOUD_PROTOCOL_VERSION).toBe(1)
    expect(server.dispatcher.deviceSnapshots().find((item) => item.id === deviceId)?.online).toBe(true)
  })
})
