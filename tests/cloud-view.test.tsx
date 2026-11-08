// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudWorkspaceView } from '../src/components/CloudWorkspaceView'
import { CloudConnectionView } from '../src/components/CloudConnectionView'
import { CloudJobsView } from '../src/components/CloudJobsView'
import { CloudTrace } from '../src/components/CloudTrace'
import { CloudApprovalCard } from '../src/components/CloudApprovalCard'
import { CloudModeSwitch } from '../src/components/CloudModeSwitch'
import { useCloudStore } from '../src/store/cloudStore'
import { UNCONFIGURED_CONNECTION } from '../src/api/cloud'
import { useI18nStore } from '../src/store/i18nStore'
import { translations } from '../src/i18n/translations'
import type {
  CloudDashboardBounds,
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
  deviceGet: ReturnType<typeof vi.fn>
  config?: Record<string, unknown>
  gatewayStatus: ReturnType<typeof vi.fn>
  gatewayPair: ReturnType<typeof vi.fn>
  gatewayRevoke: ReturnType<typeof vi.fn>
  deviceSet: ReturnType<typeof vi.fn>
  deviceReprobe: ReturnType<typeof vi.fn>
  clipboard: string[]
  sessions: CloudSession[]
  parts: CloudTracePart[]
  heartbeatListeners: Array<(payload: unknown) => void>
  revokedListeners: Array<(payload: unknown) => void>
}

function installBridge(overrides: Partial<BridgeStub> = {}): BridgeStub {
  const stub: BridgeStub = {
    frames: [],
    statusListeners: [],
    startRun: vi.fn(async () => ({ success: true, runId: 'run_1', sessionId: 'run_session' })),
    deviceGet: vi.fn(async () => ({
      success: true,
      device: { id: 'd1e2f3a4-0000-4000-8000-000000000000', name: 'TChen-Legion', defaultName: 'TChen-Legion' },
    })),
    deviceReprobe: vi.fn(async () => ({
      success: true,
      device: {
        id: 'd1e2f3a4-0000-4000-8000-000000000000',
        name: 'TChen-Legion-2',
        defaultName: 'TChen-Legion-2',
      },
    })),
    deviceSet: vi.fn(async (input: { name: string }) => ({
      success: true,
      device: {
        id: 'd1e2f3a4-0000-4000-8000-000000000000',
        name: input.name.trim() || 'TChen-Legion',
        defaultName: 'TChen-Legion',
      },
    })),
    gatewayStatus: vi.fn(async () => ({
      success: true,
      registered: false,
      gatewayUrl: 'https://hub.example.com',
      device: { id: 'd1e2f3a4-0000-4000-8000-000000000000', name: 'TChen-Legion', defaultName: 'TChen-Legion' },
    })),
    gatewayPair: vi.fn(async () => ({
      success: true,
      name: 'TChen-Legion',
    })),
    gatewayRevoke: vi.fn(async () => ({ success: true })),
    clipboard: [],
    sessions: [SESSION],
    heartbeatListeners: [],
    revokedListeners: [],
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
        gatewayUrl: 'https://hub.example.com',
        dashboardUrl: 'https://dash.example.com',
        hasDeviceToken: true,
        deviceScopes: ['chat', 'dispatch'],
        deviceId: 'dev-1',
        ...(overrides.config as object | undefined),
      },
    }),
    cloudDeviceGet: stub.deviceGet,
    cloudDeviceSet: stub.deviceSet,
    cloudDeviceReprobe: stub.deviceReprobe,
    cloudGatewayStatus: () => stub.gatewayStatus(),
    cloudGatewayPair: stub.gatewayPair,
    cloudGatewayRevoke: stub.gatewayRevoke,
    writeClipboardText: (text: string) => {
      stub.clipboard.push(text)
      return true
    },
    cloudConnect: async () => ({
      success: true,
      state: 'connected',
      capabilities: { model: 'deepseek-flash' },
    }),
    cloudDisconnect: async () => ({ success: true }),
    cloudSessionsList: async () => ({ success: true, sessions: stub.sessions, hasMore: false }),
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
    onCloudGatewayHeartbeat: (callback: (payload: unknown) => void) => {
      stub.heartbeatListeners.push(callback)
      return () => {
        stub.heartbeatListeners = stub.heartbeatListeners.filter((item) => item !== callback)
      }
    },
    onCloudGatewayRevoked: (callback: (payload: unknown) => void) => {
      stub.revokedListeners.push(callback)
      return () => {
        stub.revokedListeners = stub.revokedListeners.filter((item) => item !== callback)
      }
    },
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
    gateway: null,
    gatewayBusy: false,
    gatewayError: null,
    pairBusy: false,
    pairError: null,
    pairErrorCode: null,
    gatewayNotice: null,
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
    device: null,
    deviceBusy: false,
    deviceError: null,
    pending: null,
    draft: '',
    focusRequestId: null,
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
    // 连接页现在只剩「网关 / 设备 / 控制台令牌」，不再有 API 地址输入
    expect(screen.getByText(zh.cloudGatewayTitle)).toBeTruthy()

    view.rerender(<CloudWorkspaceView view="cloud-console" onNavigate={onNavigate} />)
    expect(screen.getByText(zh.cloudGatewayTitle)).toBeTruthy()
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

  it('hides the native layer when the console page unmounts', async () => {
    installBridge()
    const boundsSpy = vi.fn(async (_bounds: CloudDashboardBounds) => ({ success: true }))
    ;(
      window as unknown as { electronAPI: Record<string, unknown> }
    ).electronAPI.cloudDashboardBounds = boundsSpy
    // jsdom 里所有矩形都是 0：铺一块真实尺寸，页签才会报 visible:true
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 34,
      width: 1200,
      height: 766,
      top: 34,
      left: 0,
      right: 1200,
      bottom: 800,
      toJSON: () => ({}),
    } as DOMRect)

    try {
      const view = render(<CloudWorkspaceView view="cloud-console" onNavigate={vi.fn()} />)
      await waitFor(() => {
        const calls = boundsSpy.mock.calls
        const last = calls[calls.length - 1]?.[0] as { visible: boolean } | undefined
        expect(last?.visible).toBe(true)
      })

      // 切到本地工作区：整个云视图被摘掉（App.tsx），没人再推边界
      view.unmount()
      await waitFor(() => {
        const calls = boundsSpy.mock.calls
        const last = calls[calls.length - 1]?.[0] as { visible: boolean } | undefined
        expect(last?.visible).toBe(false)
      })
    } finally {
      rectSpy.mockRestore()
    }
  })

  it('points at the connection tab when the console has no key', async () => {
    const stub = installBridge()
    ;(
      window as unknown as { electronAPI: Record<string, unknown> }
    ).electronAPI.cloudConfigGet = async () => ({
      success: true,
      config: {
        dashboardUrl: 'https://dash.example.com',
        hasDeviceToken: false,
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
        dashboardUrl: 'https://dash.example.com',
        hasDeviceToken: false,
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

describe('排队中的轮次', () => {
  it('shows queued instead of running and blocks steering', async () => {
    installBridge()
    useCloudStore.setState({
      activeSessionId: SESSION.id,
      sessionMeta: SESSION,
      runId: 'run_q',
      runState: 'queued',
      parts: [{ type: 'text', id: 'h:1', role: 'user', text: 'hello' }],
    })
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)

    expect(await screen.findByText(zh.cloudRunQueued)).toBeTruthy()
    expect(screen.queryByText(zh.cloudToolRunning)).toBeNull()
    // 排队时后端会拒绝插话：按钮应当是禁用的
    const steer = screen.getByText(zh.cloudSteer).closest('button')
    expect(steer?.hasAttribute('disabled')).toBe(true)
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

  it('creates a job from the form and closes it on success', async () => {
    installBridge()
    const create = vi.fn(async () => ({ success: true, job: { ...JOB, id: 'job_2' } }))
    Object.assign((window as unknown as { electronAPI: Record<string, unknown> }).electronAPI, {
      cloudJobsList: async () => ({ success: true, jobs: [] }),
      cloudJobsCreate: create,
    })
    useCloudStore.setState({ connection: 'connected', jobs: [], jobsLoading: false })

    render(<CloudWorkspaceView view="cloud-jobs" onNavigate={vi.fn()} />)
    // 首帧会先拉列表、空状态随之重建一次节点：等它稳定再点，否则点到的是被换掉的旧按钮
    expect(await screen.findByText(zh.cloudJobEmpty)).toBeTruthy()
    fireEvent.click(screen.getByText(zh.cloudJobCreate))
    expect(await screen.findByText(zh.cloudJobCreateTitle)).toBeTruthy()

    // 三项必填都空时提交按钮不可用
    const submit = screen.getByText(zh.cloudJobCreateSubmit) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(zh.cloudJobCreateName), { target: { value: '每日日志汇总' } })
    fireEvent.change(screen.getByLabelText(zh.cloudJobCreateSchedule), { target: { value: '0 9 * * *' } })
    fireEvent.change(screen.getByLabelText(zh.cloudJobCreatePrompt), { target: { value: '汇总昨天的日志' } })
    fireEvent.click(screen.getByText(zh.cloudJobCreateSubmit))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: '每日日志汇总',
        schedule: '0 9 * * *',
        prompt: '汇总昨天的日志',
      })
    )
    await waitFor(() => expect(screen.queryByText(zh.cloudJobCreateTitle)).toBeNull())
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
      config: { ...UNCONFIGURED_CONNECTION, hasDeviceToken: true, deviceId: 'dev-1' },
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

describe('通知点击定位', () => {
  const approvalPart: CloudTracePart = {
    type: 'approval',
    id: 'a:ap_9',
    requestId: 'ap_9',
    command: 'rm -rf build',
    patternKeys: ['rm -rf'],
    choices: ['once', 'session', 'deny'],
  }

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('scrolls the notified card into view and consumes the intent', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView')
    installBridge({
      parts: [
        approvalPart,
        { type: 'text', id: 'h:9', role: 'assistant', text: 'done' }
      ]
    })
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Probe session')).toBeTruthy())
    fireEvent.click(screen.getByText('Probe session'))
    await waitFor(() => expect(screen.getByText('rm -rf build')).toBeTruthy())

    await act(async () => {
      useCloudStore.getState().requestFocus('ap_9')
    })

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    // 意图是一次性的：滚过就清掉，后续新消息不应该再把视口扯回去
    expect(useCloudStore.getState().focusRequestId).toBeNull()
  })

  it('keeps the intent while the card is not rendered yet', async () => {
    installBridge()
    render(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Probe session')).toBeTruthy())

    await act(async () => {
      useCloudStore.getState().requestFocus('ap_missing')
    })

    // 历史还在路上：找不到锚点就不能把意图吃掉，否则这张卡永远不会被定位
    expect(useCloudStore.getState().focusRequestId).toBe('ap_missing')
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

describe('CloudConnectionView 心跳', () => {
  it('shows the heartbeat result on the gateway card', async () => {
    const stub = installBridge()
    stub.gatewayStatus = vi.fn(async () => ({
      success: true,
      registered: true,
      gatewayUrl: 'https://hub.example.com',
      deviceId: 'd1e2f3a4-0000-4000-8000-000000000000',
      name: 'TChen-Legion',
      scopes: ['chat', 'dispatch'],
      hub: '0.1.0',
      online: true,
      upstreamVersion: '0.22.6',
    }))
    await useCloudStore.getState().loadGateway()
    render(<CloudConnectionView active />)

    // 还没打出去
    expect(await screen.findByText(zh.cloudGatewayHeartbeatPending)).toBeTruthy()

    act(() => {
      for (const listener of stub.heartbeatListeners) {
        listener({ lastOkAt: Date.now(), lastError: null, stoppedBecauseRevoked: false })
      }
    })
    const ok = await screen.findByText(new RegExp(zh.cloudGatewayHeartbeatOk))
    expect(ok.textContent).toContain(zh.cloudGatewayHeartbeatJustNow)
  })

  it('restores the last heartbeat state from the gateway status after a missed push', async () => {
    installBridge({
      gatewayStatus: vi.fn(async () => ({
        success: true,
        registered: true,
        gatewayUrl: 'https://hub.example.com',
        deviceId: 'd1e2f3a4-0000-4000-8000-000000000000',
        name: 'TChen-Legion',
        scopes: ['chat', 'dispatch'],
        hub: '0.1.0',
        online: true,
        upstreamVersion: '0.22.6',
        heartbeat: { lastOkAt: Date.now(), lastError: null, stoppedBecauseRevoked: false },
      })),
    })
    await useCloudStore.getState().loadGateway()
    render(<CloudConnectionView active />)
    expect(await screen.findByText(new RegExp(zh.cloudGatewayHeartbeatOk))).toBeTruthy()
  })

  it('turns the connection into an error when the cloud revokes us', async () => {
    const stub = installBridge()
    stub.gatewayStatus = vi.fn(async () => ({
      success: true,
      registered: false,
      gatewayUrl: 'https://hub.example.com',
      device: { id: 'd1e2f3a4-0000-4000-8000-000000000000', name: 'TChen-Legion', defaultName: 'TChen-Legion' },
    }))
    useCloudStore.setState({ connection: 'connected', sessions: [SESSION], activeSessionId: 'run_session' })
    render(<CloudConnectionView active />)
    await screen.findByText(zh.cloudGatewayTitle)

    act(() => {
      for (const listener of stub.revokedListeners) {
        listener({ reason: 'device_revoked: token is no longer valid' })
      }
    })

    await waitFor(() => expect(useCloudStore.getState().connection).toBe('error'))
    expect(useCloudStore.getState().error).toContain('重新配对')
    expect(useCloudStore.getState().sessions).toEqual([])
    expect(useCloudStore.getState().heartbeat?.stoppedBecauseRevoked).toBe(true)
  })
})

describe('CloudConnectionView 配对表单', () => {
  it('keeps the last used gateway in a labelled hint, never as a fake default', async () => {
    installBridge({
      config: { gatewayUrl: 'https://hub.my-own.host' },
      // 注销后的形态：本地还留着地址，但网关侧已经没这台设备了
      gatewayStatus: vi.fn(async () => ({
        success: true,
        registered: false,
        gatewayUrl: 'https://hub.my-own.host',
        online: true,
      })),
    })
    await useCloudStore.getState().hydrate()
    render(<CloudConnectionView active />)

    const input = screen.getByLabelText(zh.cloudPairGatewayAdvanced) as HTMLInputElement
    // 输入框是空的，灰字永远是示例地址——不会让人以为代码里内置了某个域名
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('https://hub.example.com')

    // 上次配对用的地址单独一行说清来路（带 url，不是伪装成默认值）
    expect(
      await screen.findByText(
        zh.cloudPairGatewayLastUsed.replace('{url}', 'https://hub.my-own.host')
      )
    ).toBeTruthy()

    fireEvent.click(screen.getByText(zh.cloudPairGatewayUseLast))
    await waitFor(() => expect(input.value).toBe('https://hub.my-own.host'))
    // 填进来之后这行说明就收掉，不再挡着
    expect(screen.queryByText(zh.cloudPairGatewayUseLast)).toBeNull()
  })
})

describe('CloudConnectionView 设备卡', () => {
  it('shows the device name and id, and only writes when 保存 is pressed', async () => {
    const stub = installBridge()
    // 真实应用里 hydrate() 会拉一次设备身份；这里直接拉，省掉整个外壳
    await useCloudStore.getState().loadDevice()
    render(<CloudConnectionView active />)

    const input = await screen.findByLabelText(zh.cloudDeviceName)
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('TChen-Legion'))
    expect(screen.getByText('d1e2f3a4-0000-4000-8000-000000000000')).toBeTruthy()

    // 没改过：保存按钮不可用，失焦也不写盘
    const save = screen.getByText(zh.cloudDeviceSave).closest('button') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.blur(input)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stub.deviceSet).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '客厅那台' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() => expect(stub.deviceSet).toHaveBeenCalledWith({ name: '客厅那台' }))
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('客厅那台'))
  })

  it('restores the system default name with 恢复默认名', async () => {
    const stub = installBridge()
    await useCloudStore.getState().loadDevice()
    await useCloudStore.getState().setDeviceName('客厅那台')
    render(<CloudConnectionView active />)

    const input = await screen.findByLabelText(zh.cloudDeviceName)
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('客厅那台'))

    fireEvent.click(screen.getByText(zh.cloudDeviceRestore))
    await waitFor(() => expect(stub.deviceSet).toHaveBeenLastCalledWith({ name: '' }))
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('TChen-Legion'))
  })

  it('follows a system rename only when 重新读取系统名 is pressed', async () => {
    const stub = installBridge()
    await useCloudStore.getState().loadDevice()
    render(<CloudConnectionView active />)
    const input = await screen.findByLabelText(zh.cloudDeviceName)
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('TChen-Legion'))

    fireEvent.click(screen.getByText(zh.cloudDeviceReprobe))
    await waitFor(() => expect(stub.deviceReprobe).toHaveBeenCalledTimes(1))
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('TChen-Legion-2'))
  })

  it('says the preload is stale instead of showing a fake device name', async () => {
    installBridge()
    // 有 preload、但还没有 cloudDeviceGet：改主进程后没重启应用
    const api = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI
    delete api.cloudDeviceGet
    delete api.cloudDeviceSet

    await useCloudStore.getState().loadDevice()
    render(<CloudConnectionView active />)
    // 设备卡与网关卡都会报 stale，这里只看「设备名输入框没有出现」
    expect((await screen.findAllByText(/重启应用/)).length).toBeGreaterThan(0)
    expect(screen.queryByLabelText(zh.cloudDeviceName)).toBeNull()
  })

  it('pairs with a full link and connects without exposing a token', async () => {
    const stub = installBridge()
    render(<CloudConnectionView active />)

    const codeInput = await screen.findByLabelText(zh.cloudPairCode)
    fireEvent.change(codeInput, {
      target: { value: 'https://hub.example.com/#pair=ABCDE-FGHIJ' },
    })
    fireEvent.click(screen.getByText(zh.cloudPairConnect))

    await waitFor(() =>
      expect(stub.gatewayPair).toHaveBeenCalledWith({
        code: 'ABCDEFGHIJ',
        gatewayUrl: 'https://hub.example.com',
      })
    )
    expect(await screen.findByText(/已配对：TChen-Legion/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('pi_abcdefghij')

    await waitFor(() => expect(useCloudStore.getState().config.hasDeviceToken).toBe(true))
    await waitFor(() => expect(useCloudStore.getState().connection).toBe('connected'))
  })

  it('uses the gateway draft for a bare code', async () => {
    const stub = installBridge()
    render(<CloudConnectionView active />)

    fireEvent.change(await screen.findByLabelText(zh.cloudPairGatewayAdvanced), {
      target: { value: 'https://self-hosted.example.com' },
    })
    fireEvent.change(screen.getByLabelText(zh.cloudPairCode), {
      target: { value: 'abcde-fghij' },
    })
    fireEvent.click(screen.getByText(zh.cloudPairConnect))

    await waitFor(() =>
      expect(stub.gatewayPair).toHaveBeenCalledWith({
        code: 'ABCDEFGHIJ',
        gatewayUrl: 'https://self-hosted.example.com',
      })
    )
  })

  it('requires a gateway address in the UI when nothing is configured', async () => {
    // 网关地址没有内置默认值：未配置时输入框只给占位符，地址栏显示「未设置」
    const { container } = render(<CloudConnectionView active />)
    expect(await screen.findByText(zh.cloudGatewayNotSet)).toBeTruthy()
    const gatewayInput = container.querySelector('#cloud-pair-gateway') as HTMLInputElement
    expect(gatewayInput.placeholder).toBe('https://hub.example.com')
  })

  it('refuses a bare code without a gateway address', async () => {
    const stub = installBridge()
    render(<CloudConnectionView active />)

    fireEvent.change(await screen.findByLabelText(zh.cloudPairCode), {
      target: { value: 'ABCDE-FGHIJ' },
    })
    fireEvent.click(screen.getByText(zh.cloudPairConnect))

    // 直接报「还没有可用的网关地址」，且不往主进程发请求
    expect(await screen.findByText(zh.cloudPairBadGateway)).toBeTruthy()
    expect(stub.gatewayPair).not.toHaveBeenCalled()
  })

  it('shows an expired-code reason from the server', async () => {
    installBridge({
      gatewayPair: vi.fn(async () => ({
        success: false,
        error: '连接码已过期',
        code: 'pairing_expired' as const,
      })),
    })
    render(<CloudConnectionView active />)

    // 没有内置网关地址：先填地址，再填码（只给码会被判“没有可用地址”）
    fireEvent.change(await screen.findByLabelText(zh.cloudPairGatewayAdvanced), {
      target: { value: 'https://hub.example.com' },
    })
    fireEvent.change(await screen.findByLabelText(zh.cloudPairCode), {
      target: { value: 'EXPIRED001' },
    })
    fireEvent.click(screen.getByText(zh.cloudPairConnect))

    expect(await screen.findByText(zh.cloudPairExpired)).toBeTruthy()
  })

  it('tells the user to upgrade an old plugin', async () => {
    installBridge({
      gatewayPair: vi.fn(async () => ({
        success: false,
        error: '网关没有配对接口',
        code: 'pairing_unsupported' as const,
      })),
    })
    render(<CloudConnectionView active />)

    fireEvent.change(await screen.findByLabelText(zh.cloudPairGatewayAdvanced), {
      target: { value: 'https://hub.example.com' },
    })
    fireEvent.change(await screen.findByLabelText(zh.cloudPairCode), {
      target: { value: 'OLDPLUGIN' },
    })
    fireEvent.click(screen.getByText(zh.cloudPairConnect))

    expect(await screen.findByText(zh.cloudPairPluginOutdated)).toBeTruthy()
  })

  it('shows the registered state with scopes and upstream version', async () => {
    installBridge({
      gatewayStatus: vi.fn(async () => ({
        success: true,
        registered: true,
        gatewayUrl: 'https://hub.example.com',
        deviceId: 'b8235e0e-a459-4bad-95a2-5d0585a613fc',
        name: 'TChen-Legion',
        scopes: ['chat', 'dispatch'],
        hub: '0.1.0',
        online: true,
        upstream: 'http://127.0.0.1:8642',
        upstreamVersion: '0.22.6',
        devices: { total: 1, active: 1, revoked: 0 },
      }))
    })
    await useCloudStore.getState().loadGateway()
    render(<CloudConnectionView active />)
    expect(await screen.findByText(zh.cloudGatewayRegistered)).toBeTruthy()
    expect(screen.getByText(/chat \/ dispatch/)).toBeTruthy()
    expect(screen.getByText(/0\.22\.6/)).toBeTruthy()
    expect(screen.queryByLabelText(zh.cloudPairCode)).toBeNull()
  })

  it('warns when the device is registered but the cloud agent is down', async () => {
    installBridge({
      gatewayStatus: vi.fn(async () => ({
        success: true,
        registered: true,
        gatewayUrl: 'https://hub.example.com',
        deviceId: 'b8235e0e',
        name: 'TChen-Legion',
        scopes: ['chat'],
        online: false,
        upstreamVersion: '',
      }))
    })
    await useCloudStore.getState().loadGateway()
    render(<CloudConnectionView active />)
    expect(await screen.findByText(zh.cloudGatewayUpstreamDown)).toBeTruthy()
  })

  it('treats a registered device with no token as revoked, not unconfigured', async () => {
    // 登记过但 token 已经没了 = 被注销
    installBridge({
      config: { deviceId: 'b8235e0e', hasDeviceToken: false },
    })
    await useCloudStore.getState().hydrate()
    const state = useCloudStore.getState()
    expect(state.connection).toBe('error')
    expect(state.error).toMatch(/注销/)
  })

  it('locks the cloud view right after revoking', async () => {
    installBridge()
    // 主进程注销时已经清掉 token：这里让 getConfig 如实反映，验证渲染层跟着刷新
    ;(
      window as unknown as { electronAPI: Record<string, unknown> }
    ).electronAPI.cloudConfigGet = async () => ({
      success: true,
      config: { ...UNCONFIGURED_CONNECTION },
    })
    useCloudStore.setState({
      connection: 'connected',
      capabilities: { runStop: true } as never,
      sessions: [{ id: 's1' } as never],
    })
    await useCloudStore.getState().revokeGateway()
    const state = useCloudStore.getState()
    expect(state.connection).toBe('error')
    expect(state.error).toMatch(/注销/)
    // 能力与会话一起清掉：注销之后不该还能看到「已连接」
    expect(state.capabilities).toBeNull()
    expect(state.sessions).toHaveLength(0)
    // config 也要刷新：否则「重新连接 / 断开连接」还按 hasDeviceToken=true 显示
    expect(state.config.hasDeviceToken).toBe(false)
  })

  it('revokes the device from the card', async () => {
    const stub = installBridge({
      gatewayStatus: vi.fn(async () => ({
        success: true,
        registered: true,
        gatewayUrl: 'https://hub.example.com',
        deviceId: 'b8235e0e',
        name: 'TChen-Legion',
        scopes: ['chat', 'dispatch'],
        online: true,
      }))
    })
    await useCloudStore.getState().loadGateway()
    render(<CloudConnectionView active />)
    fireEvent.click(await screen.findByText(zh.cloudGatewayRevoke))
    await waitFor(() => expect(stub.gatewayRevoke).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('这台设备已注销')).toBeTruthy()
  })

  it('copies the device id through the electron clipboard', async () => {
    const stub = installBridge()
    await useCloudStore.getState().loadDevice()
    render(<CloudConnectionView active />)
    await screen.findByLabelText(zh.cloudDeviceName)

    fireEvent.click(screen.getByText(zh.copyCode))
    await waitFor(() =>
      expect(stub.clipboard).toContain('d1e2f3a4-0000-4000-8000-000000000000')
    )
  })
})
