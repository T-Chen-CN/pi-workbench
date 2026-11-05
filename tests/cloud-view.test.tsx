// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudWorkspaceView } from '../src/components/CloudWorkspaceView'
import { CloudJobsView } from '../src/components/CloudJobsView'
import { CloudTrace } from '../src/components/CloudTrace'
import { CloudApprovalCard } from '../src/components/CloudApprovalCard'
import { CloudModeSwitch } from '../src/components/CloudModeSwitch'
import { useCloudStore } from '../src/store/cloudStore'
import { UNCONFIGURED_CONNECTION } from '../src/api/cloud'
import { useI18nStore } from '../src/store/i18nStore'
import { translations } from '../src/i18n/translations'
import type {
  CloudFrame,
  CloudSession,
  CloudTracePart,
} from '../src/types/cloud'

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
  handoffPick: ReturnType<typeof vi.fn>
  handoffApply: ReturnType<typeof vi.fn>
  handoffCopy: ReturnType<typeof vi.fn>
  sessions: CloudSession[]
  parts: CloudTracePart[]
}

function installBridge(overrides: Partial<BridgeStub> = {}): BridgeStub {
  const stub: BridgeStub = {
    frames: [],
    statusListeners: [],
    startRun: vi.fn(async () => ({ success: true, runId: 'run_1', sessionId: 'run_session' })),
    handoffPick: vi.fn(async () => ({ success: true, canceled: true })),
    handoffApply: vi.fn(async () => ({ success: true })),
    handoffCopy: vi.fn(async () => ({ success: true })),
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
        hasDashboardToken: false,
        dashboardUser: '',
        hasDashboardPassword: false,
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
    cloudHandoffPick: stub.handoffPick,
    cloudHandoffApply: stub.handoffApply,
    cloudHandoffCopy: stub.handoffCopy,
    cloudSessionsUpdate: async (input: { sessionId: string; title?: string; pinned?: boolean }) => ({
      success: true,
      session: { ...stub.sessions[0], ...input },
    }),
    cloudSessionsDelete: async () => ({ success: true, deleted: true }),
    cloudMessagesList: async () => ({ success: true, parts: stub.parts, hasMore: false }),
    cloudRunStart: stub.startRun,
    cloudRunStatus: async () => ({ success: true, state: 'completed' }),
    cloudApprovalRespond: vi.fn(async () => ({ success: true, choice: 'once' })),
    cloudPolicyGet: vi.fn(async () => ({
      success: true,
      policy: {
        mode: 'manual',
        timeoutSeconds: 120,
        denyCount: 0,
        disabledToolsets: ['code_execution'],
        terminalBackend: 'local',
      },
    })),
    cloudPolicySet: vi.fn(async (input: { mode: string }) => ({
      success: true,
      policy: {
        mode: input.mode,
        timeoutSeconds: 120,
        denyCount: 0,
        disabledToolsets: ['code_execution'],
        terminalBackend: 'local',
      },
    })),
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

/** 直接拿装好的桥接替身：断言某个 IPC 有没有被调用 */
function bridge(): Record<string, unknown> {
  return (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI
}

function resetStore() {
  useCloudStore.setState({
    bridgeAvailable: false,
    hydrated: false,
    config: UNCONFIGURED_CONNECTION,
    dashboard: { visible: false, loading: false, url: '', error: null },
    pendingDisconnect: null,
    connection: 'unconfigured',
    error: null,
    capabilities: null,
    sessions: [],
    sessionsLoading: false,
    sessionsLoadingMore: false,
    sessionsHasMore: false,
    sessionQuery: '',
    sessionActionPending: null,
    sessionsSyncedAt: null,
    syncing: false,
    sessionsError: null,
    activeSessionId: null,
    sessionMeta: null,
    parts: [],
    partsLoading: false,
    partsError: null,
    runId: null,
    runState: null,
    runError: null,
    steerError: null,
    resolveError: null,
    resolvingUnknown: false,
    pendingWrites: [],
    ledgerError: null,
    jobs: [],
    jobsLoading: false,
    jobsError: null,
    jobActionPending: null,
    clarifyPending: null,
    clarifyError: null,
    approvalPending: null,
    approvalError: null,
    policy: null,
    policyLoading: false,
    policyError: null,
    policyPending: null,
    diagnostics: null,
    diagnosticsLoading: false,
    diagnosticsError: null,
    pending: null,
    draft: '',
    handoffPreview: null,
    handoffBusy: null,
    handoffError: null,
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

  it('marks the timeline where a run was reattached after a restart', () => {
    render(
      <CloudTrace
        parts={[
          { type: 'text', id: 'h:1', role: 'user', text: 'hello' },
          { type: 'divider', id: 'reattach:run_1', kind: 'reattach' },
        ]}
        streaming={false}
      />
    )

    expect(screen.getByText(zh.cloudReattachDivider)).toBeTruthy()
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

  it('keeps every tab mounted so switching does not lose state', async () => {
    installBridge()
    const onNavigate = vi.fn()
    const view = render(<CloudWorkspaceView view="cloud-session" onNavigate={onNavigate} />)

    await waitFor(() => expect(screen.getByText('Probe session')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: zh.cloudTabConnection }))
    expect(onNavigate).toHaveBeenCalledWith('cloud-connection')

    // 父组件切到连接页：会话页只是隐藏，DOM 仍在（inert + invisible）
    view.rerender(<CloudWorkspaceView view="cloud-connection" onNavigate={onNavigate} />)
    expect(screen.getByText('Probe session')).toBeTruthy()
    expect(screen.getByText(zh.cloudBaseUrl)).toBeTruthy()

    view.rerender(<CloudWorkspaceView view="cloud-console" onNavigate={onNavigate} />)
    expect(screen.getByText(zh.cloudBaseUrl)).toBeTruthy()
  })

  it('opens the console when the console tab becomes active', async () => {
    const stub = installBridge()
    const openSpy = vi.fn(async () => ({ success: true }))
    const boundsSpy = vi.fn(async () => ({ success: true }))
    ;(
      window as unknown as { electronAPI: Record<string, unknown> }
    ).electronAPI.cloudDashboardOpen = openSpy
    ;(
      window as unknown as { electronAPI: Record<string, unknown> }
    ).electronAPI.cloudDashboardBounds = boundsSpy

    render(<CloudWorkspaceView view="cloud-console" onNavigate={vi.fn()} />)

    await waitFor(() => expect(openSpy).toHaveBeenCalled())
    await waitFor(() => expect(boundsSpy).toHaveBeenCalled())
    expect(stub.startRun).not.toHaveBeenCalled()
  })

  it('points at the connection tab when the console has no key', async () => {
    const stub = installBridge()
    ;(
      window as unknown as { electronAPI: Record<string, unknown> }
    ).electronAPI.cloudConfigGet = async () => ({
      success: true,
      config: {
        baseUrl: 'https://api.example.com',
        dashboardUrl: 'https://dash.example.com',
        hasToken: false,
      },
    })
    const onNavigate = vi.fn()
    render(<CloudWorkspaceView view="cloud-console" onNavigate={onNavigate} />)

    await waitFor(() => expect(screen.getByText(zh.cloudConsoleNeedsConnection)).toBeTruthy())
    // 会话页与本页都提供「去连接」入口，点哪个都到连接页
    fireEvent.click(screen.getAllByText(zh.cloudGoToConnection)[0])
    expect(onNavigate).toHaveBeenCalledWith('cloud-connection')
    expect(stub.startRun).not.toHaveBeenCalled()
  })

  it('lands on the connection tab when nothing is configured yet', async () => {
    installBridge()
    ;(
      window as unknown as { electronAPI: Record<string, unknown> }
    ).electronAPI.cloudConfigGet = async () => ({
      success: true,
      config: {
        baseUrl: 'https://api.example.com',
        dashboardUrl: 'https://dash.example.com',
        hasToken: false,
      },
    })
    const onNavigate = vi.fn()
    render(<CloudWorkspaceView view="cloud-session" onNavigate={onNavigate} />)

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('cloud-connection'))
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

describe('会话条目操作', () => {
  it('renames a session inline and sends the new title', async () => {
    installBridge()
    const update = vi.fn(async (input: { sessionId: string; title?: string }) => ({
      success: true,
      session: { ...SESSION, title: input.title ?? SESSION.title },
    }))
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.cloudSessionsUpdate =
      update

    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Probe session')).toBeTruthy())

    fireEvent.click(screen.getByLabelText(zh.cloudSessionActions))
    fireEvent.click(screen.getAllByText(zh.cloudRename)[0])

    const input = screen.getByLabelText(zh.cloudRename)
    fireEvent.change(input, { target: { value: 'Renamed session' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(update).toHaveBeenCalledWith({ sessionId: SESSION.id, title: 'Renamed session' }))
    await waitFor(() => expect(screen.getByText('Renamed session')).toBeTruthy())
  })

  it('asks for confirmation before deleting and warns it cannot be undone', async () => {
    installBridge()
    const remove = vi.fn(async () => ({ success: true, deleted: true }))
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.cloudSessionsDelete =
      remove

    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Probe session')).toBeTruthy())

    fireEvent.click(screen.getByLabelText(zh.cloudSessionActions))
    fireEvent.click(screen.getAllByText(zh.cloudDelete)[0])

    // 确认框里必须写明不可恢复，并且此时还没有发请求
    expect(screen.getByText(zh.cloudDeleteBody)).toBeTruthy()
    expect(remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText(zh.cloudDeleteConfirm))
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ sessionId: SESSION.id }))
  })

  it('toggles pin from the row menu', async () => {
    installBridge()
    const update = vi.fn(async () => ({ success: true, session: { ...SESSION, pinned: true } }))
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.cloudSessionsUpdate =
      update

    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Probe session')).toBeTruthy())

    fireEvent.click(screen.getByLabelText(zh.cloudSessionActions))
    fireEvent.click(screen.getByText(zh.cloudPin))

    await waitFor(() => expect(update).toHaveBeenCalledWith({ sessionId: SESSION.id, pinned: true }))
  })
})

describe('会话搜索与分页', () => {
  it('filters the loaded list locally and shows the scope', async () => {
    installBridge({
      sessions: [SESSION, { ...SESSION, id: 'run_other', title: 'Another one', preview: 'x' }],
    })
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Another one')).toBeTruthy())

    fireEvent.change(screen.getByLabelText(zh.cloudSearchSessions), {
      target: { value: 'probe' },
    })
    await waitFor(() => expect(screen.queryByText('Another one')).toBeNull())
    expect(screen.getByText('Probe session')).toBeTruthy()
    expect(
      screen.getByText(zh.cloudSearchScope.replace('{matched}', '1').replace('{loaded}', '2'))
    ).toBeTruthy()
  })

  it('shows a load-more button only while the server reports more pages', async () => {
    installBridge()
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.cloudSessionsList =
      async () => ({ success: true, sessions: [SESSION], hasMore: false })

    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Probe session')).toBeTruthy())
    expect(screen.queryByText(zh.cloudLoadMore)).toBeNull()
    expect(screen.getByText(zh.cloudAllLoaded)).toBeTruthy()
  })
})

describe('图片', () => {
  it('renders a thumbnail for /image directives and hides the raw path', async () => {
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudMediaRead: async () => ({ success: true, dataUrl: 'data:image/png;base64,AAAA' }),
    }
    render(
      <CloudTrace
        streaming={false}
        parts={[
          {
            type: 'text',
            id: 'h:1',
            role: 'user',
            text: ['/image /srv/img/a.png', '这是什么？'].join('\n'),
          },
        ]}
      />
    )
    const thumb = await waitFor(() => screen.getByLabelText(zh.cloudImageOpen))
    expect(thumb.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(screen.queryByText('/image /srv/img/a.png')).toBeNull()
    expect(screen.getByText('这是什么？')).toBeTruthy()
  })

  it('renders an agent MEDIA tag as a picture instead of a raw path', async () => {
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudMediaRead: async () => ({ success: true, dataUrl: 'data:image/png;base64,BBBB' }),
    }
    render(
      <CloudTrace
        streaming={false}
        parts={[
          {
            type: 'text',
            id: 'a:1',
            role: 'assistant',
            text: ['页面已打开，title 是 Example。', '', 'MEDIA:/srv/shots/shot.png'].join(String.fromCharCode(10)),
          },
        ]}
      />
    )
    const thumb = await waitFor(() => screen.getByLabelText(zh.cloudImageOpen))
    expect(thumb.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,BBBB')
    // 路径不该以正文形式露出来
    expect(screen.queryByText(/MEDIA:\/srv\/shots\/shot\.png/)).toBeNull()
    expect(screen.getByText(/页面已打开/)).toBeTruthy()
  })

  it('leaves non-image MEDIA tags alone', async () => {
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudMediaRead: async () => ({ success: false, error: 'nope' }),
    }
    render(
      <CloudTrace
        streaming={false}
        parts={[
          { type: 'text', id: 'a:2', role: 'assistant', text: '报告好了 MEDIA:/srv/report.pdf' },
        ]}
      />
    )
    await waitFor(() => expect(screen.getByText(/MEDIA:\/srv\/report\.pdf/)).toBeTruthy())
    expect(screen.queryByLabelText(zh.cloudImageOpen)).toBeNull()
  })
  it('degrades to a label when the console cannot serve the bytes', async () => {
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      cloudMediaRead: async () => ({ success: false, error: 'no token' }),
    }
    render(
      <CloudTrace
        streaming={false}
        parts={[
          { type: 'text', id: 'h:2', role: 'user', text: '/image /srv/img/b.png' },
        ]}
      />
    )
    await waitFor(() => expect(screen.getByText(zh.cloudImageUnavailable)).toBeTruthy())
  })
})

describe('多端同步', () => {
  it('refreshes the list on a timer while the page is visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      installBridge()
      const list = vi.fn(async () => ({ success: true, sessions: [SESSION], hasMore: false }))
      ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.cloudSessionsList =
        list

      render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1))

      await vi.advanceTimersByTimeAsync(15_000)
      expect(list.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling when the page is switched away', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      installBridge()
      const list = vi.fn(async () => ({ success: true, sessions: [SESSION], hasMore: false }))
      ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.cloudSessionsList =
        list

      const { rerender } = render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
      rerender(<CloudWorkspaceView view="cloud-connection" onNavigate={vi.fn()} />)
      const before = list.mock.calls.length
      await vi.advanceTimersByTimeAsync(45_000)
      expect(list.mock.calls.length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('丢失主人的轮次', () => {
  it('shows the acknowledge bar only for an unknown run and reports success', async () => {
    installBridge()
    const resolve = vi.fn(async () => ({ success: true, state: 'cancelled' }))
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI
      .cloudRunResolveUnknown = resolve

    useCloudStore.setState({ runId: 'run_lost', runState: 'unknown', resolveError: null })
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)

    const ack = await waitFor(() => screen.getByText(zh.cloudResolveUnknown))
    expect(screen.getByText(zh.cloudRunLostBody)).toBeTruthy()
    fireEvent.click(ack)
    await waitFor(() => expect(resolve).toHaveBeenCalledWith({ runId: 'run_lost' }))
    await waitFor(() => expect(useCloudStore.getState().runState).toBe('cancelled'))
  })
})

describe('未结算账本', () => {
  it('shows the badge only when something is unresolved and opens the drawer', async () => {
    installBridge()
    useCloudStore.setState({
      runId: null,
      runState: null,
      pendingWrites: [
        {
          id: 'run_1:c1',
          runId: 'run_1',
          sessionId: 's1',
          toolName: 'terminal',
          writeClass: 'external',
          summary: 'git push origin main',
          startedAt: Date.now(),
          status: 'unknown',
        },
      ],
    })
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)

    const badge = await waitFor(() => screen.getByText(zh.cloudLedgerBadge.replace('{count}', '1')))
    fireEvent.click(badge)
    expect(await screen.findByText('git push origin main')).toBeTruthy()
    expect(screen.getByText(zh.cloudLedgerDidIt)).toBeTruthy()
  })

  it('keeps an entry point when nothing is pending, so a note can be logged', async () => {
    installBridge()
    useCloudStore.setState({ pendingWrites: [] })
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    // 没有待核对项时不显示计数，但入口还在（否则第一次永远打不开）
    expect(screen.queryByText(zh.cloudLedgerBadge.replace('{count}', '0'))).toBeNull()
    fireEvent.click(await screen.findByLabelText(zh.cloudLedgerOpen))
    expect(await screen.findByText(zh.cloudLedgerEmpty)).toBeTruthy()
  })
})

describe('子代理轨道', () => {
  it('renders a subagent card and explains the missing track in history', async () => {
    installBridge()
    useCloudStore.setState({
      runState: null,
      parts: [
        {
          type: 'subagent',
          id: 'sa:sa_1',
          goal: '查 Caddy 版本',
          status: 'completed',
          summary: 'v2.11.7',
          durationMs: 4300,
          toolCount: 2,
        },
        { type: 'tool', id: 't1', toolCallId: 'c1', toolName: 'delegate_task', argsSummary: '', status: 'success' },
      ],
    })
    const first = render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    expect(await screen.findByText('查 Caddy 版本')).toBeTruthy()
    // 有子代理卡片时不提示缺轨道
    expect(screen.queryByText(zh.cloudSubagentHistoryHint)).toBeNull()
    first.unmount()

    useCloudStore.setState({
      parts: [
        { type: 'tool', id: 't1', toolCallId: 'c1', toolName: 'delegate_task', argsSummary: '', status: 'success' },
      ],
    })
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    expect(await screen.findByText(zh.cloudSubagentHistoryHint)).toBeTruthy()
  })
})

describe('任务页', () => {
  const JOB = {
    id: 'job_1',
    name: '每日日志汇总',
    prompt: '汇总昨天的日志',
    schedule: '0 9 * * *',
    scheduleDisplay: '每天 9 点',
    state: 'scheduled',
    enabled: true,
    nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
  }

  it('lists jobs with schedule and next run, and can pause / run', async () => {
    installBridge()
    const pause = vi.fn(async () => ({ success: true }))
    const run = vi.fn(async () => ({ success: true }))
    const list = vi.fn(async () => ({ success: true, jobs: [JOB] }))
    Object.assign((window as unknown as { electronAPI: Record<string, unknown> }).electronAPI, {
      cloudJobsList: list,
      cloudJobsPause: pause,
      cloudJobsRun: run,
    })
    useCloudStore.setState({ connection: 'connected', jobs: [JOB], jobsLoading: false })

    render(<CloudWorkspaceView view="cloud-jobs" onNavigate={vi.fn()} />)
    expect(await screen.findByText('每日日志汇总')).toBeTruthy()
    expect(screen.getByText('每天 9 点')).toBeTruthy()

    fireEvent.click(screen.getByText(zh.cloudJobPause))
    await waitFor(() => expect(pause).toHaveBeenCalledWith({ jobId: 'job_1' }))

    // 未暂停的任务：直接跑
    fireEvent.click(screen.getByText(zh.cloudJobRunNow))
    await waitFor(() => expect(run).toHaveBeenCalledWith({ jobId: 'job_1' }))
  })

  it('shows the empty state with the create-from-conversation hint', async () => {
    installBridge()
    Object.assign((window as unknown as { electronAPI: Record<string, unknown> }).electronAPI, {
      cloudJobsList: async () => ({ success: true, jobs: [] }),
    })
    useCloudStore.setState({ connection: 'connected', jobs: [], jobsLoading: false })
    render(<CloudWorkspaceView view="cloud-jobs" onNavigate={vi.fn()} />)
    expect(await screen.findByText(zh.cloudJobEmptyHint)).toBeTruthy()
  })

  it('sends you to the connection page when not connected', async () => {
    installBridge()
    useCloudStore.setState({ connection: 'unconfigured' })
    render(<CloudWorkspaceView view="cloud-jobs" onNavigate={vi.fn()} />)
    expect(await screen.findByText(zh.cloudJobNeedsConnectionHint)).toBeTruthy()
  })
})

describe('自检面板', () => {
  it('loads on expand and shows one failing section without hiding the rest', async () => {
    installBridge()
    const load = vi.fn(async () => {
      useCloudStore.setState({
        diagnostics: {
          fetchedAt: Date.now(),
          version: '0.22.6',
          platform: 'hermes-agent',
          gatewayState: 'running',
          readiness: { ok: true, checks: [{ name: 'model', status: 'ok' }] },
          toolsets: {
            ok: true,
            items: [
              { name: 'terminal', label: 'Terminal', enabled: true, configured: true, tools: ['terminal'] },
              { name: 'browser', label: 'Browser', enabled: true, configured: false, tools: [] },
            ],
          },
          skills: { ok: false, error: 'Failed to enumerate skills', names: [] },
          models: { ok: true, items: ['pi-cloud'] },
        },
      })
    })
    Object.assign((window as unknown as { electronAPI: Record<string, unknown> }).electronAPI, {
      cloudDiagnostics: load,
    })
    useCloudStore.setState({
      connection: 'connected',
      config: { ...UNCONFIGURED_CONNECTION, baseUrl: 'https://api.example.com', hasToken: true },
    })

    render(<CloudWorkspaceView view="cloud-connection" onNavigate={vi.fn()} />)
    fireEvent.click(await screen.findByText(zh.cloudDiagnostics))
    await waitFor(() => expect(load).toHaveBeenCalled())

    expect(await screen.findByText(zh.cloudDiagnosticsSkills)).toBeTruthy()
    expect(screen.getByText('Failed to enumerate skills')).toBeTruthy()
    // 缺依赖的工具集要单独标出来，不能和"关掉了"混在一起
    expect(screen.getByText(zh.cloudDiagnosticsNotConfigured)).toBeTruthy()
    expect(screen.getByText('pi-cloud')).toBeTruthy()
    // 关掉的不占行，只在末尾汇总一行；计数只算启用的
    expect(screen.getByText(zh.cloudDiagnosticsEnabledCount.replace('{count}', '2'))).toBeTruthy()
  })
})

describe('clarify 提问卡', () => {
  const CLARIFY = {
    type: 'clarify' as const,
    id: 'c:cl_1',
    promptId: 'cl_1',
    generation: 4,
    question: '要发布到哪个环境？',
    choices: ['staging', 'production'],
  }

  it('offers the choices and sends the picked one', async () => {
    installBridge()
    const respond = vi.fn(async () => ({ success: true }))
    Object.assign((window as unknown as { electronAPI: Record<string, unknown> }).electronAPI, {
      cloudClarifyRespond: respond,
    })
    useCloudStore.setState({ runState: 'running', parts: [CLARIFY] })

    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    expect(await screen.findByText('要发布到哪个环境？')).toBeTruthy()
    fireEvent.click(screen.getByText('production'))
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith({
        requestId: 'cl_1',
        generation: 4,
        answer: 'production',
      })
    )
    // 已答状态：答案显示出来，选项消失
    await waitFor(() => expect(screen.queryByText('staging')).toBeNull())
    expect(screen.getByText('production')).toBeTruthy()
  })

  it('takes a free-text answer when there are no choices', async () => {
    installBridge()
    const respond = vi.fn(async () => ({ success: true }))
    Object.assign((window as unknown as { electronAPI: Record<string, unknown> }).electronAPI, {
      cloudClarifyRespond: respond,
    })
    useCloudStore.setState({
      runState: 'running',
      parts: [{ ...CLARIFY, choices: [], question: '要写在哪？' }],
    })
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)

    const input = await screen.findByLabelText(zh.cloudClarifyAnswer)
    fireEvent.change(input, { target: { value: '/tmp/out.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith({
        requestId: 'cl_1',
        generation: 4,
        answer: '/tmp/out.md',
      })
    )
  })

  it('keeps the card open and shows why when the answer is rejected', async () => {
    installBridge()
    Object.assign((window as unknown as { electronAPI: Record<string, unknown> }).electronAPI, {
      cloudClarifyRespond: async () => ({ success: false, error: '提问已失效' }),
    })
    useCloudStore.setState({ runState: 'running', parts: [CLARIFY] })
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)

    fireEvent.click(await screen.findByText('staging'))
    expect(await screen.findByText('提问已失效')).toBeTruthy()
    // 答案撤回，选项还在
    expect(screen.getByText('production')).toBeTruthy()
  })

  it('does not pretend we answered a prompt settled elsewhere', async () => {
    installBridge()
    useCloudStore.setState({
      runState: 'running',
      parts: [{ ...CLARIFY, settled: true }],
    })
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    expect(await screen.findByText(zh.cloudClarifySettledElsewhere)).toBeTruthy()
    expect(screen.queryByText('staging')).toBeNull()
  })
})

describe('任务页：暂停任务点「现在跑一次」', () => {
  const PAUSED = {
    id: 'job_p',
    name: '演示任务',
    prompt: '',
    schedule: '0 3 1 1 *',
    scheduleDisplay: '0 3 1 1 *',
    state: 'paused',
    enabled: false,
  }

  // 单独挂这个视图：整页外壳会跑 hydrate，把连接态改掉、顺带卸载任务列表
  const renderJobs = () => render(<CloudJobsView active onNavigate={vi.fn()} />)

  it('warns first, because the server resumes the schedule as a side effect', async () => {
    installBridge()
    const run = vi.fn(async () => ({ success: true }))
    const list = vi.fn(async () => ({ success: true, jobs: [PAUSED] }))
    Object.assign((window as unknown as { electronAPI: Record<string, unknown> }).electronAPI, {
      cloudJobsList: list,
      cloudJobsRun: run,
    })
    useCloudStore.setState({ connection: 'connected', jobs: [PAUSED], hydrated: true })
    renderJobs()

    const button = await screen.findByRole('button', { name: zh.cloudJobRunNow })
    fireEvent.click(button)
    expect(await screen.findByText(zh.cloudJobRunPausedTitle)).toBeTruthy()
    // 点确认之前不发请求
    expect(run).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText(zh.cloudJobRunPausedConfirm))
    await waitFor(() => expect(run).toHaveBeenCalledWith({ jobId: 'job_p' }))
  })
})

describe('审批卡', () => {
  const part = (
    overrides: Partial<Extract<CloudTracePart, { type: 'approval' }>> = {}
  ): Extract<CloudTracePart, { type: 'approval' }> => ({
    type: 'approval',
    id: 'a:ap_1',
    requestId: 'ap_1',
    command: 'rm -rf build',
    patternKeys: ['rm -rf'],
    choices: ['once', 'session', 'deny'],
    ...overrides,
  })

  it('offers exactly the three choices and never `always`', () => {
    installBridge()
    render(<CloudApprovalCard part={part()} />)

    expect(screen.getByText(zh.cloudApprovalOnce)).toBeTruthy()
    expect(screen.getByText(zh.cloudApprovalSession)).toBeTruthy()
    expect(screen.getByText(zh.cloudApprovalDeny)).toBeTruthy()
    expect(screen.queryByText(/always|永久/i)).toBeNull()
    expect(screen.getByText('rm -rf build')).toBeTruthy()
    // 命中的规则要摆出来：这是「为什么问我」的依据
    expect(screen.getByText('rm -rf')).toBeTruthy()
  })

  it('submits the choice the user clicked', async () => {
    installBridge()
    const respond = bridge().cloudApprovalRespond as ReturnType<typeof vi.fn>
    const target = part()
    useCloudStore.setState({
      parts: [target],
      runId: 'run_1',
      activeSessionId: 'run_session',
    })
    render(<CloudApprovalCard part={target} />)

    fireEvent.click(screen.getByText(zh.cloudApprovalSession))
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'ap_1', choice: 'session', runId: 'run_1' })
      )
    )
    // 卡片在真实链路里由 store 驱动：决定要落回 store 的那一份
    await waitFor(() => {
      const stored = useCloudStore.getState().parts[0]
      expect(stored.type === 'approval' && stored.decision).toBe('session')
    })
  })

  it('greys out an expired card instead of letting it be clicked', () => {
    installBridge()
    render(<CloudApprovalCard part={part({ expiredAt: Date.now() })} />)

    expect(screen.queryByText(zh.cloudApprovalOnce)).toBeNull()
    expect(screen.getByText(zh.cloudApprovalExpiredBody)).toBeTruthy()
  })

  it('says so when another client resolved it', () => {
    installBridge()
    render(<CloudApprovalCard part={part({ settled: true })} />)

    expect(screen.queryByText(zh.cloudApprovalOnce)).toBeNull()
    expect(screen.getByText(zh.cloudApprovalSettledElsewhere)).toBeTruthy()
  })

  it('shows the chosen decision after the fact', () => {
    installBridge()
    render(<CloudApprovalCard part={part({ decision: 'deny', decidedAt: Date.now() })} />)
    expect(screen.getByText(zh.cloudApprovalDeny)).toBeTruthy()
    expect(screen.getByText(zh.cloudApprovalYouChose)).toBeTruthy()
  })
})

describe('审批档位控件', () => {
  const policy = (mode: 'manual' | 'smart' | 'off' | null) => ({
    mode,
    timeoutSeconds: 120,
    denyCount: 0,
    disabledToolsets: ['code_execution'],
    terminalBackend: 'local',
  })

  it('shows the server mode and switches tighter in one click', async () => {
    installBridge()
    const setPolicy = bridge().cloudPolicySet as ReturnType<typeof vi.fn>
    bridge().cloudPolicyGet = async () => ({ success: true, policy: policy('off') })
    useCloudStore.setState({ policy: policy('off') })
    render(<CloudModeSwitch />)

    expect(await screen.findByText(zh.cloudModeOffWarn)).toBeTruthy()
    const tighter = screen.getByText(zh.cloudModeManual).closest('button') as HTMLButtonElement
    await waitFor(() => expect(tighter.disabled).toBe(false))
    fireEvent.click(tighter)
    await waitFor(() => expect(setPolicy).toHaveBeenCalledWith({ mode: 'manual' }))
  })

  it('asks for a second confirmation before turning approvals off', async () => {
    installBridge()
    const setPolicy = bridge().cloudPolicySet as ReturnType<typeof vi.fn>
    useCloudStore.setState({ policy: policy('manual') })
    render(<CloudModeSwitch />)

    const off = (await screen.findByText(zh.cloudModeOff)).closest('button') as HTMLButtonElement
    await waitFor(() => expect(off.disabled).toBe(false))
    fireEvent.click(off)
    // 第一次点击只开确认框，不能直接写服务端
    expect(setPolicy).not.toHaveBeenCalled()
    expect(await screen.findByText(zh.cloudModeOffConfirmBody)).toBeTruthy()

    fireEvent.click(screen.getByText(zh.cloudModeOffConfirmAction))
    await waitFor(() => expect(setPolicy).toHaveBeenCalledWith({ mode: 'off' }))
  })

  it('shows the effective policy values and the known blind spots', async () => {
    installBridge()
    useCloudStore.setState({ connection: 'connected' })
    render(<CloudWorkspaceView view="cloud-connection" onNavigate={vi.fn()} />)

    expect(await screen.findByText(zh.cloudPolicyTitle)).toBeTruthy()
    // 生效值来自服务端读回，不是本地记的
    await waitFor(() =>
      expect(screen.getByText(zh.cloudPolicySeconds.replace('{seconds}', '120'))).toBeTruthy()
    )
    expect(screen.getByText('code_execution')).toBeTruthy()
    // 盲区必须写出来：审批不是沙箱
    expect(screen.getByText(zh.cloudPolicyRisk)).toBeTruthy()
  })

  it('shows the error and stops spinning when the read fails', async () => {
    installBridge()
    bridge().cloudPolicyGet = async () => ({ success: false, error: '控制台超时' })
    useCloudStore.setState({ policy: null })
    render(<CloudModeSwitch />)

    expect(await screen.findByText('控制台超时')).toBeTruthy()
    // 读不到档位不能卡在 loading：按钮必须回到可点（并保留「我们不知道现在是什么」）
    await waitFor(() => expect(useCloudStore.getState().policyLoading).toBe(false))
    expect(useCloudStore.getState().policyPending).toBeNull()
    expect(screen.queryByText(zh.cloudModeOffWarn)).toBeNull()
  })

  it('does not invent a mode the server did not report', async () => {
    installBridge()
    bridge().cloudPolicyGet = async () => ({ success: true, policy: policy(null) })
    useCloudStore.setState({ policy: null })
    render(<CloudModeSwitch />)

    expect(await screen.findByText(zh.cloudModeUnknown)).toBeTruthy()
    expect(screen.queryByText(zh.cloudModeOffWarn)).toBeNull()
  })

  it('clears pending and reports the error when a switch rejects', async () => {
    installBridge()
    bridge().cloudPolicySet = async () => {
      throw new Error("Error invoking remote method 'cloud:policy:set': No handler registered")
    }
    useCloudStore.setState({ policy: policy('manual') })
    render(<CloudModeSwitch />)

    const off = (await screen.findByText(zh.cloudModeOff)).closest('button') as HTMLButtonElement
    await waitFor(() => expect(off.disabled).toBe(false))
    fireEvent.click(off)
    fireEvent.click(await screen.findByText(zh.cloudModeOffConfirmAction))

    await waitFor(() => expect(useCloudStore.getState().policyPending).toBeNull())
    // 老主进程会直接 reject：必须落成人话，且档位不被改成「已生效」
    expect(await screen.findByText(/主进程还没更新/)).toBeTruthy()
    expect(useCloudStore.getState().policy?.mode).toBe('manual')
  })
})
