import {
  useState,
  useEffect,
  useCallback,
  useRef,
  lazy,
  Suspense,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  Activity,
  Bug,
  Folder,
  FolderOpen,
  PanelLeft,
  PanelRight,
  Plus,
  X,
} from 'lucide-react'
import { api } from './api'
import { piAgentAPI } from './api/piAgentAPI'
import { FileExplorer } from './components/FileExplorer'
import { ChatPanel } from './components/ChatPanel'
import { DiffViewer } from './components/DiffViewer'
import { IPCDebug } from './components/IPCDebug'
import { Settings, type SettingsSection } from './components/Settings'
import { UpdateDialog } from './components/UpdateDialog'
import { UpdateStatusIndicator } from './components/UpdateStatusIndicator'
import { TerminalPanel } from './components/TerminalPanel'
import { CommandPalette } from './components/CommandPalette'
import { FleetPanel } from './components/FleetPanel'
import { ToastContainer } from './components/Toast'
import { DialogHost } from './components/DialogHost'
import { WelcomeScreen } from './components/WelcomeScreen'
import { WindowControls } from './components/WindowControls'
import { Button, IconButton, Modal, Spinner } from './components/ui'
import { useToastStore, toast } from './store/toastStore'
import { useI18nStore } from './store/i18nStore'
import { useThemeStore, useResolvedTheme, type ThemeMode } from './store/themeStore'
import { useWorkspaceStore } from './store/workspaceStore'
import { useEditorStore } from './store/editorStore'
import { useChatStore } from './store/chatStore'
import { useSessionStore } from './store/sessionStore'
import { useDiffStore } from './store/diffStore'
import { confirmDialog } from './store/dialogStore'
import { useSettingsStore } from './store/settingsStore'
import { useApprovalStore } from './store/approvalStore'
import { useUpdaterStore } from './store/updaterStore'
import { localizeError } from './i18n/errors'
import { commandPaletteShortcut } from './utils/shortcuts'

const MonacoEditor = lazy(() =>
  import('./components/MonacoEditor').then((module) => ({ default: module.MonacoEditor }))
)

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 420
const CHAT_MIN = 280
const CHAT_MAX = 560

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export default function App() {
  const {
    workspacePath: workspace,
    openWorkspaces,
    recentWorkspaces,
    openWorkspace: activateWorkspace,
    setRecentWorkspaces,
  } = useWorkspaceStore()
  const [error, setError] = useState<string | null>(null)
  const openingWorkspaceRef = useRef(false)
  const [showDebug, setShowDebug] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [showTerminal, setShowTerminal] = useState(false)
  const [showFleet, setShowFleet] = useState(false)
  const [showActivity, setShowActivity] = useState(false)
  const [fleetActive, setFleetActive] = useState(0)
  const [showSidebar, setShowSidebar] = useState(true)
  const [showChat, setShowChat] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(232)
  const [chatWidth, setChatWidth] = useState(336)
  const toastMessages = useToastStore((state) => state.messages)
  const removeToast = useToastStore((state) => state.remove)
  const sessionState = useSessionStore((state) =>
    workspace ? state.byWorkspace[workspace] : undefined
  )
  const streamingMap = useSessionStore((state) => state.streaming)
  const streamingSessions =
    workspace && sessionState
      ? sessionState.sessions.filter(
          (session) => streamingMap[`${workspace}\u0000${session.id}`]
        )
      : []
  const activeCount = streamingSessions.length + fleetActive
  const { t, setLanguage, language } = useI18nStore()
  const { setMode } = useThemeStore()
  const resolvedTheme = useResolvedTheme()
  const currentFile = useEditorStore((state) => state.currentFile)
  const platform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined
  const usesMacTrafficLights = platform === 'darwin'
  const usesCustomWindowControls = !!platform && platform !== 'darwin' && platform !== 'web'

  const fileLanguage = (() => {
    const ext = currentFile?.name.split('.').pop()?.toLowerCase()
    switch (ext) {
      case 'ts':
      case 'tsx':
        return 'TypeScript'
      case 'js':
      case 'jsx':
        return 'JavaScript'
      case 'json':
        return 'JSON'
      case 'md':
        return 'Markdown'
      case 'css':
        return 'CSS'
      case 'html':
        return 'HTML'
      default:
        return 'Plain Text'
    }
  })()

  // 允许子组件（如 ChatPanel）请求打开设置面板
  const openSettings = useCallback((section: SettingsSection = 'general') => {
    setSettingsSection(section)
    setShowSettings(true)
  }, [])

  useEffect(() => {
    const openSettingsEvent = () => openSettings()
    window.addEventListener('open-settings', openSettingsEvent)
    return () => window.removeEventListener('open-settings', openSettingsEvent)
  }, [openSettings])

  // 更新状态由 App 统一订阅，设置页、状态栏和安装弹窗共享同一份状态
  const applyUpdateState = useUpdaterStore((store) => store.applyState)
  useEffect(() => {
    let active = true
    api
      .updateGetState()
      .then((result) => {
        if (active && result.success) applyUpdateState(result.state)
      })
      .catch((err) => console.error('Failed to load update state:', err))

    const unsubscribe = api.onUpdateStatus((state) => applyUpdateState(state))
    return () => {
      active = false
      unsubscribe()
    }
  }, [applyUpdateState])

  // 窗口标题、文档语言与主题跟随设置
  useEffect(() => {
    document.title = t('appTitle')
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  }, [t, language])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark')
  }, [resolvedTheme])

  // 从便携式 settings.json 恢复语言与主题偏好
  useEffect(() => {
    api.getSettings()
      .then((result) => {
        if (!result.success || !result.settings) return
        const saved = result.settings
        if (saved.language === 'en' || saved.language === 'en-US') {
          setLanguage('en')
        } else if (saved.language === 'zh' || saved.language === 'zh-CN') {
          setLanguage('zh')
        }
        if (saved.theme === 'dark' || saved.theme === 'light' || saved.theme === 'system') {
          setMode(saved.theme as ThemeMode)
        }
        useSettingsStore.getState().hydrate(saved)
      })
      .catch((err) => console.error('Failed to load app settings:', err))
  }, [setLanguage, setMode])

  // 工具审批请求是全局的：切到别的会话时也要能收到通知与入队
  useEffect(() => {
    const off = piAgentAPI.onApprovalRequest((request) => {
      useApprovalStore.getState().add(request)
      useSessionStore.getState().markNeedsAction(request.workspaceDir, request.sessionId, 'input')
    })
    return () => {
      off()
      useApprovalStore.getState().reset()
    }
  }, [])

  // 加载最近打开的工作区
  useEffect(() => {
    api.getRecentWorkspaces()
      .then((result) => {
        if (result.success) setRecentWorkspaces(result.workspaces)
      })
      .catch((err) => console.error('Failed to load recent workspaces:', err))
  }, [setRecentWorkspaces])

  // 有未保存修改时阻止关闭窗口
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (useEditorStore.getState().hasDirtyFiles()) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Ctrl/Cmd+, 打开设置
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault()
        openSettings()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSettings])

  const clearWorkspaceChat = (targetPath: string) => {
    useSessionStore.getState().resetWorkspace(targetPath)
    const chat = useChatStore.getState()
    const prefix = `${targetPath}\u0000`
    for (const key of Object.keys(chat.conversations)) {
      if (key.startsWith(prefix)) chat.removeConversation(key)
    }
  }

  const resetWorkspaceState = () => {
    useEditorStore.getState().reset()
    useDiffStore.getState().clearDiff()
  }

  const confirmCloseWorkspace = async (): Promise<boolean> => {
    if (!useEditorStore.getState().hasDirtyFiles()) return true
    return confirmDialog({ message: t('discardChangesConfirm'), danger: true })
  }

  const openWorkspaceAt = async (targetPath: string, initialPrompt?: string) => {
    // 快速双击/连续选择时只处理第一次，避免 init/watch 交错
    if (openingWorkspaceRef.current) return
    openingWorkspaceRef.current = true
    try {
      setError(null)

      if (targetPath === workspace) return

      if (workspace && !(await confirmCloseWorkspace())) {
        return
      }

      // 初始化工作区目录（.pi-workbench）
      const initResult = await api.initWorkspace(targetPath)
      if (!initResult.success) {
        setError(initResult.error ? localizeError(initResult.error) : t('initWorkspaceFailed'))
        return
      }

      // 切换当前工作区：停止旧监听、重置 UI 状态，但保留各工作区的 Agent 实例
      await api.unwatchWorkspace().catch(() => undefined)
      resetWorkspaceState()

      activateWorkspace(targetPath)

      // 上次异常退出留下的未保存草稿：询问用户是否恢复
      try {
        const drafts = await api.draftList(targetPath)
        if (drafts.success && drafts.drafts.length > 0) {
          if (await confirmDialog({ message: t('recoverDraftsConfirm', { count: drafts.drafts.length }) })) {
            for (const draft of drafts.drafts) {
              useEditorStore.getState().addOpenFile({
                path: draft.path,
                name: draft.path.split(/[\\/]/).pop() || draft.path,
                content: draft.content,
                isDirty: true,
                isSaving: false,
              })
              useEditorStore.getState().markDirty(draft.path)
            }
          } else {
            await api.draftClear(targetPath).catch(() => undefined)
          }
        }
      } catch (draftError) {
        console.error('Failed to restore drafts:', draftError)
      }

      // 欢迎页提问：打开工作区后把问题带入聊天输入框
      if (initialPrompt) {
        useChatStore.getState().setPendingDraft(initialPrompt)
      }

      api.watchWorkspace(targetPath).catch((err) => {
        const detail = err instanceof Error ? err.message : String(err)
        console.error('Failed to watch workspace:', err)
        toast.error(t('watchWorkspaceFailed', { error: localizeError(detail) }))
      })

      const recent = await api.addRecentWorkspace(targetPath)
      if (recent.success) setRecentWorkspaces(recent.workspaces)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(localizeError(message))
      console.error('Failed to open workspace:', err)
    } finally {
      openingWorkspaceRef.current = false
    }
  }

  // 桌面通知点击：先切到对应工作区，再让 ChatPanel 激活会话
  const openWorkspaceRef = useRef(openWorkspaceAt)
  useEffect(() => {
    openWorkspaceRef.current = openWorkspaceAt
  })

  useEffect(() => {
    const off = piAgentAPI.onNotifyClick(({ workspaceDir, sessionId }) => {
      void (async () => {
        if (workspaceDir && workspaceDir !== useWorkspaceStore.getState().workspacePath) {
          await openWorkspaceRef.current(workspaceDir)
        }
        useSessionStore.getState().requestActivation(workspaceDir, sessionId)
      })()
    })
    return () => off()
  }, [])

  // 统一活动：统计后台 Fleet 任务（每 5 秒刷新一次）
  useEffect(() => {
    if (!workspace) {
      setFleetActive(0)
      return
    }
    let cancelled = false
    const refresh = async () => {
      try {
        const result = await api.fleetList(workspace)
        if (cancelled || !result.success) return
        setFleetActive(
          (result.tasks ?? []).filter(
            (task) => task.status === 'running' || task.status === 'queued'
          ).length
        )
      } catch {
        // 忽略轮询错误
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [workspace])

  const pickWorkspace = async () => {
    try {
      setError(null)
      const result = await api.openDirectoryDialog()
      if (result.success && !result.canceled && result.path) {
        await openWorkspaceAt(result.path)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(localizeError(message))
      console.error('Failed to open workspace:', err)
    }
  }

  const refreshRecentWorkspaces = async () => {
    try {
      const result = await api.getRecentWorkspaces()
      if (result.success) setRecentWorkspaces(result.workspaces)
    } catch (err) {
      console.error('Failed to refresh recent workspaces:', err)
    }
  }

  const closeWorkspaceTab = async (targetPath: string) => {
    const closingCurrent = targetPath === workspace
    if (closingCurrent && !(await confirmCloseWorkspace())) return

    // 只释放该工作区的 Agent 与会话资源
    await piAgentAPI.dispose(targetPath)
    await api.disposeWorkspace(targetPath).catch(() => undefined)
    clearWorkspaceChat(targetPath)
    const nextWorkspace = useWorkspaceStore.getState().closeWorkspace(targetPath)

    if (!closingCurrent) return

    setError(null)
    await api.unwatchWorkspace().catch(() => undefined)
    resetWorkspaceState()

    if (nextWorkspace) {
      api.watchWorkspace(nextWorkspace).catch((err) => {
        const detail = err instanceof Error ? err.message : String(err)
        console.error('Failed to watch workspace:', err)
        toast.error(t('watchWorkspaceFailed', { error: localizeError(detail) }))
      })
    }
  }

  const startResize = useCallback(
    (target: 'sidebar' | 'chat') => (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const startX = event.clientX
      const initial = target === 'sidebar' ? sidebarWidth : chatWidth

      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX
        if (target === 'sidebar') {
          setSidebarWidth(clamp(initial + delta, SIDEBAR_MIN, SIDEBAR_MAX))
        } else {
          setChatWidth(clamp(initial - delta, CHAT_MIN, CHAT_MAX))
        }
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [sidebarWidth, chatWidth]
  )

  const headerLink =
    'type-label text-ink-muted transition-colors hover:text-ink'

  return (
    <div className="flex h-screen flex-col bg-surface text-ink">
      {showSettings && (
        <Modal
          open={showSettings}
          onClose={() => setShowSettings(false)}
          title={t('settings')}
          size="lg"
          closeLabel={t('close')}
        >
          <Settings
            onClose={() => setShowSettings(false)}
            initialSection={settingsSection}
          />
        </Modal>
      )}

      {/* Header */}
      <header
        className={`app-drag flex h-[var(--titlebar-height)] flex-shrink-0 select-none items-center justify-between gap-4 border-b border-rule-divide bg-panel ${
          usesMacTrafficLights ? 'pl-[78px]' : 'pl-4'
        } ${usesCustomWindowControls ? 'pr-0' : 'pr-4'}`}
        onDoubleClick={(event) => {
          if (!usesCustomWindowControls) return
          const target = event.target as HTMLElement
          if (target.closest('button, a, input, select, textarea')) return
          void window.electronAPI?.toggleMaximizeWindow()
        }}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="type-brand text-ink">Pi</span>
          <span className="type-wordmark text-ink-muted">
            Workbench
          </span>
          <span className="border border-rule-control px-1.5 py-0.5 type-caption font-medium text-ink-muted">
            LOCAL
          </span>
          {workspace && (
            <>
              <div className="mx-2 h-4 w-px flex-shrink-0 bg-rule-divide" />
              <span
                className="flex min-w-0 items-center gap-1.5 type-data text-ink-muted"
                title={workspace}
              >
                <Folder size={11} className="flex-shrink-0" />
                <span className="truncate">{workspace}</span>
              </span>
            </>
          )}
        </div>

        <div className="flex h-full flex-shrink-0 items-center">
          <div className={`flex items-center gap-4 ${usesCustomWindowControls ? 'pr-3' : ''}`}>
          {workspace && (
            <>
              <div className="flex items-center gap-0.5">
                <IconButton
                  icon={PanelLeft}
                  label={t('toggleSidebar')}
                  size="sm"
                  active={showSidebar}
                  onClick={() => setShowSidebar((value) => !value)}
                />
                <IconButton
                  icon={PanelRight}
                  label={t('toggleChat')}
                  size="sm"
                  active={showChat}
                  onClick={() => setShowChat((value) => !value)}
                />
              </div>
              <button
                type="button"
                className={headerLink}
                onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}
              >
                {t('commandPalette')}{' '}
                <span className="type-key text-ink-muted">{commandPaletteShortcut()}</span>
              </button>
              {workspace && activeCount > 0 && (
                <div className="relative">
                  <button
                    type="button"
                    className={headerLink}
                    onClick={() => setShowActivity((value) => !value)}
                  >
                    <span className="inline-flex items-center gap-1">
                      <Activity size={11} />
                      {t('activityCount', { count: activeCount })}
                    </span>
                  </button>
                  {showActivity && (
                    <div className="absolute right-0 top-full z-30 mt-1 w-64 border border-line bg-raised shadow-print">
                      {streamingSessions.length > 0 && (
                        <div className="border-b border-rule-divide py-1">
                          {streamingSessions.map((session) => (
                            <button
                              key={session.id}
                              type="button"
                              onClick={() => {
                                useSessionStore.getState().setActive(workspace, session.id)
                                setShowActivity(false)
                              }}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink transition-colors hover:bg-hover"
                            >
                              <span className="h-1 w-1 flex-shrink-0 animate-pulse rounded-full bg-accent" />
                              <span className="truncate">
                                {session.title || t('untitledSession')}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                      {fleetActive > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowFleet(true)
                            setShowActivity(false)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink transition-colors hover:bg-hover"
                        >
                          <span className="h-1 w-1 flex-shrink-0 rounded-full bg-warning" />
                          {t('activeFleetTasks', { count: fleetActive })}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              <button type="button" className={headerLink} onClick={() => setShowFleet(true)}>
                {t('fleetTasks')}
              </button>
              <button
                type="button"
                className={headerLink}
                onClick={() => setShowTerminal((value) => !value)}
              >
                {t('terminal')}
              </button>
            </>
          )}
          {import.meta.env.DEV && (
            <IconButton
              icon={Bug}
              label={t('ipcDebug')}
              size="sm"
              active={showDebug}
              onClick={() => setShowDebug((value) => !value)}
            />
          )}
          <button type="button" className={headerLink} onClick={() => openSettings()}>
            {t('settings')}
          </button>
          <Button
            variant={workspace ? 'secondary' : 'primary'}
            size="sm"
            icon={workspace ? X : FolderOpen}
            onClick={() => (workspace ? void closeWorkspaceTab(workspace) : void pickWorkspace())}
          >
            {workspace ? t('closeProject') : t('openProject')}
          </Button>
          </div>
          {usesCustomWindowControls && <WindowControls />}
        </div>
      </header>

      {/* Workspace tabs */}
      {openWorkspaces.length > 0 && (
        <div className="flex flex-shrink-0 items-center overflow-x-auto border-b border-rule-divide bg-panel px-2">
          {openWorkspaces.map((path) => {
            const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
            const active = path === workspace
            return (
              <div
                key={path}
                className={`group flex h-8 items-center gap-2 border-r border-rule-divide px-3 type-label ${
                  active
                    ? 'bg-surface text-ink shadow-[inset_0_2px_0_rgb(var(--accent))]'
                    : 'text-ink-muted hover:bg-hover hover:text-ink'
                }`}
              >
                <button
                  type="button"
                  onClick={() => void openWorkspaceAt(path)}
                  title={path}
                  className="flex max-w-[200px] items-center gap-1.5 bg-transparent text-inherit"
                >
                  <Folder size={11} className="flex-shrink-0 opacity-70" />
                  <span className="truncate">{name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void closeWorkspaceTab(path)}
                  title={t('close')}
                  aria-label={t('close')}
                  className="flex h-4 w-4 items-center justify-center text-ink-muted hover:text-ink"
                >
                  <X size={10} />
                </button>
              </div>
            )
          })}
          <IconButton
            icon={Plus}
            label={t('openProject')}
            size="sm"
            onClick={() => void pickWorkspace()}
          />
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-danger/30 bg-danger/10 px-4 py-1.5 type-caption text-danger">
          <p className="m-0 flex-1">{error}</p>
          <IconButton
            icon={X}
            label={t('close')}
            size="sm"
            onClick={() => setError(null)}
          />
        </div>
      )}

      <UpdateDialog />
      <DialogHost />
      <ToastContainer messages={toastMessages} onClose={removeToast} />
      {workspace && <CommandPalette workspacePath={workspace} />}
      {workspace && (
        <FleetPanel
          workspacePath={workspace}
          open={showFleet}
          onClose={() => setShowFleet(false)}
        />
      )}
      <DiffViewer />

      {/* Debug panel */}
      {showDebug && (
        <div className="fixed bottom-4 right-4 z-30 max-h-80 w-96 overflow-y-auto border border-line bg-raised p-3 shadow-print">
          <IPCDebug />
        </div>
      )}

      {/* Main Content */}
      {workspace ? (
        <main className="flex min-h-0 flex-1 bg-surface">
          {showSidebar && (
            <>
              <aside
                className="flex-shrink-0 overflow-hidden bg-panel"
                style={{ width: sidebarWidth }}
              >
                <FileExplorer workspacePath={workspace} />
              </aside>
              <div
                role="separator"
                aria-orientation="vertical"
                className="w-0.5 flex-shrink-0 cursor-col-resize bg-rule-seam transition-colors hover:bg-accent"
                onPointerDown={startResize('sidebar')}
              />
            </>
          )}

          <section className="flex min-w-0 flex-1 flex-col">
            <Suspense
              fallback={
                <div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
                  <Spinner size={14} />
                </div>
              }
            >
              <MonacoEditor />
            </Suspense>
            <TerminalPanel
              key={workspace}
              workspacePath={workspace}
              visible={showTerminal}
              onClose={() => setShowTerminal(false)}
            />
          </section>

          {showChat && (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                className="w-0.5 flex-shrink-0 cursor-col-resize bg-rule-seam transition-colors hover:bg-accent"
                onPointerDown={startResize('chat')}
              />
              <aside
                className="flex-shrink-0 overflow-hidden bg-panel"
                style={{ width: chatWidth }}
              >
                <ChatPanel workspacePath={workspace} />
              </aside>
            </>
          )}
        </main>
      ) : (
        <WelcomeScreen
          recentWorkspaces={recentWorkspaces}
          onOpenProject={() => void pickWorkspace()}
          onOpenWorkspace={(path) => void openWorkspaceAt(path)}
          onOpenSettings={() => openSettings()}
          onRefreshRecent={() => void refreshRecentWorkspaces()}
        />
      )}

      <footer className="flex h-7 flex-shrink-0 items-center gap-4 border-t border-rule-divide bg-panel px-3.5 type-caption text-ink-muted">
        <span className="text-ink-muted">PI WORKBENCH</span>
        <span>LOCAL-FIRST</span>
        {workspace && <span className="text-accent">● PI AGENT</span>}
        <div className="ml-auto flex items-center gap-4">
          <UpdateStatusIndicator onOpenSettings={() => openSettings('about')} />
          {currentFile && <span>{fileLanguage}</span>}
          <span>UTF-8</span>
          <span>{resolvedTheme === 'dark' ? 'INK' : 'PAPER'}</span>
        </div>
      </footer>
    </div>
  )
}
