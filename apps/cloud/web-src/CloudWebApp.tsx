import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cloud, PanelRightClose, PanelRightOpen, X } from 'lucide-react'
import { BrandSeal } from '../../../src/components/BrandSeal'
import { CloudTraceSection } from '../../../src/components/CloudTraceSection'
import { StreamdownView } from '../../../src/components/StreamdownView'
import {
  StreamingTranscript,
  type StreamingTranscriptHandle,
} from '../../../src/components/StreamingTranscript'
import { StatusText, Tab } from '../../../src/components/patterns'
import { Button, Caption, DataText, EmptyState, Field, Input, Textarea } from '../../../src/components/ui'
import {
  ACTIVE_TASK_STATUSES,
  AGENT_STATUS_LABELS,
  INITIAL_WEB_SESSION_STATE,
  apiRequest,
  applyTheme,
  applyWebFrame,
  formatTime,
  resolveInitialTheme,
  type CloudChatRow,
  type CloudDocItem,
  type CloudDreamItem,
  type CloudMemoryItem,
  type WebCatalogModel,
  type WebCloudConfig,
  type WebConfigDraft,
  type WebMe,
  type WebPairCode,
  type WebSessionState,
  type WebTab,
  type WebTheme,
  type WebWsStatus,
} from './cloudWebClient'
import {
  AuthCard,
  ConfigCard,
  ConfirmPlanModal,
  DeviceCard,
  MemoryTab,
  NoticeCard,
  TaskCard,
  UnitCard,
} from './CloudWebCards'

const TABS: ReadonlyArray<{ id: WebTab; label: string }> = [
  { id: 'chat', label: '会话' },
  { id: 'tasks', label: '工单' },
  { id: 'devices', label: '设备' },
  { id: 'memory', label: '记忆' },
  { id: 'settings', label: '设置' },
]

const WebChatMessageRow = React.memo(function WebChatMessageRow({
  message,
}: {
  message: CloudChatRow
}) {
  const isUser = message.role === 'user'
  return (
    <article
      className={
        isUser
          ? 'flex flex-col gap-1 border-l-2 border-accent pl-3'
          : 'flex flex-col gap-1 border-l-2 border-rule-divide pl-3'
      }
    >
      <div className="flex items-center gap-2 type-caption text-ink-muted">
        <span className="type-eyebrow">{isUser ? 'YOU' : 'CLOUD'}</span>
        <span className="type-data">{formatTime(message.at)}</span>
        {message.streaming && (
          <span
            aria-label="输出中"
            className="msg-streaming h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
          />
        )}
      </div>
      {!isUser && (
        <CloudTraceSection
          messageId={message.id}
          thinking={message.thinking}
          thinkingRedacted={message.thinkingRedacted}
          thinkingDurationMs={message.thinkingDurationMs}
          traces={message.traces}
          isStreaming={Boolean(message.streaming)}
          hasBodyText={Boolean(message.text.trim())}
          language="zh"
        />
      )}
      {message.text &&
        (isUser ? (
          <p className="m-0 whitespace-pre-wrap break-words type-body text-ink">{message.text}</p>
        ) : (
          <div className="chat-markdown text-ink">
            <StreamdownView
              content={message.text}
              isStreaming={Boolean(message.streaming)}
              showCursor={Boolean(message.streaming)}
              highlight={message.text.length <= 20_000}
              language="zh"
            />
          </div>
        ))}
      {message.error && <DataText className="text-danger">{message.error}</DataText>}
    </article>
  )
})

const SetupView: React.FC<{
  onDone: () => void
  request: <T = any>(method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; payload: T | null }>
}> = ({ onDone, request }) => {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy) return
    if (password.length < 8) {
      setError('密码至少 8 位')
      return
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await request<{ error?: string }>('POST', '/v1/setup', { password })
      if (!result.ok) {
        setError(result.payload?.error || '创建失败')
        return
      }
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center overflow-y-auto bg-surface p-6">
      <div className="flex w-full max-w-sm flex-col gap-4 border border-line bg-raised p-6 shadow-print">
        <div className="flex items-center gap-2.5">
          <BrandSeal size={24} className="brand-seal" />
          <h1 className="m-0 type-subtitle text-ink">Pi Cloud</h1>
        </div>
        <Caption className="text-ink-muted">首次使用：创建唯一的管理员账号。</Caption>
        <Field label="密码" htmlFor="setup-password">
          <Input
            id="setup-password"
            type="password"
            autoComplete="new-password"
            placeholder="至少 8 位"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field label="确认密码" htmlFor="setup-confirm">
          <Input
            id="setup-confirm"
            type="password"
            autoComplete="new-password"
            placeholder="再输入一次"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                void submit()
              }
            }}
          />
        </Field>
        {error && <Caption className="text-danger">{error}</Caption>}
        <Button variant="primary" size="md" disabled={busy} onClick={() => void submit()}>
          创建管理员账号
        </Button>
      </div>
    </div>
  )
}

const LoginView: React.FC<{
  notice: string
  onLoggedIn: (me: WebMe) => void
  request: <T = any>(method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; payload: T | null }>
}> = ({ notice, onLoggedIn, request }) => {
  const [password, setPassword] = useState('')
  const [error, setError] = useState(notice)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setError(notice)
  }, [notice])

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await request('POST', '/v1/login', { password })
      if (!result.ok) {
        setError(result.status === 429 ? '尝试过于频繁，稍后再试' : '密码不正确')
        return
      }
      const me = await request<WebMe>('GET', '/v1/me')
      if (me.ok && me.payload) {
        onLoggedIn(me.payload)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center overflow-y-auto bg-surface p-6">
      <div className="flex w-full max-w-sm flex-col gap-4 border border-line bg-raised p-6 shadow-print">
        <div className="flex items-center gap-2.5">
          <BrandSeal size={24} className="brand-seal" />
          <h1 className="m-0 type-subtitle text-ink">Pi Cloud</h1>
        </div>
        <Caption className="text-ink-muted">登录云端控制台。</Caption>
        <Field label="密码" htmlFor="login-password">
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                void submit()
              }
            }}
            autoFocus
          />
        </Field>
        {error && <Caption className="text-danger">{error}</Caption>}
        <Button variant="primary" size="md" disabled={busy} onClick={() => void submit()}>
          登录
        </Button>
      </div>
    </div>
  )
}

export const CloudWebApp: React.FC = () => {
  const [view, setView] = useState<'loading' | 'setup' | 'login' | 'app'>('loading')
  const [me, setMe] = useState<WebMe | null>(null)
  const [loginNotice, setLoginNotice] = useState('')
  const [theme, setTheme] = useState<WebTheme>(() => resolveInitialTheme())

  const [tab, setTab] = useState<WebTab>('chat')
  const [asideCollapsed, setAsideCollapsed] = useState(false)
  const [wsStatus, setWsStatus] = useState<WebWsStatus>('closed')
  const [session, setSession] = useState<WebSessionState>(INITIAL_WEB_SESSION_STATE)

  const [draft, setDraft] = useState('')
  const [confirmPlanOpen, setConfirmPlanOpen] = useState(false)
  const [pairCode, setPairCode] = useState<WebPairCode | null>(null)
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({})
  const [instructionDrafts, setInstructionDrafts] = useState<Record<string, string>>({})
  const [bannerError, setBannerError] = useState<string | null>(null)

  const [config, setConfig] = useState<WebCloudConfig | null>(null)
  const [configDraft, setConfigDraft] = useState<WebConfigDraft | null>(null)
  const [configModels, setConfigModels] = useState<WebCatalogModel[]>([])
  const [configFeedback, setConfigFeedback] = useState('')

  const [memories, setMemories] = useState<CloudMemoryItem[]>([])
  const [docs, setDocs] = useState<CloudDocItem[]>([])
  const [dreams, setDreams] = useState<CloudDreamItem[]>([])
  const [docDrafts, setDocDrafts] = useState<Record<string, string>>({})
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [memoryLoaded, setMemoryLoaded] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelayRef = useRef(1000)
  const lastSeqRef = useRef(0)
  const unreadRef = useRef(0)
  const tabRef = useRef<WebTab>(tab)
  const authenticatedRef = useRef(false)
  const composingRef = useRef(false)
  const transcriptRef = useRef<StreamingTranscriptHandle | null>(null)
  const collapseAsideRef = useRef<HTMLButtonElement | null>(null)
  const expandAsideRef = useRef<HTMLButtonElement | null>(null)

  tabRef.current = tab
  lastSeqRef.current = session.lastSeq
  unreadRef.current = session.unreadCount
  authenticatedRef.current = view === 'app'

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const closeSocket = useCallback(() => {
    clearReconnectTimer()
    const current = wsRef.current
    wsRef.current = null
    if (current) {
      try {
        current.close()
      } catch {
        // 忽略关闭异常
      }
    }
    setWsStatus('closed')
  }, [clearReconnectTimer])

  const showExpired = useCallback(
    (nextMe?: WebMe) => {
      closeSocket()
      setConfirmPlanOpen(false)
      setMe(nextMe ?? { hasAccount: true, authenticated: false })
      setLoginNotice('登录已过期，请重新登录。')
      setView('login')
    },
    [closeSocket]
  )

  const handleUnauthorized = useCallback(async () => {
    const check = await apiRequest<WebMe>('GET', '/v1/me')
    if (check.ok && check.payload && !check.payload.authenticated) {
      showExpired(check.payload)
    }
  }, [showExpired])

  const request = useCallback(
    <T = any,>(method: string, path: string, body?: unknown) =>
      apiRequest<T>(method, path, body, () => {
        void handleUnauthorized()
      }),
    [handleUnauthorized]
  )

  const pushLocalNotice = useCallback((level: 'info' | 'warn' | 'error', text: string) => {
    if (level === 'error') setBannerError(text)
    setSession((prev) => ({
      ...prev,
      notices: [{ level, text, at: Date.now() }, ...prev.notices].slice(0, 20),
    }))
  }, [])

  const sendFrame = useCallback(
    (frame: Record<string, unknown>): boolean => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        pushLocalNotice('error', '连接已断开，正在重连…')
        return false
      }
      ws.send(JSON.stringify({ v: 1, ...frame }))
      return true
    },
    [pushLocalNotice]
  )

  const markRead = useCallback(() => {
    const seq = lastSeqRef.current
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    if (unreadRef.current <= 0) return
    setSession((prev) => ({
      ...prev,
      unreadCount: 0,
      lastReadSeq: Math.max(prev.lastReadSeq, seq),
    }))
    wsRef.current.send(JSON.stringify({ v: 1, type: 'mark_read', seq, at: Date.now() }))
  }, [])

  const loadAuxiliary = useCallback(async () => {
    const [devicesRes, authRes, configRes] = await Promise.all([
      request<{ devices?: WebSessionState['devices'] }>('GET', '/v1/devices'),
      request<{ authorizations?: WebSessionState['authorizations'] }>('GET', '/v1/authorizations'),
      request<WebCloudConfig>('GET', '/v1/cloud-config'),
    ])
    setSession((prev) => ({
      ...prev,
      ...(devicesRes.ok && Array.isArray(devicesRes.payload?.devices)
        ? { devices: devicesRes.payload.devices }
        : {}),
      ...(authRes.ok && Array.isArray(authRes.payload?.authorizations)
        ? { authorizations: authRes.payload.authorizations }
        : {}),
    }))
    if (configRes.ok && configRes.payload) {
      setConfig(configRes.payload)
    }
  }, [request])

  const loadMemoryData = useCallback(async () => {
    setMemoryBusy(true)
    try {
      const [memRes, docRes, dreamRes] = await Promise.all([
        request<{ memories?: CloudMemoryItem[] }>('GET', '/v1/memories'),
        request<{ docs?: CloudDocItem[] }>('GET', '/v1/cloud-docs'),
        request<{ dreams?: CloudDreamItem[] }>('GET', '/v1/dreams'),
      ])
      if (memRes.ok && Array.isArray(memRes.payload?.memories)) setMemories(memRes.payload.memories)
      if (docRes.ok && Array.isArray(docRes.payload?.docs)) setDocs(docRes.payload.docs)
      if (dreamRes.ok && Array.isArray(dreamRes.payload?.dreams)) setDreams(dreamRes.payload.dreams)
      setMemoryLoaded(true)
    } finally {
      setMemoryBusy(false)
    }
  }, [request])

  const connectSocket = useCallback(() => {
    clearReconnectTimer()
    const prev = wsRef.current
    wsRef.current = null
    if (prev) {
      try {
        prev.close()
      } catch {
        // 忽略旧连接异常
      }
    }

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    // 首连绝不带 lastAckSeq=0，否则服务端走续传分支不回整份快照
    const cursor = lastSeqRef.current > 0 ? `?lastAckSeq=${lastSeqRef.current}` : ''
    const url = `${scheme}//${window.location.host}/client/ws${cursor}`

    const scheduleReconnect = (handshakeFailed: boolean) => {
      clearReconnectTimer()
      const delay = reconnectDelayRef.current
      reconnectDelayRef.current = Math.min(30_000, Math.round(delay * 1.8))
      reconnectTimerRef.current = setTimeout(async () => {
        reconnectTimerRef.current = null
        if (!authenticatedRef.current) return
        if (handshakeFailed) {
          const check = await apiRequest<WebMe>('GET', '/v1/me')
          if (check.ok && check.payload && check.payload.authenticated === false) {
            showExpired(check.payload)
            return
          }
          if (!check.ok) {
            scheduleReconnect(true)
            return
          }
        }
        connectSocket()
      }, delay)
    }

    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      scheduleReconnect(true)
      return
    }
    wsRef.current = socket
    setWsStatus('connecting')
    let opened = false

    socket.addEventListener('open', () => {
      if (wsRef.current !== socket) return
      opened = true
      reconnectDelayRef.current = 1000
      setWsStatus('open')
    })

    socket.addEventListener('message', (event) => {
      if (wsRef.current !== socket) return
      let frame: any
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (frame?.type === 'error' && frame.message) {
        setBannerError(String(frame.message))
      }
      setSession((current) => {
        const applied = applyWebFrame(current, frame)
        let nextState = applied.state
        if (applied.unreadWorthy) {
          if (tabRef.current === 'chat' && !document.hidden) {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(
                JSON.stringify({ v: 1, type: 'mark_read', seq: nextState.lastSeq, at: Date.now() })
              )
              nextState = {
                ...nextState,
                unreadCount: 0,
                lastReadSeq: Math.max(nextState.lastReadSeq, nextState.lastSeq),
              }
            }
          } else {
            nextState = { ...nextState, unreadCount: nextState.unreadCount + 1 }
          }
        } else if (applied.snapshotUnread && tabRef.current === 'chat' && !document.hidden) {
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(
              JSON.stringify({ v: 1, type: 'mark_read', seq: nextState.lastSeq, at: Date.now() })
            )
            nextState = {
              ...nextState,
              unreadCount: 0,
              lastReadSeq: Math.max(nextState.lastReadSeq, nextState.lastSeq),
            }
          }
        }
        return nextState
      })
    })

    socket.addEventListener('close', () => {
      if (wsRef.current !== socket) return
      wsRef.current = null
      setWsStatus('closed')
      if (authenticatedRef.current) scheduleReconnect(!opened)
    })

    socket.addEventListener('error', () => {
      if (wsRef.current !== socket) return
      setWsStatus('closed')
    })
  }, [clearReconnectTimer, showExpired])

  // 同步文档主题属性（测试直接挂载组件时也保持 data-theme 与 html.dark 一致）
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  // 启动拉取 /v1/me
  useEffect(() => {
    let active = true
    void (async () => {
      const res = await apiRequest<WebMe>('GET', '/v1/me')
      if (!active) return
      if (!res.ok || !res.payload) {
        setView('login')
        setLoginNotice('无法连接云端服务')
        return
      }
      setMe(res.payload)
      if (!res.payload.hasAccount) {
        setView('setup')
      } else if (!res.payload.authenticated) {
        setView('login')
      } else {
        setView('app')
      }
    })()
    return () => {
      active = false
    }
  }, [])

  // 进入主界面后建连并拉辅助数据
  useEffect(() => {
    if (view !== 'app') return
    connectSocket()
    void loadAuxiliary()
    return () => closeSocket()
  }, [view, connectSocket, loadAuxiliary, closeSocket])

  // 切到记忆页按需加载
  useEffect(() => {
    if (view === 'app' && tab === 'memory' && !memoryLoaded && !memoryBusy) {
      void loadMemoryData()
    }
  }, [view, tab, memoryLoaded, memoryBusy, loadMemoryData])

  // 浏览器标题未读角标与可见性已读上报
  useEffect(() => {
    document.title = session.unreadCount > 0 ? `(${session.unreadCount}) Pi Cloud` : 'Pi Cloud'
  }, [session.unreadCount])

  useEffect(() => {
    if (view !== 'app') return
    if (tab === 'chat' && !document.hidden && session.unreadCount > 0) {
      markRead()
    }
    const onVisible = () => {
      if (!document.hidden && tabRef.current === 'chat' && unreadRef.current > 0) {
        markRead()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [view, tab, session.unreadCount, markRead])

  const toggleTheme = () => {
    const next: WebTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    applyTheme(next)
  }

  const sendChat = () => {
    const body = draft.trim()
    if (!body) return
    const ok = sendFrame({
      type: 'say',
      text: body,
      clientMessageId: `c-${Date.now().toString(36)}`,
    })
    if (!ok) return
    setDraft('')
    setSession((prev) => ({ ...prev, awaySummary: null }))
    transcriptRef.current?.scrollToBottom()
  }

  const stopTask = (taskId: string) => {
    if (!sendFrame({ type: 'stop_task', taskId })) return
    setSession((prev) => ({
      ...prev,
      stoppingTaskIds: { ...prev.stoppingTaskIds, [taskId]: true },
    }))
  }

  const onlineDevices = useMemo(
    () => session.devices.filter((device) => device.online).length,
    [session.devices]
  )
  const runningTasks = useMemo(
    () =>
      session.tasks.filter((task) =>
        (ACTIVE_TASK_STATUSES as readonly string[]).includes(task.status)
      ),
    [session.tasks]
  )

  if (view === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <div className="border border-rule-hairline bg-raised px-5 py-3 type-caption text-ink-muted">
          Loading…
        </div>
      </div>
    )
  }

  if (view === 'setup') {
    return (
      <SetupView
        request={request}
        onDone={() => {
          setLoginNotice('')
          setView('login')
        }}
      />
    )
  }

  if (view === 'login') {
    return (
      <LoginView
        notice={loginNotice}
        request={request}
        onLoggedIn={(nextMe) => {
          setMe(nextMe)
          setLoginNotice('')
          setView('app')
        }}
      />
    )
  }

  const wsLabel = wsStatus === 'open' ? '在线' : wsStatus === 'connecting' ? '连接中…' : '断开'
  const agentLabel = AGENT_STATUS_LABELS[session.agentStatus] || session.agentStatus
  const versionText = `v${me?.version || '0.11.2'}`

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-surface text-ink">
      {/* 顶栏 45px：品牌印面 + 标签切换 + 在线状态 + 主题切换 */}
      <header className="top flex h-[45px] flex-shrink-0 items-center gap-3 border-b border-rule-divide bg-panel px-3">
        <div className="flex flex-shrink-0 items-center gap-2">
          <BrandSeal size={20} className="brand-seal" />
          <span className="type-eyebrow text-ink">CLOUD</span>
        </div>

        <nav
          role="tablist"
          aria-label="Pi Cloud 导航"
          className="tab-strip-scroll flex h-full min-w-0 items-stretch overflow-x-auto"
        >
          {TABS.map((item) => (
            <Tab
              key={item.id}
              active={tab === item.id}
              label={
                item.id === 'chat' && session.unreadCount > 0
                  ? `${item.label} (${session.unreadCount})`
                  : item.label
              }
              onSelect={() => {
                setTab(item.id)
                if (item.id === 'chat' && session.unreadCount > 0) markRead()
              }}
            />
          ))}
        </nav>

        <div className="ml-auto flex flex-shrink-0 items-center gap-3">
          <div className="hidden items-center gap-3 md:flex">
            <StatusText tone={onlineDevices > 0 ? 'success' : 'muted'} dot>
              {onlineDevices}/{session.devices.length} 台设备在线
            </StatusText>
            {(session.agentStatus === 'thinking' || session.agentStatus === 'replying') && (
              <Caption className="text-accent">{agentLabel}</Caption>
            )}
            {runningTasks.length > 0 && (
              <div className="flex items-center gap-1.5">
                <Caption className="text-ink-muted">
                  {runningTasks.length === 1
                    ? `${runningTasks[0].spec?.title || runningTasks[0].id}`
                    : `${runningTasks.length} 个工单执行中`}
                </Caption>
                {runningTasks.length === 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(session.stoppingTaskIds[runningTasks[0].id])}
                    onClick={() => stopTask(runningTasks[0].id)}
                  >
                    {session.stoppingTaskIds[runningTasks[0].id] ? '正在停止…' : '停止'}
                  </Button>
                )}
              </div>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={toggleTheme} aria-label="切换 Paper / Ink 主题">
            {theme === 'dark' ? 'Ink' : 'Paper'}
          </Button>
        </div>
      </header>

      {bannerError && (
        <div
          role="alert"
          className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-danger/30 bg-danger/10 px-4 py-1.5 type-caption text-danger"
        >
          <span className="min-w-0 truncate">{bannerError}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setBannerError(null)}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm text-danger hover:bg-danger/10"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* 主区域 */}
      <main className="flex min-h-0 flex-1 overflow-hidden">
        {tab === 'chat' ? (
          <>
            <section className="chat flex min-h-0 min-w-0 flex-1 flex-col">
              <StreamingTranscript
                ref={transcriptRef}
                messageCount={session.messages.length}
                scrollToBottomLabel="回到底部"
                newMessagesLabel={(count) => `${count} 条新消息`}
              >
                {session.awaySummary?.text && (
                  <div
                    role="status"
                    className="border border-rule-divide bg-panel px-3 py-2"
                  >
                    <p className="m-0 type-label text-ink">离线期间汇总</p>
                    <p className="m-0 mt-0.5 whitespace-pre-wrap type-caption text-ink-muted">
                      {session.awaySummary.text}
                    </p>
                  </div>
                )}
                {session.messages.length === 0 ? (
                  <EmptyState
                    icon={Cloud}
                    title="Pi Cloud"
                    description="还没有消息。直接说你想让终端做什么。"
                  />
                ) : (
                  session.messages.map((message) => (
                    <WebChatMessageRow key={message.id} message={message} />
                  ))
                )}
              </StreamingTranscript>

              <div className="composer flex flex-shrink-0 flex-col gap-2 border-t border-rule-divide bg-panel px-4 py-3">
                <Textarea
                  value={draft}
                  rows={3}
                  placeholder="说说你想让终端做什么…"
                  onChange={(event) => setDraft(event.target.value)}
                  onCompositionStart={() => {
                    composingRef.current = true
                  }}
                  onCompositionEnd={() => {
                    composingRef.current = false
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !composingRef.current &&
                      !event.nativeEvent.isComposing &&
                      event.keyCode !== 229
                    ) {
                      event.preventDefault()
                      sendChat()
                    }
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!draft.trim()}
                    onClick={sendChat}
                  >
                    发送
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!session.canStopReply}
                    onClick={() => sendFrame({ type: 'stop_reply' })}
                  >
                    停止回复
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setConfirmPlanOpen(true)}
                  >
                    确认方案…
                  </Button>
                  <Caption className="hidden text-ink-muted sm:inline">
                    Enter 发送 · Shift+Enter 换行
                  </Caption>
                  {(session.agentStatus === 'thinking' || session.agentStatus === 'replying') && (
                    <Caption className="ml-auto text-accent">{agentLabel}</Caption>
                  )}
                </div>
              </div>
            </section>

            {/* 宽屏右侧运行态栏（可折叠成 28px 窄条，绝不卸载左侧聊天区） */}
            {asideCollapsed ? (
              <button
                ref={expandAsideRef}
                type="button"
                aria-label="展开运行态面板"
                aria-expanded={false}
                title="展开运行态面板"
                onClick={() => {
                  setAsideCollapsed(false)
                  window.requestAnimationFrame(() => collapseAsideRef.current?.focus())
                }}
                className="hidden w-[28px] flex-shrink-0 items-center justify-center border-l border-rule-divide bg-panel text-ink-muted transition-colors hover:bg-hover hover:text-ink lg:flex"
              >
                <PanelRightOpen size={14} aria-hidden="true" />
              </button>
            ) : (
              <aside className="hidden w-[340px] flex-shrink-0 flex-col border-l border-rule-divide bg-panel lg:flex">
                <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-rule-divide px-2.5">
                  <button
                    ref={collapseAsideRef}
                    type="button"
                    aria-label="收起运行态面板"
                    aria-expanded={true}
                    title="收起运行态面板"
                    onClick={() => {
                      setAsideCollapsed(true)
                      window.requestAnimationFrame(() => expandAsideRef.current?.focus())
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-hover hover:text-ink"
                  >
                    <PanelRightClose size={14} aria-hidden="true" />
                  </button>
                  <span className="type-label text-ink-muted">运行态</span>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
                  <TaskCard
                    compact
                    tasks={session.tasks}
                    devices={session.devices}
                    stoppingTaskIds={session.stoppingTaskIds}
                    answerDrafts={answerDrafts}
                    instructionDrafts={instructionDrafts}
                    onAnswerDraft={(id, val) => setAnswerDrafts((prev) => ({ ...prev, [id]: val }))}
                    onInstructionDraft={(id, val) =>
                      setInstructionDrafts((prev) => ({ ...prev, [id]: val }))
                    }
                    onSendAnswer={(id, text) => {
                      if (!sendFrame({ type: 'task_message', taskId: id, text })) return
                      setAnswerDrafts((prev) => ({ ...prev, [id]: '' }))
                    }}
                    onSendInstruction={(id, text) => {
                      if (!sendFrame({ type: 'task_message', taskId: id, text })) return
                      setInstructionDrafts((prev) => ({ ...prev, [id]: '' }))
                    }}
                    onStopTask={stopTask}
                  />
                  <UnitCard
                    units={session.units}
                    onCloseUnit={(unitId) => sendFrame({ type: 'close_unit', unitId })}
                  />
                  <DeviceCard
                    devices={session.devices}
                    pairCode={pairCode}
                    onGeneratePairCode={async () => {
                      const res = await request<WebPairCode>('POST', '/v1/pair/code')
                      if (res.ok && res.payload) setPairCode(res.payload)
                    }}
                    onRemoveDevice={async (deviceId) => {
                      const res = await request('DELETE', `/v1/devices/${encodeURIComponent(deviceId)}`)
                      if (res.ok) void loadAuxiliary()
                    }}
                  />
                  <AuthCard
                    authorizations={session.authorizations}
                    onRevoke={async (id) => {
                      const res = await request('DELETE', `/v1/authorizations/${encodeURIComponent(id)}`)
                      if (res.ok) void loadAuxiliary()
                    }}
                  />
                  <NoticeCard notices={session.notices} />
                </div>
              </aside>
            )}
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
              {tab === 'tasks' && (
                <>
                  <TaskCard
                    tasks={session.tasks}
                    devices={session.devices}
                    stoppingTaskIds={session.stoppingTaskIds}
                    answerDrafts={answerDrafts}
                    instructionDrafts={instructionDrafts}
                    onAnswerDraft={(id, val) => setAnswerDrafts((prev) => ({ ...prev, [id]: val }))}
                    onInstructionDraft={(id, val) =>
                      setInstructionDrafts((prev) => ({ ...prev, [id]: val }))
                    }
                    onSendAnswer={(id, text) => {
                      if (!sendFrame({ type: 'task_message', taskId: id, text })) return
                      setAnswerDrafts((prev) => ({ ...prev, [id]: '' }))
                    }}
                    onSendInstruction={(id, text) => {
                      if (!sendFrame({ type: 'task_message', taskId: id, text })) return
                      setInstructionDrafts((prev) => ({ ...prev, [id]: '' }))
                    }}
                    onStopTask={stopTask}
                  />
                  {/* 窄屏隐藏了右栏，在工单页底部兜底呈现工作单元、授权与最近提示 */}
                  <div className="flex flex-col gap-4 lg:hidden">
                    <UnitCard
                      units={session.units}
                      onCloseUnit={(unitId) => sendFrame({ type: 'close_unit', unitId })}
                    />
                    <AuthCard
                      authorizations={session.authorizations}
                      onRevoke={async (id) => {
                        const res = await request(
                          'DELETE',
                          `/v1/authorizations/${encodeURIComponent(id)}`
                        )
                        if (res.ok) void loadAuxiliary()
                      }}
                    />
                    <NoticeCard notices={session.notices} />
                  </div>
                </>
              )}
              {tab === 'devices' && (
                <DeviceCard
                  devices={session.devices}
                  pairCode={pairCode}
                  onGeneratePairCode={async () => {
                    const res = await request<WebPairCode>('POST', '/v1/pair/code')
                    if (res.ok && res.payload) setPairCode(res.payload)
                  }}
                  onRemoveDevice={async (deviceId) => {
                    const res = await request('DELETE', `/v1/devices/${encodeURIComponent(deviceId)}`)
                    if (res.ok) void loadAuxiliary()
                  }}
                />
              )}
              {tab === 'memory' && (
                <MemoryTab
                  memories={memories}
                  docs={docs}
                  dreams={dreams}
                  busy={memoryBusy}
                  docDrafts={docDrafts}
                  onDocDraftChange={(name, val) =>
                    setDocDrafts((prev) => ({ ...prev, [name]: val }))
                  }
                  onClearDocDraft={(name) =>
                    setDocDrafts((prev) => {
                      const next = { ...prev }
                      delete next[name]
                      return next
                    })
                  }
                  onMemoriesChange={setMemories}
                  onDocsChange={setDocs}
                  onRefresh={loadMemoryData}
                  request={request}
                />
              )}
              {tab === 'settings' && (
                <ConfigCard
                  config={config}
                  draft={configDraft}
                  models={configModels}
                  feedback={configFeedback}
                  onDraftChange={setConfigDraft}
                  onModelsChange={setConfigModels}
                  onFeedbackChange={setConfigFeedback}
                  onReloadAuxiliary={loadAuxiliary}
                  request={request}
                />
              )}
            </div>
          </div>
        )}
      </main>

      {/* 底栏 28px：真实版本号 + WS/Agent 状态 + 在线设备数 */}
      <footer className="bottom flex h-7 flex-shrink-0 items-center gap-3 border-t border-rule-divide bg-panel px-3 type-caption text-ink-muted">
        <DataText className="text-ink-muted">{versionText}</DataText>
        <StatusText tone={wsStatus === 'open' ? 'success' : wsStatus === 'connecting' ? 'warning' : 'danger'} dot>
          {wsLabel}
        </StatusText>
        <span>{agentLabel}</span>
        <DataText className="ml-auto text-ink-muted">
          seq {session.lastSeq} · {onlineDevices}/{session.devices.length} 在线
        </DataText>
      </footer>

      <ConfirmPlanModal
        open={confirmPlanOpen}
        devices={session.devices}
        onClose={() => setConfirmPlanOpen(false)}
        onSubmit={(payload) => sendFrame({ type: 'confirm_plan', ...payload })}
      />
    </div>
  )
}
