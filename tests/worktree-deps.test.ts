import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'
import {
  WorktreeDepsInstaller,
  WorktreeDepsManager,
  clearLockfileHashCache,
  detectLockfile,
  installCommand,
  resolveDepsState,
  sanitizeInstallEnv,
  truncateError,
  type SpawnFn,
  type SpawnedProcess,
  type WorktreeDepsStatus,
} from '../electron/worktree-deps'

let repo = ''
let worktree = ''

async function write(file: string, content: string): Promise<void> {
  await fs.writeFile(path.join(repo, file), content, 'utf8')
}

function sha1(content: string): string {
  return createHash('sha1').update(Buffer.from(content, 'utf8')).digest('hex')
}

beforeEach(async () => {
  clearLockfileHashCache()
  repo = await fs.mkdtemp(path.join(tmpdir(), 'pi-worktree-deps-'))
  worktree = path.join(repo, '.pi-workbench', 'worktrees', 'wt-1')
  await fs.mkdir(worktree, { recursive: true })
})

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('lockfile 探测', () => {
  it('没有 lockfile 时不安装、不报错', async () => {
    await write('package.json', '{"name":"x"}')
    expect(await detectLockfile(repo)).toBeNull()
  })

  it.each([
    ['pnpm-lock.yaml', 'pnpm', 'pnpm', ['install', '--frozen-lockfile'], 'node_modules'],
    ['bun.lockb', 'bun', 'bun', ['install', '--frozen-lockfile'], 'node_modules'],
    ['bun.lock', 'bun', 'bun', ['install', '--frozen-lockfile'], 'node_modules'],
    ['package-lock.json', 'npm', 'npm', ['ci'], 'node_modules'],
    ['uv.lock', 'uv', 'uv', ['sync', '--frozen'], '.venv'],
  ])('%s → %s', async (lockfile, manager, command, args, depsDir) => {
    await write(lockfile as string, 'lockfile-content\n')
    const info = await detectLockfile(repo)
    expect(info).toMatchObject({ lockfile, manager, command, args, depsDir })
    expect(info?.hash).toBe(`${manager}:${sha1('lockfile-content\n')}`)
  })

  it('yarn v1 用 --frozen-lockfile', async () => {
    await write('yarn.lock', 'yarn\n')
    expect(await detectLockfile(repo)).toMatchObject({
      manager: 'yarn',
      args: ['install', '--frozen-lockfile'],
    })
  })

  it('有 .yarnrc.yml 时视为 berry，用 --immutable', async () => {
    await write('yarn.lock', 'yarn\n')
    await write('.yarnrc.yml', 'nodeLinker: node-modules\n')
    expect(await detectLockfile(repo)).toMatchObject({
      manager: 'yarn',
      args: ['install', '--immutable'],
    })
  })

  it('多个 lockfile 共存时按 pnpm → bun → yarn → npm 的优先级取第一个', async () => {
    await write('package-lock.json', 'npm\n')
    await write('pnpm-lock.yaml', 'pnpm\n')
    await write('yarn.lock', 'yarn\n')
    expect((await detectLockfile(repo))?.manager).toBe('pnpm')
  })

  it('lockfile 内容变化后哈希跟着变', async () => {
    await write('pnpm-lock.yaml', 'v1\n')
    const first = await detectLockfile(repo)
    // 长度不同才能稳定绕过 mtime 毫秒级缓存（同一毫秒内的等长改写看不出来）
    await write('pnpm-lock.yaml', 'v2-updated\n')
    const second = await detectLockfile(repo)
    expect(first?.hash).not.toBe(second?.hash)
  })

  it('命令映射覆盖全部包管理器', () => {
    expect(installCommand('pnpm', repo)).toEqual({
      command: 'pnpm',
      args: ['install', '--frozen-lockfile'],
    })
    expect(installCommand('npm', repo)).toEqual({ command: 'npm', args: ['ci'] })
    expect(installCommand('uv', repo)).toEqual({ command: 'uv', args: ['sync', '--frozen'] })
  })
})

describe('依赖状态判定', () => {
  const base = {
    hasLockfile: true,
    installedHash: 'pnpm:aaaa',
    currentHash: 'pnpm:aaaa',
    depsPresent: true,
    installing: false,
    failed: false,
    autoInstall: true,
  }

  it('哈希一致且依赖目录存在 → ready', () => {
    expect(resolveDepsState(base)).toBe('ready')
  })

  it('哈希变了 → installing', () => {
    expect(resolveDepsState({ ...base, installedHash: 'pnpm:bbbb' })).toBe('installing')
  })

  it('哈希一致但依赖目录被删 → installing', () => {
    expect(resolveDepsState({ ...base, depsPresent: false })).toBe('installing')
  })

  it('没有 lockfile → none，优先于其它条件', () => {
    expect(resolveDepsState({ ...base, hasLockfile: false })).toBe('none')
  })

  it('失败后不自动重试，等用户手动触发', () => {
    expect(resolveDepsState({ ...base, depsPresent: false, failed: true })).toBe('failed')
  })

  it('关掉自动安装时停在 idle', () => {
    expect(resolveDepsState({ ...base, depsPresent: false, autoInstall: false })).toBe('idle')
  })
})

describe('安装环境变量', () => {
  it('剔除应用自己的敏感变量与供应商密钥', () => {
    const env = sanitizeInstallEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      PI_WORKBENCH_API_KEY: 'secret',
      PI_WORKBENCH_WEB_SEARCH_KEY_TAVILY: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      NPM_TOKEN: 'registry-token',
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', NPM_TOKEN: 'registry-token' })
  })

  it('错误信息截断到 2000 字符', () => {
    expect(truncateError('x'.repeat(5000)).length).toBe(2000)
  })
})

/** 假的子进程：由测试决定何时 exit，记录 kill 调用 */
function createFakeSpawn() {
  const children: Array<{
    command: string
    args: string[]
    options: { cwd: string; env: NodeJS.ProcessEnv; shell: boolean }
    killed: boolean
    exit: (code: number | null) => void
    write: (chunk: string) => void
  }> = []

  const spawn: SpawnFn = (command, args, options) => {
    const stdoutListeners: Array<(chunk: unknown) => void> = []
    const exitListeners: Array<(...listenerArgs: unknown[]) => void> = []
    const record = {
      command,
      args,
      options,
      killed: false,
      exit: (code: number | null) => {
        for (const listener of exitListeners) listener(code)
      },
      write: (chunk: string) => {
        for (const listener of stdoutListeners) listener(chunk)
      },
    }
    children.push(record)
    const child: SpawnedProcess = {
      stdout: { on: (_event, listener) => stdoutListeners.push(listener) },
      stderr: { on: (_event, listener) => stdoutListeners.push(listener) },
      on: (event, listener) => {
        if (event === 'exit') exitListeners.push(listener)
      },
      kill: () => {
        record.killed = true
        return true
      },
    }
    return child
  }

  return { spawn, children }
}

describe('WorktreeDepsInstaller', () => {
  it('按 lockfile 的命令与工作树 cwd 启动安装，成功即 ok', async () => {
    const fake = createFakeSpawn()
    const installer = new WorktreeDepsInstaller({ spawn: fake.spawn })
    await write('pnpm-lock.yaml', 'lock\n')
    const info = (await detectLockfile(repo))!

    const promise = installer.install(worktree, info)
    expect(installer.isRunning(worktree)).toBe(true)
    expect(fake.children).toHaveLength(1)
    expect(fake.children[0].command).toBe('pnpm')
    expect(fake.children[0].args).toEqual(['install', '--frozen-lockfile'])
    expect(fake.children[0].options.cwd).toBe(worktree)

    fake.children[0].exit(0)
    await expect(promise).resolves.toEqual({ ok: true })
    expect(installer.isRunning(worktree)).toBe(false)
  })

  it('非零退出码带上输出尾部作为错误', async () => {
    const fake = createFakeSpawn()
    const installer = new WorktreeDepsInstaller({ spawn: fake.spawn })
    await write('package-lock.json', 'lock\n')
    const info = (await detectLockfile(repo))!

    const promise = installer.install(worktree, info)
    fake.children[0].write('network unreachable\n')
    fake.children[0].exit(1)
    const result = await promise
    expect(result.ok).toBe(false)
    expect(result.error).toContain('network unreachable')
  })

  it('不同工作树串行安装：前一个结束才启动下一个', async () => {
    const fake = createFakeSpawn()
    const installer = new WorktreeDepsInstaller({ spawn: fake.spawn })
    await write('package-lock.json', 'lock\n')
    const info = (await detectLockfile(repo))!

    const other = path.join(repo, 'wt-second')
    await fs.mkdir(other, { recursive: true })

    const first = installer.install(worktree, info)
    const second = installer.install(other, info)

    // 第一个立刻跑，第二个排队等令牌
    expect(fake.children).toHaveLength(1)
    expect(fake.children[0].options.cwd).toBe(worktree)
    expect(installer.isRunning(other)).toBe(true)

    fake.children[0].exit(0)
    await expect(first).resolves.toEqual({ ok: true })

    // 令牌转交后才启动第二个
    await vi.waitFor(() => expect(fake.children).toHaveLength(2))
    expect(fake.children[1].options.cwd).toBe(other)
    fake.children[1].exit(0)
    await expect(second).resolves.toEqual({ ok: true })
  })

  it('排队中的安装被取消时不会启动', async () => {
    const fake = createFakeSpawn()
    const installer = new WorktreeDepsInstaller({ spawn: fake.spawn })
    await write('package-lock.json', 'lock\n')
    const info = (await detectLockfile(repo))!

    const other = path.join(repo, 'wt-queued')
    await fs.mkdir(other, { recursive: true })

    const first = installer.install(worktree, info)
    const second = installer.install(other, info)
    expect(installer.cancel(other)).toBe(true)

    first.then(() => undefined)
    fake.children[0].exit(0)
    await expect(second).resolves.toEqual({ ok: false, cancelled: true })
    // 只有第一个真的跑过
    expect(fake.children).toHaveLength(1)
  })

  it('同一工作树并发只跑一次安装', async () => {
    const fake = createFakeSpawn()
    const installer = new WorktreeDepsInstaller({ spawn: fake.spawn })
    await write('package-lock.json', 'lock\n')
    const info = (await detectLockfile(repo))!

    const first = installer.install(worktree, info)
    const second = installer.install(worktree, info)
    expect(first).toBe(second)
    expect(fake.children).toHaveLength(1)

    fake.children[0].exit(0)
    await expect(first).resolves.toEqual({ ok: true })
  })

  it('取消会终止子进程，且不算失败', async () => {
    const fake = createFakeSpawn()
    const installer = new WorktreeDepsInstaller({ spawn: fake.spawn })
    await write('package-lock.json', 'lock\n')
    const info = (await detectLockfile(repo))!

    const promise = installer.install(worktree, info)
    expect(installer.cancel(worktree)).toBe(true)
    expect(fake.children[0].killed).toBe(true)
    await expect(promise).resolves.toEqual({ ok: false, cancelled: true })
    expect(installer.isRunning(worktree)).toBe(false)
  })

  it('包管理器命令不存在时按失败结算，不留下卡住的任务', async () => {
    const installer = new WorktreeDepsInstaller({
      spawn: () => {
        throw new Error('spawn pnpm ENOENT')
      },
    })
    await write('pnpm-lock.yaml', 'lock\n')
    const info = (await detectLockfile(repo))!

    await expect(installer.install(worktree, info)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('ENOENT') as unknown as string,
    })
    expect(installer.isRunning(worktree)).toBe(false)
  })

  it('超时按失败结算并终止进程', async () => {
    const fake = createFakeSpawn()
    const installer = new WorktreeDepsInstaller({ spawn: fake.spawn, timeoutMs: 10 })
    await write('package-lock.json', 'lock\n')
    const info = (await detectLockfile(repo))!

    const result = await installer.install(worktree, info)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('超时')
    expect(fake.children[0].killed).toBe(true)
  })
})

describe('WorktreeDepsManager', () => {
  function createManager(overrides: {
    installed?: string[]
    autoInstall?: boolean
    statuses?: Array<{ path: string; status: WorktreeDepsStatus }>
  }) {
    const fake = createFakeSpawn()
    const installer = new WorktreeDepsInstaller({ spawn: fake.spawn })
    const manager = new WorktreeDepsManager({
      repoRoot: repo,
      logger: { info: () => {}, warn: () => {} },
      isAutoInstallEnabled: () => overrides.autoInstall ?? true,
      onInstalled: (worktreePath, hash) => overrides.installed?.push(`${worktreePath}|${hash}`),
      onStatusChange: (worktreePath, status) =>
        overrides.statuses?.push({ path: worktreePath, status }),
      installer,
    })
    return { manager, fake }
  }

  it('哈希未变且 node_modules 存在 → ready，不启动安装', async () => {
    await write('pnpm-lock.yaml', 'lock\n')
    const { manager, fake } = createManager({})
    await fs.mkdir(path.join(worktree, 'node_modules'), { recursive: true })
    const hash = (await detectLockfile(repo))!.hash

    const status = await manager.statusFor(worktree, hash)
    expect(status).toMatchObject({ state: 'ready', manager: 'pnpm' })
    expect(fake.children).toHaveLength(0)
  })

  it('statusFor 只读：需要安装时只报告 idle，不启动子进程', async () => {
    await write('package-lock.json', 'lock\n')
    const { manager, fake } = createManager({})

    const status = await manager.statusFor(worktree, null)
    expect(status.state).toBe('idle')
    expect(fake.children).toHaveLength(0)
  })

  it('依赖目录被删 → 后台安装，成功后回调落盘哈希', async () => {
    await write('package-lock.json', 'lock\n')
    const installed: string[] = []
    const { manager, fake } = createManager({ installed })
    const hash = (await detectLockfile(repo))!.hash

    const status = await manager.ensureInstalled(worktree, hash)
    expect(status.state).toBe('installing')
    expect(fake.children).toHaveLength(1)

    // npm ci 真的会生成 node_modules；假进程要把它补上才能走通成功路径
    await fs.mkdir(path.join(worktree, 'node_modules'), { recursive: true })
    fake.children[0].exit(0)
    await vi.waitFor(() => expect(installed).toHaveLength(1))
    expect(installed[0]).toBe(`${worktree}|${hash}`)
    // 落盘可能还没回来：内存里的哈希已经生效，不能自己再判成未安装
    expect((await manager.statusFor(worktree, null)).state).toBe('ready')
  })

  it('命令成功但没生成依赖目录时置 failed，不陷入重装循环', async () => {
    await write('package-lock.json', 'lock\n')
    const { manager, fake } = createManager({})
    const hash = (await detectLockfile(repo))!.hash

    await manager.ensureInstalled(worktree, hash)
    fake.children[0].exit(0)
    const status = await vi.waitFor(async () => {
      const next = await manager.statusFor(worktree, hash)
      expect(next.state).toBe('failed')
      return next
    })
    expect(status.error).toContain('node_modules')
    expect(fake.children).toHaveLength(1)
  })

  it('安装失败只置 failed，不阻塞、不自动重试', async () => {
    await write('package-lock.json', 'lock\n')
    const { manager, fake } = createManager({})
    const hash = (await detectLockfile(repo))!.hash

    await manager.ensureInstalled(worktree, hash)
    fake.children[0].write('boom\n')
    fake.children[0].exit(1)

    const status = await vi.waitFor(async () => {
      const next = await manager.statusFor(worktree, hash)
      expect(next.state).toBe('failed')
      return next
    })
    expect(status.error).toContain('boom')
    expect(fake.children).toHaveLength(1)
  })

  it('两个会话绑定同一工作树也只跑一次安装', async () => {
    await write('package-lock.json', 'lock\n')
    const { manager, fake } = createManager({})
    const hash = (await detectLockfile(repo))!.hash

    const [a, b] = await Promise.all([
      manager.ensureInstalled(worktree, hash),
      manager.ensureInstalled(worktree, null),
    ])
    expect(a.state).toBe('installing')
    expect(b.state).toBe('installing')
    expect(fake.children).toHaveLength(1)
  })

  it('没有 lockfile 时跳过安装并返回 none', async () => {
    const { manager, fake } = createManager({})
    const status = await manager.statusFor(worktree, null)
    expect(status).toEqual({ state: 'none', manager: null, hash: null })
    expect(fake.children).toHaveLength(0)
  })

  it('关掉自动安装时停在 idle，手动 install 才启动', async () => {
    await write('package-lock.json', 'lock\n')
    const { manager, fake } = createManager({ autoInstall: false })

    expect((await manager.statusFor(worktree, null)).state).toBe('idle')
    // 自动安装关掉时，绑定路径（ensureInstalled）也不会偷偷启动
    expect((await manager.ensureInstalled(worktree, null)).state).toBe('idle')
    expect(fake.children).toHaveLength(0)

    expect((await manager.install(worktree)).state).toBe('installing')
    expect(fake.children).toHaveLength(1)
  })

  it('forget 会终止在跑的安装', async () => {
    await write('package-lock.json', 'lock\n')
    const { manager, fake } = createManager({})
    const hash = (await detectLockfile(repo))!.hash

    await manager.ensureInstalled(worktree, hash)
    manager.forget(worktree)
    expect(fake.children[0].killed).toBe(true)
  })

  it('状态没变不重复推送事件', async () => {
    await write('pnpm-lock.yaml', 'lock\n')
    const statuses: Array<{ path: string; status: WorktreeDepsStatus }> = []
    const { manager } = createManager({ statuses })
    await fs.mkdir(path.join(worktree, 'node_modules'), { recursive: true })
    const hash = (await detectLockfile(repo))!.hash

    await manager.statusFor(worktree, hash)
    await manager.statusFor(worktree, hash)
    expect(statuses.filter((item) => item.status.state === 'ready')).toHaveLength(1)
  })
})
