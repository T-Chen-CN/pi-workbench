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
import { Settings } from './components/Settings'
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
import { useDiffStore } from './store/diffStore'
import { confirmDialog } from './store/dialogStore'
import { useSettingsStore } from './store/settingsStore'
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
  const [showTerminal, setShowTerminal] = useState(false)
  const [showFleet, setShowFleet] = useState(false)
  const [showSidebar, setShowSidebar] = useState(true)
  const [showChat, setShowChat] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(232)
  const [chatWidth, setChatWidth] = useState(336)
  const toastMessages = useToastStore((state) => state.messages)
  const removeToast = useToastStore((state) => state.remove)
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
  useEffect(() => {
    const openSettings = () => setShowSettings(true)
    window.addEventListener('open-settings', openSettings)
    return () => window.removeEventListener('open-settings', openSettings)
  }, [])

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
        setShowSettings(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const resetWorkspaceState = () => {
    useEditorStore.getState().reset()
    useChatStore.getState().reset()
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
        useChatStore.getState().setDraftInput(initialPrompt)
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

  /** 欢迎页提问：先选目录，再打开工作区并带入问题 */
  const askFromWelcome = async (prompt: string) => {
    try {
      setError(null)
      const result = await api.openDirectoryDialog()
      if (result.success && !result.canceled && result.path) {
        await openWorkspaceAt(result.path, prompt)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(localizeError(message))
      console.error('Failed to open workspace from welcome prompt:', err)
    }
  }

  const closeWorkspaceTab = async (targetPath: string) => {
    const closingCurrent = targetPath === workspace
    if (closingCurrent && !(await confirmCloseWorkspace())) return

    // 只释放该工作区的 Agent 与会话资源
    await piAgentAPI.dispose(targetPath)
    await api.disposeWorkspace(targetPath).catch(() => undefined)
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
    'font-mono text-[10.5px] text-ink-muted transition-colors hover:text-ink'

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
          <Settings onClose={() => setShowSettings(false)} />
        </Modal>
      )}

      {/* Header */}
      <header
        className={`app-drag flex h-[var(--titlebar-height)] flex-shrink-0 select-none items-center justify-between gap-4 border-b border-line bg-surface ${
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
          <span className="font-display text-2xl leading-none text-ink">Pi</span>
          <span className="font-mono text-[8.5px] uppercase tracking-[0.2em] text-ink-subtle">
            Workbench
          </span>
          <span className="border border-line px-1.5 py-0.5 font-mono text-[8px] tracking-[0.12em] text-ink-subtle">
            LOCAL
          </span>
          {workspace && (
            <>
              <div className="mx-2 h-4 w-px flex-shrink-0 bg-line" />
              <span
                className="flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-ink-subtle"
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
                <span className="text-ink-subtle">{commandPaletteShortcut()}</span>
              </button>
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
          <button type="button" className={headerLink} onClick={() => setShowSettings(true)}>
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
        <div className="flex flex-shrink-0 items-center overflow-x-auto border-b border-line bg-surface px-2">
          {openWorkspaces.map((path) => {
            const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
            const active = path === workspace
            return (
              <div
                key={path}
                className={`group flex h-8 items-center gap-2 border-r border-line px-3 font-mono text-[10.5px] ${
                  active
                    ? 'bg-panel text-ink shadow-[inset_0_2px_0_rgb(var(--accent))]'
                    : 'text-ink-subtle hover:bg-hover hover:text-ink'
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
                  className="flex h-4 w-4 items-center justify-center text-ink-subtle hover:text-ink"
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
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-danger/30 bg-danger/10 px-4 py-1.5 text-xs text-danger">
          <p className="m-0 flex-1">{error}</p>
          <IconButton
            icon={X}
            label={t('close')}
            size="sm"
            onClick={() => setError(null)}
          />
        </div>
      )}

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
        <div className="fixed bottom-4 right-4 z-30 max-h-80 w-96 overflow-y-auto border border-line bg-panel p-3 shadow-print">
          <IPCDebug />
        </div>
      )}

      {/* Main Content */}
      {workspace ? (
        <main className="flex min-h-0 flex-1 bg-surface">
          {showSidebar && (
            <>
              <aside
                className="flex-shrink-0 overflow-hidden border-r border-line bg-panel"
                style={{ width: sidebarWidth }}
              >
                <FileExplorer workspacePath={workspace} />
              </aside>
              <div
                role="separator"
                aria-orientation="vertical"
                className="w-px flex-shrink-0 cursor-col-resize bg-line transition-colors hover:bg-accent"
                onPointerDown={startResize('sidebar')}
              />
            </>
          )}

          <section className="flex min-w-0 flex-1 flex-col">
            <Suspense
              fallback={
                <div className="flex min-h-0 flex-1 items-center justify-center bg-panel">
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
                className="w-px flex-shrink-0 cursor-col-resize bg-line transition-colors hover:bg-accent"
                onPointerDown={startResize('chat')}
              />
              <aside
                className="flex-shrink-0 overflow-hidden border-l border-line bg-panel"
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
          onAsk={(prompt) => void askFromWelcome(prompt)}
        />
      )}

      <footer className="flex h-7 flex-shrink-0 items-center gap-4 border-t border-line bg-surface px-3.5 font-mono text-[9px] uppercase tracking-[0.06em] text-ink-subtle">
        <span className="text-ink-muted">PI WORKBENCH</span>
        <span>LOCAL-FIRST</span>
        {workspace && <span className="text-accent">● PI AGENT</span>}
        <div className="ml-auto flex items-center gap-4">
          {currentFile && <span>{fileLanguage}</span>}
          <span>UTF-8</span>
          <span>{resolvedTheme === 'dark' ? 'INK' : 'PAPER'}</span>
        </div>
      </footer>
    </div>
  )
}
