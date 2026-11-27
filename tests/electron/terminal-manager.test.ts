import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { TerminalManager, type PtyProcess } from '../../electron/terminal-manager'
import { childRegistry } from '../../electron/child-registry'

interface FakePty extends PtyProcess {
  written: string[]
  sized: Array<[number, number]>
  killed: boolean
  emitData: (data: string) => void
  emitExit: (exitCode: number) => void
}

function createFakePty(): FakePty {
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number }) => void> = []

  const fake: FakePty = {
    written: [],
    sized: [],
    killed: false,
    onData: (listener) => {
      dataListeners.push(listener)
    },
    onExit: (listener) => {
      exitListeners.push(listener)
    },
    write: (data) => {
      fake.written.push(data)
    },
    resize: (cols, rows) => {
      fake.sized.push([cols, rows])
    },
    kill: () => {
      fake.killed = true
    },
    emitData: (data) => {
      for (const listener of dataListeners) listener(data)
    },
    emitExit: (exitCode) => {
      for (const listener of exitListeners) listener({ exitCode })
    },
  }

  return fake
}

let tmpDir: string
let ptys: FakePty[]
let manager: TerminalManager

function makeManager(overrides: Partial<ConstructorParameters<typeof TerminalManager>[0]> = {}) {
  ptys = []
  manager = new TerminalManager({
    spawn: vi.fn(() => {
      const pty = createFakePty()
      ptys.push(pty)
      return pty
    }),
    shell: 'bash',
    shellArgs: ['-l'],
    ...overrides,
  })
  return manager
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-terminal-test-'))
  ptys = []
})

afterEach(async () => {
  manager?.closeAll()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('TerminalManager', () => {
  it('spawns a shell in the workspace and returns an id', () => {
    const spawn = vi.fn(() => {
      const pty = createFakePty()
      ptys.push(pty)
      return pty
    })
    manager = new TerminalManager({ spawn, shell: 'bash', shellArgs: ['-l'] })

    const result = manager.create(tmpDir, 120, 30)

    expect(result.success).toBe(true)
    expect(result.id).toBe('term-1')
    expect(spawn).toHaveBeenCalledWith('bash', ['-l'], expect.objectContaining({
      cwd: tmpDir,
      cols: 120,
      rows: 30,
      name: 'xterm-256color',
    }))
  })

  it('rejects creation without a workspace path', () => {
    makeManager()
    const result = manager.create('', 80, 24)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Workspace')
  })

  it('clamps tiny terminal sizes', () => {
    const spawn = vi.fn(() => {
      const pty = createFakePty()
      ptys.push(pty)
      return pty
    })
    manager = new TerminalManager({ spawn, shell: 'bash' })

    manager.create(tmpDir, 2, 1)

    expect(spawn).toHaveBeenCalledWith('bash', [], expect.objectContaining({
      cols: 20,
      rows: 5,
    }))
  })

  it('forwards writes and resizes to the right terminal', () => {
    makeManager()
    const first = manager.create(tmpDir, 80, 24).id as string
    const second = manager.create(tmpDir, 80, 24).id as string

    expect(manager.write(first, 'ls\r')).toBe(true)
    expect(manager.resize(second, 100, 40)).toBe(true)
    expect(manager.write('missing', 'x')).toBe(false)
    expect(manager.resize('missing', 1, 1)).toBe(false)

    expect(ptys[0].written).toEqual(['ls\r'])
    expect(ptys[0].sized).toEqual([])
    expect(ptys[1].sized).toEqual([[100, 40]])
  })

  it('reports output to the renderer', () => {
    const onData = vi.fn()
    makeManager({ onData })
    const id = manager.create(tmpDir, 80, 24).id as string

    ptys[0].emitData('hello ')
    ptys[0].emitData('world')

    expect(onData).toHaveBeenCalledWith(id, 'hello ')
    expect(onData).toHaveBeenCalledWith(id, 'world')
  })

  it('cleans up when the process exits', () => {
    const onExit = vi.fn()
    makeManager({ onExit })
    const id = manager.create(tmpDir, 80, 24).id as string

    ptys[0].emitExit(0)

    expect(onExit).toHaveBeenCalledWith(id, 0)
    expect(manager.write(id, 'x')).toBe(false)
  })

  it('kills terminals on close and closeAll', () => {
    makeManager()
    const first = manager.create(tmpDir, 80, 24).id as string
    manager.create(tmpDir, 80, 24)

    expect(manager.close(first)).toBe(true)
    expect(ptys[0].killed).toBe(true)
    expect(manager.close(first)).toBe(false)

    manager.closeAll()
    expect(ptys[1].killed).toBe(true)
  })

  it('writes output to the workspace log on flush', async () => {
    const logPath = path.join(tmpDir, '.pi-workbench', 'terminal.log')
    makeManager({ logPathFor: () => logPath })
    const id = manager.create(tmpDir, 80, 24).id as string

    ptys[0].emitData('line one\n')
    expect(manager.flushNow(id)).toBe(true)

    const content = await fs.readFile(logPath, 'utf-8')
    expect(content).toContain(`--- terminal ${id} started at`)
    expect(content).toContain('line one\n')
  })

  it('appends a session marker instead of truncating an existing log', async () => {
    const logPath = path.join(tmpDir, '.pi-workbench', 'terminal.log')
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    await fs.writeFile(logPath, 'old session output', 'utf-8')

    makeManager({ logPathFor: () => logPath })
    manager.create(tmpDir, 80, 24)

    const content = await fs.readFile(logPath, 'utf-8')
    expect(content).toContain('old session output')
    expect(content).toContain('--- terminal term-1 started at')
  })

  it('honors a custom env sanitizer', () => {
    const spawn = vi.fn(
      (_shell: string, _args: string[], _options: { env: NodeJS.ProcessEnv }) => createFakePty()
    )
    manager = new TerminalManager({
      spawn,
      shell: 'bash',
      env: { OPENAI_API_KEY: 'user-owned-key' },
      envSanitizer: (env) => ({ ...env }),
    })

    manager.create(tmpDir, 80, 24)

    expect(spawn.mock.calls[0][2].env.OPENAI_API_KEY).toBe('user-owned-key')
  })

  it('does not pass provider API keys to the terminal process', () => {
    const spawn = vi.fn(
      (_shell: string, _args: string[], _options: { env: NodeJS.ProcessEnv }) => createFakePty()
    )
    manager = new TerminalManager({
      spawn,
      shell: 'bash',
      env: {
        PATH: '/usr/bin',
        PI_WORKBENCH_API_KEY: 'sk-secret',
        PI_CODING_AGENT_DIR: '/agent',
        ANTHROPIC_API_KEY: 'sk-ant',
        OPENAI_API_KEY: 'sk-openai',
        GITHUB_TOKEN: 'ghp-secret',
        NPM_TOKEN: 'npm-secret',
        CUSTOM_PRIVATE_KEY: 'priv-secret',
      },
    })

    manager.create(tmpDir, 80, 24)

    const options = spawn.mock.calls[0][2]
    expect(options.env).toEqual({ PATH: '/usr/bin' })
  })

  it('prunes excess rotated sibling terminal logs when creating a new terminal', async () => {
    const metaDir = path.join(tmpDir, '.pi-workbench')
    await fs.mkdir(metaDir, { recursive: true })
    await fs.writeFile(path.join(metaDir, 'terminal-old.log.1'), 'keep-1')
    await fs.writeFile(path.join(metaDir, 'terminal-old.log.4'), 'excess-4')

    makeManager({
      logPathFor: (ws, id) => path.join(ws, '.pi-workbench', `terminal-${id}.log`),
    })
    manager.create(tmpDir, 80, 24)

    await vi.waitFor(async () => {
      await expect(fs.access(path.join(metaDir, 'terminal-old.log.4'))).rejects.toThrow()
    })
    await expect(fs.access(path.join(metaDir, 'terminal-old.log.1'))).resolves.toBeUndefined()
  })
})

describe('TerminalManager 子进程登记', () => {
  function ptyWithPid(pid: number): FakePty {
    const pty = createFakePty()
    pty.pid = pid
    return pty
  }

  afterEach(() => {
    // 全局登记表在测试之间共享，清干净避免互相影响
    for (const child of childRegistry.list()) childRegistry.unregister(child.pid)
  })

  it('有 pid 的 pty 登记到子进程表，进程退出后注销', () => {
    const pty = ptyWithPid(9_100_001)
    manager = new TerminalManager({ spawn: () => pty, shell: 'bash' })

    const created = manager.create(tmpDir, 80, 24)
    expect(created.success).toBe(true)
    expect(childRegistry.list().map((child) => child.pid)).toEqual([9_100_001])
    expect(childRegistry.list()[0].group).toBe('pty')

    pty.emitExit(0)
    expect(childRegistry.size()).toBe(0)
  })

  it('关闭终端时异步树杀完成后再注销登记，避免提前摘除或阻塞主线程', async () => {
    const pty = ptyWithPid(9_100_002)
    let resolveKill!: (ok: boolean) => void
    const killTree = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveKill = resolve
        })
    )
    manager = new TerminalManager({
      spawn: () => pty,
      shell: 'bash',
      killProcessTreeAsync: killTree,
    })

    const created = manager.create(tmpDir, 80, 24)
    expect(manager.close(created.id!)).toBe(true)

    // 异步树杀完成前不阻塞返回，且保留 childRegistry 登记以便退出看门狗兜底
    expect(killTree).toHaveBeenCalledWith(9_100_002)
    expect(pty.killed).toBe(false)
    expect(childRegistry.size()).toBe(1)

    resolveKill(true)
    await vi.waitFor(() => {
      expect(pty.killed).toBe(true)
      expect(childRegistry.size()).toBe(0)
    })
  })

  it('closeAll 异步并行收尾全部终端，不阻塞事件循环', async () => {
    const p1 = ptyWithPid(9_100_003)
    const p2 = ptyWithPid(9_100_004)
    let index = 0
    const killTree = vi.fn(async () => true)
    manager = new TerminalManager({
      spawn: () => (index++ === 0 ? p1 : p2),
      shell: 'bash',
      killProcessTreeAsync: killTree,
    })
    manager.create(tmpDir, 80, 24)
    manager.create(tmpDir, 80, 24)

    await manager.closeAll()
    expect(killTree).toHaveBeenCalledTimes(2)
    expect(p1.killed).toBe(true)
    expect(p2.killed).toBe(true)
    expect(childRegistry.size()).toBe(0)
  })

  it('并发 flushAsync 使用引用计数保护，onExit 不在异步写进行中并发同步写', async () => {
    const logPath = path.join(tmpDir, '.pi-workbench', 'terminal-race.log')
    makeManager({ logPathFor: () => logPath })
    const id = manager.create(tmpDir, 80, 24).id as string

    ptys[0].emitData('chunk-1\n')
    // 触发第一次异步刷盘
    ;(manager as unknown as { flushAsync: (e: unknown) => void }).flushAsync(
      (manager as unknown as { terminals: Map<string, unknown> }).terminals.get(id)
    )
    ptys[0].emitData('chunk-2\n')
    // 触发第二次并发 flushAsync + 紧接着 onExit
    manager.flushNow(id)
    ptys[0].emitData('chunk-3\n')
    ptys[0].emitExit(0)

    await vi.waitFor(async () => {
      const content = await fs.readFile(logPath, 'utf-8')
      expect(content).toContain('chunk-1\n')
      expect(content).toContain('chunk-2\n')
      expect(content).toContain('chunk-3\n')
    })
  })

  it('没有 pid 的 pty（测试替身 / 未提供）不登记', () => {
    const pty = createFakePty()
    manager = new TerminalManager({ spawn: () => pty, shell: 'bash' })

    manager.create(tmpDir, 80, 24)

    expect(childRegistry.size()).toBe(0)
  })
})
