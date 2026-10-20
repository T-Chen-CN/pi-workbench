import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { TerminalManager, type PtyProcess } from '../electron/terminal-manager'

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
        ANTHROPIC_API_KEY: 'sk-ant',
        OPENAI_API_KEY: 'sk-openai',
      },
    })

    manager.create(tmpDir, 80, 24)

    const options = spawn.mock.calls[0][2]
    expect(options.env.PATH).toBe('/usr/bin')
    expect(options.env.PI_WORKBENCH_API_KEY).toBeUndefined()
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(options.env.OPENAI_API_KEY).toBeUndefined()
  })
})
