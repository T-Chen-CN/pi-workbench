// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudWorkspaceView } from '../src/components/CloudWorkspaceView'
import { CloudTrace } from '../src/components/CloudTrace'
import { useCloudStore } from '../src/store/cloudStore'
import { useI18nStore } from '../src/store/i18nStore'
import { translations } from '../src/i18n/translations'
import type { CloudFrame, CloudSession, CloudTracePart } from '../src/types/cloud'

const zh = translations.zh

const SESSION: CloudSession = {
  id: 'run_session',
  title: 'Probe session',
  preview: 'hello there',
  lastActive: Date.now() - 60_000,
  startedAt: Date.now() - 120_000,
  messageCount: 4,
  toolCallCount: 2,
  inputTokens: 12_300,
  outputTokens: 400,
  costUsd: 0.0004,
  model: 'deepseek-flash',
  parentSessionId: null,
  pinned: false,
  archived: false,
}

interface BridgeStub {
  frames: Array<(frame: CloudFrame) => void>
  statusListeners: Array<(payload: unknown) => void>
  startRun: ReturnType<typeof vi.fn>
  sessions: CloudSession[]
  parts: CloudTracePart[]
}

function installBridge(overrides: Partial<BridgeStub> = {}): BridgeStub {
  const stub: BridgeStub = {
    frames: [],
    statusListeners: [],
    startRun: vi.fn(async () => ({ success: true, runId: 'run_1', sessionId: 'run_session' })),
    sessions: [SESSION],
    parts: [
      { type: 'text', id: 'h:1', role: 'user', text: 'hello there' },
      { type: 'thinking', id: 'h:2:r', text: 'secret reasoning' },
      { type: 'text', id: 'h:3', role: 'assistant', text: 'hi, done' },
    ],
    ...overrides,
  }

  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    cloudConfigGet: async () => ({
      success: true,
      config: {
        baseUrl: 'https://api.example.com',
        dashboardUrl: 'https://dash.example.com',
        hasToken: true,
      },
    }),
    cloudConfigSet: async () => ({ success: true }),
    cloudConnect: async () => ({
      success: true,
      state: 'connected',
      capabilities: { model: 'deepseek-flash' },
    }),
    cloudDisconnect: async () => ({ success: true }),
    cloudSessionsList: async () => ({ success: true, sessions: stub.sessions, hasMore: false }),
    cloudMessagesList: async () => ({ success: true, parts: stub.parts, hasMore: false }),
    cloudRunStart: stub.startRun,
    cloudRunStatus: async () => ({ success: true, state: 'completed' }),
    cloudRunStop: async () => ({ success: true, state: 'cancelled' }),
    cloudDashboardOpen: async () => ({ success: true }),
    cloudDashboardClose: async () => ({ success: true }),
    cloudDashboardBounds: async () => ({ success: true }),
    cloudDashboardReload: async () => ({ success: true }),
    onCloudEvent: (callback: (frame: CloudFrame) => void) => {
      stub.frames.push(callback)
      return () => {
        stub.frames = stub.frames.filter((item) => item !== callback)
      }
    },
    onCloudStatus: (callback: (payload: unknown) => void) => {
      stub.statusListeners.push(callback)
      return () => {}
    },
    onCloudDashboardLoadFailed: () => () => {},
    onCloudDashboardClosed: () => () => {},
  }
  return stub
}

function resetStore() {
  useCloudStore.setState({
    bridgeAvailable: false,
    connection: 'unconfigured',
    error: null,
    capabilities: null,
    sessions: [],
    sessionsLoading: false,
    sessionsError: null,
    activeSessionId: null,
    sessionMeta: null,
    parts: [],
    partsLoading: false,
    partsError: null,
    runId: null,
    runState: null,
    runError: null,
    pending: null,
    draft: '',
  })
}

beforeEach(() => {
  useI18nStore.getState().setLanguage('zh')
  resetStore()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('CloudTrace', () => {
  it('keeps thinking collapsed until the user opens it', () => {
    render(
      <CloudTrace
        parts={[
          { type: 'text', id: 'h:1', role: 'user', text: 'hello' },
          { type: 'thinking', id: 'h:2:r', text: 'reasoning body' },
        ]}
        streaming={false}
      />
    )

    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.queryByText('reasoning body')).toBeNull()

    fireEvent.click(screen.getByText(zh.cloudThinkingGroup))
    expect(screen.getByText('reasoning body')).toBeTruthy()
  })

  it('expands a tool card to show its result', () => {
    render(
      <CloudTrace
        parts={[
          {
            type: 'tool',
            id: 't:c1',
            toolCallId: 'c1',
            toolName: 'terminal',
            argsSummary: 'ls -la',
            status: 'success',
            resultPreview: 'total 0',
            exitCode: 0,
          },
        ]}
        streaming={false}
      />
    )

    expect(screen.getByText('terminal')).toBeTruthy()
    expect(screen.queryByText('total 0')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /terminal/ }))
    expect(screen.getByText('total 0')).toBeTruthy()
    expect(screen.getByText('exit 0')).toBeTruthy()
  })
})

describe('CloudWorkspaceView', () => {
  it('renders the empty state in the browser (no bridge)', async () => {
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByText(zh.cloudBridgeMissing).length).toBeGreaterThan(0))
  })

  it('lists sessions with tokens and cost', async () => {
    installBridge()
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Probe session')).toBeTruthy())
    expect(screen.getByText('hello there')).toBeTruthy()
    expect(screen.getByText('$0.0004')).toBeTruthy()
  })

  it('keeps both tabs mounted so switching does not lose state', async () => {
    installBridge()
    const onNavigate = vi.fn()
    const view = render(<CloudWorkspaceView view="cloud-session" onNavigate={onNavigate} />)

    await waitFor(() => expect(screen.getByText('Probe session')).toBeTruthy())
    fireEvent.click(screen.getByText(zh.cloudTabConfig))
    expect(onNavigate).toHaveBeenCalledWith('cloud-config')

    // 父组件切到配置页：会话页只是隐藏，DOM 仍在（inert + invisible）
    view.rerender(<CloudWorkspaceView view="cloud-config" onNavigate={onNavigate} />)
    expect(screen.getByText('Probe session')).toBeTruthy()
    expect(screen.getByText(zh.cloudBaseUrl)).toBeTruthy()
  })

  it('sends the draft and renders streamed parts', async () => {
    const stub = installBridge()
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Probe session')).toBeTruthy())

    const textarea = screen.getByPlaceholderText(zh.cloudInputPlaceholder) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'run it' } })
    fireEvent.click(screen.getByText(zh.cloudSend))

    await waitFor(() => expect(stub.startRun).toHaveBeenCalledTimes(1))
    const payload = stub.startRun.mock.calls[0][0] as {
      input: string
      sessionId?: string
      idempotencyKey: string
    }
    expect(payload.input).toBe('run it')
    expect(payload.sessionId).toBeUndefined()
    expect(payload.idempotencyKey).toMatch(/[0-9a-f-]{20,}/)

    await waitFor(() => expect(stub.frames.length).toBe(1))
    stub.frames[0]({ kind: 'session', sessionId: 'run_session' })
    stub.frames[0]({
      kind: 'part',
      part: { type: 'text', id: 's:text:0', role: 'assistant', text: 'streaming answer' },
    })

    await waitFor(() => expect(screen.getByText('streaming answer')).toBeTruthy())
    expect(
      useCloudStore
        .getState()
        .parts.some((part) => part.type === 'text' && part.text === 'run it')
    ).toBe(true)
  })
})
