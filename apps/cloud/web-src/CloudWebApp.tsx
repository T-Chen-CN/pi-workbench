import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cloud, PanelRightClose, PanelRightOpen, X } from 'lucide-react'
import { translate, type Language, type TranslationKey, type TranslationParams } from '@pi-workbench/i18n'
import {
  BrandSeal,
  StreamdownView,
  StreamingTranscript,
  type StreamingTranscriptHandle,
} from '@pi-workbench/ui'
import {
  Button,
  Caption,
  CloudChatComposer,
  CloudMcpManager,
  CloudTraceSection,
  DataText,
  EmptyState,
  Field,
  Input,
  StatusText,
  Tab,
  cloudMcpStatusToInput,
} from '@pi-workbench/cloud-ui'
import type { McpServerInput, McpServerStatus, McpTestResult } from 'pi-bridge/mcp'
import {
  ACTIVE_TASK_STATUSES,
  INITIAL_WEB_SESSION_STATE,
  apiRequest,
  applyLanguage,
  applyTheme,
  applyWebFrame,
  formatTime,
  getAgentStatusLabel,
  resolveInitialLanguage,
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

declare const __PI_CLOUD_WEB_VERSION__: string | undefined

const FALLBACK_WEB_VERSION =
  typeof __PI_CLOUD_WEB_VERSION__ === 'string' && __PI_CLOUD_WEB_VERSION__
    ? __PI_CLOUD_WEB_VERSION__
    : '0.11.2'

const TAB_KEYS: ReadonlyArray<{ id: WebTab; labelKey: TranslationKey }> = [
  { id: 'chat', labelKey: 'cloudWebTabChat' },
  { id: 'tasks', labelKey: 'cloudWebTabTasks' },
  { id: 'devices', labelKey: 'cloudWebTabDevices' },
  { id: 'memory', labelKey: 'cloudWebTabMemory' },
  { id: 'settings', labelKey: 'cloudWebTabSettings' },
]

const WebChatMessageRow = React.memo(function WebChatMessageRow({
  message,
  language,
}: {
  message: CloudChatRow
  language: Language
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
            aria-label={translate(language, 'cloudWebStreamingAria')}
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
          language={language}
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
              language={language}
            />
          </div>
        ))}
      {message.error && <DataText className="text-danger">{message.error}</DataText>}
    </article>
  )
})

const SetupView: React.FC<{
  language: Language
  onToggleLanguage: () => void
  onDone: () => void
  request: <T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ) => Promise<{ ok: boolean; status: number; payload: T | null }>
}> = ({ language, onToggleLanguage, onDone, request }) => {
  const t = useCallback(
    (key: TranslationKey, params?: TranslationParams) => translate(language, key, params),
    [language]
  )
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy) return
    if (password.length < 8) {
      setError(t('cloudWebPasswordTooShort'))
      return
    }
    if (password !== confirm) {
      setError(t('cloudWebPasswordMismatch'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await request<{ error?: string }>('POST', '/v1/setup', { password })
      if (!result.ok) {
        setError(result.payload?.error || t('cloudWebSetupFailed'))
        return
      }
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cloud-web-root safe-top safe-bottom safe-x flex min-h-dvh items-center justify-center overflow-y-auto bg-surface">
      <div className="w-full max-w-sm p-6">
        <div className="flex w-full flex-col gap-4 border border-line bg-raised p-6 shadow-print">
          <div className="flex items-center gap-2.5">
            <BrandSeal size={24} className="brand-seal" />
            <h1 className="m-0 type-subtitle text-ink">{t('cloudWebTitle')}</h1>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={onToggleLanguage}
              aria-label={t('cloudWebLanguageToggle')}
            >
              {language === 'zh' ? t('cloudWebLanguageZh') : t('cloudWebLanguageEn')}
            </Button>
          </div>
          <Caption className="text-ink-muted">{t('cloudWebSetupHint')}</Caption>
          <Field label={t('cloudWebPassword')} htmlFor="setup-password">
            <Input
              id="setup-password"
              type="password"
              autoComplete="new-password"
              placeholder={t('cloudWebPasswordPlaceholder')}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field label={t('cloudWebConfirmPassword')} htmlFor="setup-confirm">
            <Input
              id="setup-confirm"
              type="password"
              autoComplete="new-password"
              placeholder={t('cloudWebConfirmPasswordPlaceholder')}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  void submit()
                }
              }}
            />
          </Field>
          {error && <Caption className="text-danger">{error}</Caption>}
          <Button variant="primary" size="md" disabled={busy} onClick={() => void submit()}>
            {t('cloudWebSetupSubmit')}
          </Button>
        </div>
      </div>
    </div>
  )
}

const LoginView: React.FC<{
  language: Language
  onToggleLanguage: () => void
  notice: string
  onLoggedIn: (me: WebMe) => void
  request: <T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ) => Promise<{ ok: boolean; status: number; payload: T | null }>
}> = ({ language, onToggleLanguage, notice, onLoggedIn, request }) => {
  const t = useCallback(
    (key: TranslationKey, params?: TranslationParams) => translate(language, key, params),
    [language]
  )
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
        setError(result.status === 429 ? t('cloudWebLoginRateLimited') : t('cloudWebLoginInvalid'))
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
    <div className="cloud-web-root safe-top safe-bottom safe-x flex min-h-dvh items-center justify-center overflow-y-auto bg-surface">
      <div className="w-full max-w-sm p-6">
        <div className="flex w-full flex-col gap-4 border border-line bg-raised p-6 shadow-print">
          <div className="flex items-center gap-2.5">
            <BrandSeal size={24} className="brand-seal" />
            <h1 className="m-0 type-subtitle text-ink">{t('cloudWebTitle')}</h1>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={onToggleLanguage}
              aria-label={t('cloudWebLanguageToggle')}
            >
              {language === 'zh' ? t('cloudWebLanguageZh') : t('cloudWebLanguageEn')}
            </Button>
          </div>
          <Caption className="text-ink-muted">{t('cloudWebLoginHint')}</Caption>
          <Field label={t('cloudWebPassword')} htmlFor="login-password">
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229
                ) {
                  void submit()
                }
              }}
              autoFocus
            />
          </Field>
          {error && <Caption className="text-danger">{error}</Caption>}
          <Button variant="primary" size="md" disabled={busy} onClick={() => void submit()}>
            {t('cloudWebLoginSubmit')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export const CloudWebApp: React.FC = () => {
  const [view, setView] = useState<'loading' | 'setup' | 'login' | 'app'>('loading')
  const [me, setMe] = useState<WebMe | null>(null)
  const [loginNoticeKey, setLoginNoticeKey] = useState<TranslationKey | null>(null)
  const [theme, setTheme] = useState<WebTheme>(() => resolveInitialTheme())
  const [language, setLanguage] = useState<Language>(() => resolveInitialLanguage())

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
  const [configFeedback, setConfigFeedback] = useState<{ text: string; tone: 'info' | 'error' }>({
    text: '',
    tone: 'info',
  })

  const [memories, setMemories] = useState<CloudMemoryItem[]>([])
  const [docs, setDocs] = useState<CloudDocItem[]>([])
  const [dreams, setDreams] = useState<CloudDreamItem[]>([])
  const [docDrafts, setDocDrafts] = useState<Record<string, string>>({})
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [memoryLoaded, setMemoryLoaded] = useState(false)

  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([])
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpLoaded, setMcpLoaded] = useState(false)
  const [mcpMutatingId, setMcpMutatingId] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelayRef = useRef(1000)
  const lastSeqRef = useRef(0)
  const unreadRef = useRef(0)
  const tabRef = useRef<WebTab>(tab)
  const authenticatedRef = useRef(false)
  const languageRef = useRef<Language>(language)
  const transcriptRef = useRef<StreamingTranscriptHandle | null>(null)
  const collapseAsideRef = useRef<HTMLButtonElement | null>(null)
  const expandAsideRef = useRef<HTMLButtonElement | null>(null)

  tabRef.current = tab
  lastSeqRef.current = session.lastSeq
  unreadRef.current = session.unreadCount
  authenticatedRef.current = view === 'app'
  languageRef.current = language

  const t = useCallback(
    (key: TranslationKey, params?: TranslationParams) => translate(language, key, params),
    [language]
  )

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
      setLoginNoticeKey('cloudWebSessionExpired')
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
    <T = unknown,>(method: string, path: string, body?: unknown) =>
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
        pushLocalNotice('error', translate(languageRef.current, 'cloudWebDisconnectedNotice'))
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
    unreadRef.current = 0
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

  const loadMcpServers = useCallback(async () => {
    setMcpBusy(true)
    try {
      const res = await request<{ servers?: McpServerStatus[] }>('GET', '/v1/mcp')
      if (res.ok && Array.isArray(res.payload?.servers)) {
        setMcpServers(res.payload.servers)
      }
      setMcpLoaded(true)
    } finally {
      setMcpBusy(false)
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
      let frame: unknown
      try {
        frame = JSON.parse(String(event.data)) as unknown
      } catch {
        return
      }
      if (
        frame &&
        typeof frame === 'object' &&
        (frame as Record<string, unknown>).type === 'error' &&
        (frame as Record<string, unknown>).message
      ) {
        setBannerError(String((frame as Record<string, unknown>).message))
      }
      // 状态更新器保持纯函数（不在 updater 内发 WS 帧，避免 React 19 StrictMode 双调导致重复 mark_read）；
      // 前台可见会话页的已读回执统一交给下方的 visibility/unread effect 在提交后上报。
      setSession((current) => {
        const applied = applyWebFrame(current, frame)
        if (applied.unreadWorthy) {
          return { ...applied.state, unreadCount: applied.state.unreadCount + 1 }
        }
        return applied.state
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

  // 同步文档主题、语言与云端 Web 标记（保证 Portal 弹窗也受移动端 16px 防缩放规则覆盖）
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.setAttribute('data-cloud-web', 'true')
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  useEffect(() => {
    applyLanguage(language)
  }, [language])

  // 启动拉取 /v1/me
  useEffect(() => {
    let active = true
    void (async () => {
      const res = await apiRequest<WebMe>('GET', '/v1/me')
      if (!active) return
      if (!res.ok || !res.payload) {
        setView('login')
        setLoginNoticeKey('cloudWebCannotConnect')
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

  // 切到设置页按需加载云端 MCP 服务器
  useEffect(() => {
    if (view === 'app' && tab === 'settings' && !mcpLoaded && !mcpBusy) {
      void loadMcpServers()
    }
  }, [view, tab, mcpLoaded, mcpBusy, loadMcpServers])

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
  }, [view, tab, wsStatus, session.unreadCount, session.lastSeq, markRead])

  const toggleTheme = () => {
    const next: WebTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    applyTheme(next)
  }

  const toggleLanguage = () => {
    const next: Language = language === 'zh' ? 'en' : 'zh'
    setLanguage(next)
    applyLanguage(next)
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
      <div className="cloud-web-root safe-top safe-bottom safe-x flex min-h-dvh items-center justify-center bg-surface">
        <div className="border border-rule-hairline bg-raised px-5 py-3 type-caption text-ink-muted">
          {t('cloudWebLoading')}
        </div>
      </div>
    )
  }

  if (view === 'setup') {
    return (
      <SetupView
        language={language}
        onToggleLanguage={toggleLanguage}
        request={request}
        onDone={() => {
          setLoginNoticeKey(null)
          setView('login')
        }}
      />
    )
  }

  if (view === 'login') {
    return (
      <LoginView
        language={language}
        onToggleLanguage={toggleLanguage}
        notice={loginNoticeKey ? t(loginNoticeKey) : ''}
        request={request}
        onLoggedIn={(nextMe) => {
          setMe(nextMe)
          setLoginNoticeKey(null)
          setView('app')
        }}
      />
    )
  }

  const wsLabel =
    wsStatus === 'open'
      ? t('cloudWebWsOpen')
      : wsStatus === 'connecting'
        ? t('cloudWebWsConnecting')
        : t('cloudWebWsClosed')
  const agentLabel = getAgentStatusLabel(session.agentStatus, language)
  const versionText = `v${me?.version || FALLBACK_WEB_VERSION}`

  return (
    <div className="cloud-web-root flex h-dvh flex-col overflow-hidden bg-surface text-ink">
      {/* 顶栏 45px：品牌印面 + 标签切换 + 在线状态 + 语言/主题切换；外层承接刘海屏安全区 */}
      <header className="top safe-top safe-x flex-shrink-0 border-b border-rule-divide bg-panel">
        <div className="flex h-[45px] items-center gap-3 px-3">
          <div className="flex flex-shrink-0 items-center gap-2">
            <BrandSeal size={20} className="brand-seal" />
            <span className="type-eyebrow text-ink">CLOUD</span>
          </div>

          <div
            role="tablist"
            aria-label={t('cloudWebNavLabel')}
            className="tab-strip-scroll flex h-full min-w-0 items-stretch overflow-x-auto"
          >
            {TAB_KEYS.map((item) => {
              const tabLabel = t(item.labelKey)
              return (
                <Tab
                  key={item.id}
                  active={tab === item.id}
                  label={
                    item.id === 'chat' && session.unreadCount > 0
                      ? `${tabLabel} (${session.unreadCount})`
                      : tabLabel
                  }
                  onSelect={() => {
                    setTab(item.id)
                    if (item.id === 'chat' && session.unreadCount > 0) markRead()
                  }}
                />
              )
            })}
          </div>

          <div className="ml-auto flex flex-shrink-0 items-center gap-2">
            <div className="hidden items-center gap-3 md:flex">
              <StatusText tone={onlineDevices > 0 ? 'success' : 'muted'} dot>
                {t('cloudWebDevicesOnlineCount', {
                  online: onlineDevices,
                  total: session.devices.length,
                })}
              </StatusText>
              {(session.agentStatus === 'thinking' || session.agentStatus === 'replying') && (
                <Caption className="text-accent">{agentLabel}</Caption>
              )}
              {runningTasks.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <Caption className="text-ink-muted">
                    {runningTasks.length === 1
                      ? `${runningTasks[0].title || runningTasks[0].id}`
                      : t('cloudWebTasksRunningCount', { count: runningTasks.length })}
                  </Caption>
                  {runningTasks.length === 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={Boolean(session.stoppingTaskIds[runningTasks[0].id])}
                      onClick={() => stopTask(runningTasks[0].id)}
                    >
                      {session.stoppingTaskIds[runningTasks[0].id]
                        ? t('cloudStoppingTask')
                        : t('cloudWebStopShort')}
                    </Button>
                  )}
                </div>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleLanguage}
              aria-label={t('cloudWebLanguageToggle')}
            >
              {language === 'zh' ? t('cloudWebLanguageZh') : t('cloudWebLanguageEn')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleTheme}
              aria-label={t('cloudWebThemeToggle')}
            >
              {theme === 'dark' ? 'Ink' : 'Paper'}
            </Button>
          </div>
        </div>
      </header>

      {bannerError && (
        <div
          role="alert"
          className="safe-x flex-shrink-0 border-b border-danger/30 bg-danger/10 type-caption text-danger"
        >
          <div className="flex items-start justify-between gap-2 px-4 py-1.5">
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words" title={bannerError}>
              {bannerError}
            </span>
            <button
              type="button"
              aria-label={t('cloudWebDismissNotice')}
              onClick={() => setBannerError(null)}
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm text-danger hover:bg-danger/10"
            >
              <X size={12} />
            </button>
          </div>
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
                scrollToBottomLabel={t('scrollToBottom')}
                newMessagesLabel={(count) => t('newMessages', { count })}
              >
                {session.awaySummary?.text && (
                  <div role="status" className="border border-rule-divide bg-panel px-3 py-2">
                    <p className="m-0 type-label text-ink">{t('cloudAwaySummaryTitle')}</p>
                    <p className="m-0 mt-0.5 whitespace-pre-wrap type-caption text-ink-muted">
                      {session.awaySummary.text}
                    </p>
                  </div>
                )}
                {session.messages.length === 0 ? (
                  <EmptyState
                    icon={Cloud}
                    title={t('cloudWebTitle')}
                    description={t('cloudSessionEmpty')}
                  />
                ) : (
                  session.messages.map((message) => (
                    <WebChatMessageRow key={message.id} message={message} language={language} />
                  ))
                )}
              </StreamingTranscript>

              <CloudChatComposer
                className="composer safe-x flex-shrink-0 border-t border-rule-divide bg-panel"
                value={draft}
                onChange={setDraft}
                onSend={sendChat}
                canStopReply={session.canStopReply}
                onStopReply={() => sendFrame({ type: 'stop_reply' })}
                agentStatus={session.agentStatus}
                agentStatusText={
                  session.agentStatus === 'thinking' || session.agentStatus === 'replying'
                    ? agentLabel
                    : ''
                }
                language={language}
                stopButtonVariant="secondary"
                shortcutClassName="hidden text-ink-muted sm:inline"
                statusClassName="ml-auto text-accent"
                extraActions={
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setConfirmPlanOpen(true)}
                  >
                    {t('cloudWebConfirmPlanAction')}
                  </Button>
                }
              />
            </section>

            {/* 宽屏右侧运行态栏（可折叠成 28px 窄条，绝不卸载左侧聊天区） */}
            {asideCollapsed ? (
              <button
                ref={expandAsideRef}
                type="button"
                aria-label={t('cloudExpandAside')}
                aria-expanded={false}
                title={t('cloudExpandAside')}
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
                    aria-label={t('cloudCollapseAside')}
                    aria-expanded={true}
                    title={t('cloudCollapseAside')}
                    onClick={() => {
                      setAsideCollapsed(true)
                      window.requestAnimationFrame(() => expandAsideRef.current?.focus())
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-hover hover:text-ink"
                  >
                    <PanelRightClose size={14} aria-hidden="true" />
                  </button>
                  <span className="type-label text-ink-muted">{t('cloudAsideTitle')}</span>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
                  <TaskCard
                    compact
                    language={language}
                    tasks={session.tasks}
                    devices={session.devices}
                    stoppingTaskIds={session.stoppingTaskIds}
                    answerDrafts={answerDrafts}
                    instructionDrafts={instructionDrafts}
                    onAnswerDraft={(id, val) =>
                      setAnswerDrafts((prev) => ({ ...prev, [id]: val }))
                    }
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
                    language={language}
                    onCloseUnit={(unitId) => sendFrame({ type: 'close_unit', unitId })}
                  />
                  <DeviceCard
                    devices={session.devices}
                    pairCode={pairCode}
                    language={language}
                    onGeneratePairCode={async () => {
                      const res = await request<WebPairCode>('POST', '/v1/pair/code')
                      if (res.ok && res.payload) setPairCode(res.payload)
                    }}
                    onRemoveDevice={async (deviceId) => {
                      const res = await request(
                        'DELETE',
                        `/v1/devices/${encodeURIComponent(deviceId)}`
                      )
                      if (res.ok) void loadAuxiliary()
                    }}
                  />
                  <AuthCard
                    authorizations={session.authorizations}
                    language={language}
                    onRevoke={async (id) => {
                      const res = await request(
                        'DELETE',
                        `/v1/authorizations/${encodeURIComponent(id)}`
                      )
                      if (res.ok) void loadAuxiliary()
                    }}
                  />
                  <NoticeCard notices={session.notices} language={language} />
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
                    language={language}
                    tasks={session.tasks}
                    devices={session.devices}
                    stoppingTaskIds={session.stoppingTaskIds}
                    answerDrafts={answerDrafts}
                    instructionDrafts={instructionDrafts}
                    onAnswerDraft={(id, val) =>
                      setAnswerDrafts((prev) => ({ ...prev, [id]: val }))
                    }
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
                      language={language}
                      onCloseUnit={(unitId) => sendFrame({ type: 'close_unit', unitId })}
                    />
                    <AuthCard
                      authorizations={session.authorizations}
                      language={language}
                      onRevoke={async (id) => {
                        const res = await request(
                          'DELETE',
                          `/v1/authorizations/${encodeURIComponent(id)}`
                        )
                        if (res.ok) void loadAuxiliary()
                      }}
                    />
                    <NoticeCard notices={session.notices} language={language} />
                  </div>
                </>
              )}
              {tab === 'devices' && (
                <DeviceCard
                  devices={session.devices}
                  pairCode={pairCode}
                  language={language}
                  onGeneratePairCode={async () => {
                    const res = await request<WebPairCode>('POST', '/v1/pair/code')
                    if (res.ok && res.payload) setPairCode(res.payload)
                  }}
                  onRemoveDevice={async (deviceId) => {
                    const res = await request(
                      'DELETE',
                      `/v1/devices/${encodeURIComponent(deviceId)}`
                    )
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
                  language={language}
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
                <>
                  <ConfigCard
                    config={config}
                    draft={configDraft}
                    models={configModels}
                    feedback={configFeedback.text}
                    feedbackTone={configFeedback.tone}
                    language={language}
                    onDraftChange={setConfigDraft}
                    onModelsChange={setConfigModels}
                    onFeedbackChange={(text, tone = 'info') => setConfigFeedback({ text, tone })}
                    onReloadAuxiliary={loadAuxiliary}
                    request={request}
                  />
                  <CloudMcpManager
                    language={language}
                    servers={mcpServers}
                    loading={mcpBusy}
                    busyId={mcpMutatingId}
                    onRefresh={loadMcpServers}
                    onSave={async (input: McpServerInput) => {
                      const targetId = input.id?.trim()
                      if (!targetId) return { ok: false, error: 'Server id is required' }
                      const res = await request<{ server?: McpServerStatus; error?: string }>(
                        'PUT',
                        `/v1/mcp/${encodeURIComponent(targetId)}`,
                        input
                      )
                      if (!res.ok) {
                        return { ok: false, error: res.payload?.error || `HTTP ${res.status}` }
                      }
                      await loadMcpServers()
                      return { ok: true }
                    }}
                    onToggle={async (server, enabled) => {
                      setMcpMutatingId(server.id)
                      try {
                        const res = await request<{ server?: McpServerStatus; error?: string }>(
                          'PUT',
                          `/v1/mcp/${encodeURIComponent(server.id)}`,
                          cloudMcpStatusToInput(server, enabled)
                        )
                        if (!res.ok) {
                          return { ok: false, error: res.payload?.error || `HTTP ${res.status}` }
                        }
                        await loadMcpServers()
                        return { ok: true }
                      } finally {
                        setMcpMutatingId(null)
                      }
                    }}
                    onDelete={async (id) => {
                      setMcpMutatingId(id)
                      try {
                        const res = await request<{ ok?: boolean; error?: string }>(
                          'DELETE',
                          `/v1/mcp/${encodeURIComponent(id)}`
                        )
                        if (!res.ok) {
                          return { ok: false, error: res.payload?.error || `HTTP ${res.status}` }
                        }
                        await loadMcpServers()
                        return { ok: true }
                      } finally {
                        setMcpMutatingId(null)
                      }
                    }}
                    onTest={async (payload) => {
                      const res = await request<McpTestResult & { error?: string }>(
                        'POST',
                        '/v1/mcp/test',
                        payload
                      )
                      if (!res.ok || !res.payload) {
                        return {
                          ok: false,
                          tools: [],
                          latencyMs: 0,
                          error: res.payload?.error || `HTTP ${res.status}`,
                        }
                      }
                      return {
                        ok: Boolean(res.payload.ok),
                        tools: Array.isArray(res.payload.tools) ? res.payload.tools : [],
                        latencyMs: typeof res.payload.latencyMs === 'number' ? res.payload.latencyMs : 0,
                        ...(res.payload.error ? { error: res.payload.error } : {}),
                      }
                    }}
                  />
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {/* 底栏 28px：真实版本号 + WS/Agent 状态 + 在线设备数；外层承接 Home Indicator 安全区 */}
      <footer className="bottom safe-bottom safe-x flex-shrink-0 border-t border-rule-divide bg-panel type-caption text-ink-muted">
        <div className="flex h-7 items-center gap-3 px-3">
          <DataText className="text-ink-muted">{versionText}</DataText>
          <StatusText
            tone={wsStatus === 'open' ? 'success' : wsStatus === 'connecting' ? 'warning' : 'danger'}
            dot
          >
            {wsLabel}
          </StatusText>
          <span>{agentLabel}</span>
          <DataText className="ml-auto text-ink-muted">
            seq {session.lastSeq} ·{' '}
            {t('cloudWebFooterDevicesOnline', {
              online: onlineDevices,
              total: session.devices.length,
            })}
          </DataText>
        </div>
      </footer>

      <ConfirmPlanModal
        open={confirmPlanOpen}
        devices={session.devices}
        language={language}
        onClose={() => setConfirmPlanOpen(false)}
        onSubmit={(payload) => sendFrame({ type: 'confirm_plan', ...payload })}
      />
    </div>
  )
}
