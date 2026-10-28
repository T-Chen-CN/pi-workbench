// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalPanel } from '../src/components/TerminalPanel'
import { conversationKey, useChatStore } from '../src/store/chatStore'
import { useSessionStore } from '../src/store/sessionStore'
import { useTerminalStore } from '../src/store/terminalStore'
import { useI18nStore } from '../src/store/i18nStore'
import { api } from '../src/api'
import { translations } from '../src/i18n/translations'

const xterm = vi.hoisted(() => ({
  instances: [] as Array<{
    write: ReturnType<typeof vi.fn>
    writeln: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    loadAddon = vi.fn()
    open = vi.fn()
    write = vi.fn()
    writeln = vi.fn()
    reset = vi.fn()
    dispose = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    constructor() {
      xterm.instances.push(this)
    }
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('../src/api', () => ({
  api: {
    terminalCreate: vi.fn(),
    terminalWrite: vi.fn(),
    terminalResize: vi.fn(),
    terminalClose: vi.fn(),
    terminalFlush: vi.fn(),
    onTerminalData: vi.fn(() => () => {}),
    onTerminalExit: vi.fn(() => () => {}),
    exists: vi.fn(),
  },
}))

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  useI18nStore.getState().setLanguage('zh')
  useChatStore.getState().reset()
  useSessionStore.getState().reset()
  useSessionStore.getState().setSessions('/ws', [
    { id: 's1', title: 'Session', messageCount: 0, createdAt: 1, updatedAt: 2 },
  ])
  useSessionStore.getState().setOpen('/ws', ['s1'], 's1')
  useChatStore.getState().ensureConversation(conversationKey('/ws', 's1'))
  xterm.instances.length = 0
  useTerminalStore.getState().reset()
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  vi.mocked(api.terminalCreate).mockResolvedValue({
    success: true,
    id: 't1',
    logPath: '/logs/t1.log',
  })
  vi.mocked(api.terminalWrite).mockResolvedValue({ success: true })
  vi.mocked(api.terminalResize).mockResolvedValue({ success: true })
  vi.mocked(api.terminalClose).mockResolvedValue({ success: true })
  vi.mocked(api.terminalFlush).mockResolvedValue({ success: true })
  vi.mocked(api.onTerminalData).mockReturnValue(() => {})
  vi.mocked(api.onTerminalExit).mockReturnValue(() => {})
  vi.mocked(api.exists).mockResolvedValue({ success: true, exists: true })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('TerminalPanel', () => {
  it('creates a PTY the first time the panel becomes visible', async () => {
    render(<TerminalPanel workspacePath="/ws" visible onClose={vi.fn()} />)

    await waitFor(() => {
      expect(api.terminalCreate).toHaveBeenCalledWith('/ws', 80, 24)
    })
    expect(xterm.instances).toHaveLength(1)
    expect(screen.getByText(translations.zh.terminal)).toBeTruthy()
  })

  it('does not create a PTY while hidden', () => {
    render(<TerminalPanel workspacePath="/ws" visible={false} onClose={vi.fn()} />)

    expect(api.terminalCreate).not.toHaveBeenCalled()
    expect(xterm.instances).toHaveLength(0)
  })

  it('restarts the terminal: closes the old PTY and creates a new one', async () => {
    render(<TerminalPanel workspacePath="/ws" visible onClose={vi.fn()} />)
    await waitFor(() => expect(api.terminalCreate).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByText(translations.zh.restartTerminal))

    await waitFor(() => {
      expect(api.terminalClose).toHaveBeenCalledWith('t1')
      expect(api.terminalCreate).toHaveBeenCalledTimes(2)
    })
  })

  it('attaches the flushed terminal log to the chat context', async () => {
    render(<TerminalPanel workspacePath="/ws" visible onClose={vi.fn()} />)
    await waitFor(() => expect(api.terminalCreate).toHaveBeenCalledTimes(1))

    const attach = screen.getByText(translations.zh.sendTerminalOutput)
    await waitFor(() => expect((attach as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(attach)

    await waitFor(() => {
      expect(api.terminalFlush).toHaveBeenCalledWith('t1')
      expect(
        useChatStore.getState().conversations[conversationKey('/ws', 's1')].attachments[0]
      ).toMatchObject({
        kind: 'file',
        path: '/logs/t1.log',
      })
    })
  })

  it('keeps the PTY across remounts and replays the buffered output', async () => {
    const captured: { handler: ((payload: { id: string; data: string }) => void) | null } = {
      handler: null,
    }
    vi.mocked(api.onTerminalData).mockImplementation((callback) => {
      captured.handler = callback
      return () => {}
    })

    const first = render(<TerminalPanel workspacePath="/ws" visible onClose={vi.fn()} />)
    await waitFor(() => expect(api.terminalCreate).toHaveBeenCalledTimes(1))

    captured.handler?.({ id: 't1', data: 'before-detach' })
    first.unmount()

    // 拆回主窗口：组件在另一个 document 里重新挂载
    render(<TerminalPanel workspacePath="/ws" visible onClose={vi.fn()} />)

    expect(api.terminalCreate).toHaveBeenCalledTimes(1)
    expect(api.terminalClose).not.toHaveBeenCalled()
    expect(xterm.instances[1]?.write).toHaveBeenCalledWith('before-detach')
  })

  it('writes incoming PTY data to the terminal', async () => {
    const captured: { handler: ((payload: { id: string; data: string }) => void) | null } = {
      handler: null,
    }
    vi.mocked(api.onTerminalData).mockImplementation((callback) => {
      captured.handler = callback
      return () => {}
    })

    render(<TerminalPanel workspacePath="/ws" visible onClose={vi.fn()} />)
    await waitFor(() => expect(api.terminalCreate).toHaveBeenCalledTimes(1))

    captured.handler?.({ id: 't1', data: 'hello' })
    expect(xterm.instances[0].write).toHaveBeenCalledWith('hello')
  })
})
