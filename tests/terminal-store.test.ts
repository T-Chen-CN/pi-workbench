// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeTerminalData, terminalId, terminalReplay, useTerminalStore } from '../src/store/terminalStore'
import { api } from '../src/api'

type DataHandler = (payload: { id: string; data: string }) => void
type ExitHandler = (payload: { id: string; exitCode: number }) => void

const bridge = vi.hoisted(() => ({
  data: null as DataHandler | null,
  exit: null as ExitHandler | null
}))

vi.mock('../src/api', () => ({
  api: {
    terminalCreate: vi.fn(),
    terminalClose: vi.fn(),
    onTerminalData: vi.fn((handler: DataHandler) => {
      bridge.data = handler
      return () => {
        bridge.data = null
      }
    }),
    onTerminalExit: vi.fn((handler: ExitHandler) => {
      bridge.exit = handler
      return () => {
        bridge.exit = null
      }
    })
  }
}))

const create = vi.mocked(api.terminalCreate)

describe('terminalStore', () => {
  beforeEach(() => {
    useTerminalStore.getState().reset()
    vi.clearAllMocks()
    create.mockResolvedValue({ success: true, id: 'pty-1', shell: 'pwsh', logPath: '/logs/pty-1.log' })
  })

  it('spawns one PTY per workspace and reuses it', async () => {
    const store = useTerminalStore.getState()
    store.ensure('/ws', null, 80, 24)
    store.ensure('/ws', null, 80, 24)

    await vi.waitFor(() => expect(terminalId('/ws')).toBe('pty-1'))
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('/ws', 80, 24)
    expect(useTerminalStore.getState().byWorkspace['/ws']).toMatchObject({
      status: 'ready',
      shellName: 'pwsh',
      logPath: '/logs/pty-1.log'
    })
  })

  it('buffers PTY output so a remounted panel can replay it', async () => {
    useTerminalStore.getState().ensure('/ws', null, 80, 24)
    await vi.waitFor(() => expect(bridge.data).not.toBeNull())

    bridge.data?.({ id: 'pty-1', data: 'hello ' })
    bridge.data?.({ id: 'pty-1', data: 'world' })
    // 未知 id（比如刚关掉的 PTY）不落缓冲
    bridge.data?.({ id: 'gone', data: 'ignored' })

    expect(terminalReplay('/ws')).toBe('hello world')
  })

  it('keeps only the tail of the replay buffer', async () => {
    useTerminalStore.getState().ensure('/ws', null, 80, 24)
    await vi.waitFor(() => expect(bridge.data).not.toBeNull())

    const chunk = 'x'.repeat(60_000)
    for (let index = 0; index < 5; index += 1) bridge.data?.({ id: 'pty-1', data: `${chunk}${index}` })

    const replay = terminalReplay('/ws')
    expect(replay.length).toBeLessThanOrEqual(200_000 + chunk.length)
    expect(replay.endsWith('4')).toBe(true)
    expect(replay.startsWith('x')).toBe(true)
  })

  it('forwards live output to subscribers only', async () => {
    const received: string[] = []
    const unsubscribe = subscribeTerminalData('/ws', (chunk) => received.push(chunk))

    useTerminalStore.getState().ensure('/ws', null, 80, 24)
    await vi.waitFor(() => expect(bridge.data).not.toBeNull())
    bridge.data?.({ id: 'pty-1', data: 'live' })
    expect(received).toEqual(['live'])

    unsubscribe()
    bridge.data?.({ id: 'pty-1', data: 'after' })
    expect(received).toEqual(['live'])
  })

  it('marks the terminal as failed when the shell exits', async () => {
    useTerminalStore.getState().ensure('/ws', null, 80, 24)
    await vi.waitFor(() => expect(bridge.exit).not.toBeNull())

    bridge.exit?.({ id: 'pty-1', exitCode: 3 })

    const entry = useTerminalStore.getState().byWorkspace['/ws']
    expect(entry.status).toBe('error')
    expect(entry.error).toContain('3')
    expect(terminalReplay('/ws')).toContain('3')
  })

  it('restarts on a cwd change and closes the previous PTY', async () => {
    useTerminalStore.getState().ensure('/ws', null, 80, 24)
    await vi.waitFor(() => expect(terminalId('/ws')).toBe('pty-1'))

    create.mockResolvedValue({ success: true, id: 'pty-2', shell: 'pwsh' })
    useTerminalStore.getState().ensure('/ws', '/ws/sub', 80, 24)

    await vi.waitFor(() => expect(terminalId('/ws')).toBe('pty-2'))
    expect(api.terminalClose).toHaveBeenCalledWith('pty-1')
    expect(useTerminalStore.getState().byWorkspace['/ws'].cwd).toBe('/ws/sub')
  })

  it('surfaces a localized error when the PTY cannot start', async () => {
    create.mockResolvedValue({ success: false, error: 'spawn failed' })
    useTerminalStore.getState().ensure('/ws', null, 80, 24)

    await vi.waitFor(() => expect(useTerminalStore.getState().byWorkspace['/ws'].status).toBe('error'))
    const entry = useTerminalStore.getState().byWorkspace['/ws']
    expect(entry.id).toBeNull()
    expect(entry.error).toBeTruthy()
    expect(terminalReplay('/ws')).toContain(entry.error as string)
  })

  it('releases the PTY when the workspace closes', async () => {
    useTerminalStore.getState().ensure('/ws', null, 80, 24)
    await vi.waitFor(() => expect(terminalId('/ws')).toBe('pty-1'))

    useTerminalStore.getState().close('/ws')

    expect(api.terminalClose).toHaveBeenCalledWith('pty-1')
    expect(useTerminalStore.getState().byWorkspace['/ws']).toBeUndefined()
    expect(terminalReplay('/ws')).toBe('')
  })
})
