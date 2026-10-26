import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Bug,
  Folder,
  FolderOpen,
  Home,
  Plus,
  X,
} from 'lucide-react'
import { api } from './api'
import { piAgentAPI } from './api/piAgentAPI'
import { IPCDebug } from './components/IPCDebug'
import { BrandSeal } from './components/BrandSeal'
import { Settings, type SettingsSection } from './components/Settings'
import { UpdateDialog } from './components/UpdateDialog'
import { UpdateStatusIndicator } from './components/UpdateStatusIndicator'
import { CommandPalette } from './components/CommandPalette'
import { ToastContainer } from './components/Toast'
import { DialogHost } from './components/DialogHost'
import { WelcomeScreen } from './components/WelcomeScreen'
import { WindowControls } from './components/WindowControls'
import { WorkspaceView } from './components/WorkspaceView'
import { Button, IconButton, Modal } from './components/ui'
import { useToastStore, toast } from './store/toastStore'
import { useI18nStore } from './store/i18nStore'
import { useThemeStore, useResolvedTheme, type ThemeMode } from './store/themeStore'
import { useWorkspaceStore } from './store/workspaceStore'
import { useEditorStore, editorStoreFor, disposeEditorStore } from './store/editorStore'
import { disposeDiffStore } from './store/diffStore'
import { useChatStore } from './store/chatStore'
import { useSessionStore } from './store/sessionStore'
import { confirmDialog } from './store/dialogStore'
import { useSettingsStore } from './store/settingsStore'
import { useApprovalStore } from './store/approvalStore'
import { hasRunningWork } from './utils/runningWork'
import { useUpdaterStore } from './store/updaterStore'
import { localizeError } from './i18n/errors'
import { formatShortcut, matchShortcut } from './utils/keybindings'
import { restoreEditorTabs, saveEditorTabs } from './workspace/editorTabs'
import { basename } from './utils/filePath'
import { emitAppEvent, onAppEvent } from './utils/appEvents'

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
  const [showHome, setShowHome] = useState(true)
  const [showActivity, setShowActivity] = useState(false)
  const toastMessages = useToastStore((state) => state.messages)
  const removeToast = useToastStore((state) => state.remove)
  const sessionsByWorkspace = useSessionStore((state) => state.byWorkspace)
  const streamingMap = useSessionStore((state) => state.streaming)
  const errorsMap = useSessionStore((state) => state.errors)
  const needsActionMap = useSessionStore((state) => state.needsAction)
  const streamingSessions = openWorkspaces.flatMap((path) => {
    const sessions = sessionsByWorkspace[path]?.sessions ?? []
    return sessions
      .filter((session) => streamingMap[`${path}\u0000${session.id}`])
      .map((session) => ({ session, workspacePath: path }))
  })
  const activeCount = streamingSessions.length
  const { t, setLanguage, language } = useI18nStore()
  const { setMode } = useThemeStore()
  const resolvedTheme = useResolvedTheme()
  const currentFile = useEditorStore(workspace, (state) => state.currentFile)
  const platform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined
  const usesMacTrafficLights = platform === 'darwin'
  const usesCustomWindowControls = !!platform && platform !== 'darwin' && platform !== 'web'

  /** 工作区标签上只显示一个最高优先级的状态标记 */
  const workspaceActivity = (path: string): 'needsAction' | 'error' | 'running' | null => {
    const prefix = `${path}\u0000`
    if (Object.keys(needsActionMap).some((key) => key.startsWith(prefix))) return 'needsAction'
    if (Object.keys(errorsMap).some((key) => key.startsWith(prefix))) return 'error'
    if (Object.keys(streamingMap).some((key) => key.startsWith(prefix))) return 'running'
    return null
  }

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
    const openSettingsEvent = (detail?: { section?: SettingsSection }) =>
      openSettings(detail?.section ?? 'general')
    return onAppEvent('open-settings', openSettingsEvent)
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
    const offRequest = piAgentAPI.onApprovalRequest((request) => {
      useApprovalStore.getState().add(request)
      useSessionStore.getState().markNeedsAction(request.workspaceDir, request.sessionId, 'input')
    })
    // 超时 / 中止等非用户操作结束时，主进程会通知移除卡片
    const offResolved = piAgentAPI.onApprovalResolved(({ requestId, workspaceDir, sessionId }) => {
      useApprovalStore.getState().remove(requestId)
      const remaining = useApprovalStore
        .getState()
        .requests.some(
          (item) => item.workspaceDir === workspaceDir && item.sessionId === sessionId
        )
      if (!remaining) {
        useSessionStore.getState().markNeedsAction(workspaceDir, sessionId, null)
      }
    })
    return () => {
      offRequest()
      offResolved()
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

  // 有未保存修改或运行中的任务时阻止关闭窗口；关闭前尽力把固定状态落盘
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      const dirty = openWorkspaces.some((path) =>
        editorStoreFor(path).getState().hasDirtyFiles()
      )
      if (dirty || hasRunningWork()) {
        event.preventDefault()
        event.returnValue = ''
      }
      for (const path of openWorkspaces) {
        void saveEditorTabs(path)
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [openWorkspaces])

  // Ctrl/Cmd+, 打开设置（可在设置中改键）
  const settingsShortcut = useSettingsStore((state) => state.keybindings.settings)
  const paletteShortcut = useSettingsStore((state) => state.keybindings.commandPalette)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchShortcut(event, settingsShortcut)) {
        event.preventDefault()
        openSettings()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSettings, settingsShortcut])

  const clearWorkspaceChat = (targetPath: string) => {
    useSessionStore.getState().resetWorkspace(targetPath)
    const chat = useChatStore.getState()
    const prefix = `${targetPath}\u0000`
    for (const key of Object.keys(chat.conversations)) {
      if (key.startsWith(prefix)) chat.removeConversation(key)
    }
  }

  const confirmCloseWorkspace = async (targetPath: string): Promise<boolean> => {
    const dirty = editorStoreFor(targetPath).getState().hasDirtyFiles()
    const active = hasRunningWork(targetPath)
    if (!dirty && !active) return true
    const message = dirty
      ? active
        ? t('closeProjectDirtyActiveConfirm')
        : t('discardChangesConfirm')
      : t('closeProjectActiveConfirm')
    return confirmDialog({
      title: t('closeProjectTitle'),
      message,
      confirmLabel: t('continueClose'),
      cancelLabel: t('cancel'),
      danger: true,
    })
  }

  const openWorkspaceAt = async (targetPath: string, initialPrompt?: string) => {
    // 快速双击/连续选择时只处理第一次，避免 init/watch 交错
    if (openingWorkspaceRef.current) return
    openingWorkspaceRef.current = true
    try {
      setError(null)

      // 已打开：只切视图，不重新初始化、不重置任何状态
      if (openWorkspaces.includes(targetPath)) {
        activateWorkspace(targetPath)
        setShowHome(false)
        if (initialPrompt) {
          useChatStore.getState().setPendingDraft(initialPrompt, targetPath)
        }
        return
      }

      // 初始化工作区目录（.pi-workbench）
      const initResult = await api.initWorkspace(targetPath)
      if (!initResult.success) {
        setError(initResult.error ? localizeError(initResult.error) : t('initWorkspaceFailed'))
        return
      }

      // 其他已打开工作区的视图、监听和 Agent 实例全部保持原样
      activateWorkspace(targetPath)
      setShowHome(false)

      // 恢复固定状态：上次的编辑器标签
      const restored = await restoreEditorTabs(targetPath)
      if (restored.skipped > 0) {
        toast.info(t('editorTabsRestoreSkipped', { count: restored.skipped }))
      }

      // 上次异常退出留下的未保存草稿：询问用户是否恢复
      try {
        const drafts = await api.draftList(targetPath)
        if (drafts.success && drafts.drafts.length > 0) {
          const store = editorStoreFor(targetPath)
          if (await confirmDialog({ message: t('recoverDraftsConfirm', { count: drafts.drafts.length }) })) {
            for (const draft of drafts.drafts) {
              const existing = store
                .getState()
                .openFiles.find((file) => file.path === draft.path)
              if (existing) {
                store.getState().updateOpenFile(draft.path, {
                  content: draft.content,
                  isDirty: true,
                })
                store.getState().markDirty(draft.path)
              } else {
                store.getState().addOpenFile({
                  path: draft.path,
                  name: basename(draft.path) || draft.path,
                  content: draft.content,
                  isDirty: true,
                  isSaving: false,
                })
                store.getState().markDirty(draft.path)
              }
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
        useChatStore.getState().setPendingDraft(initialPrompt, targetPath)
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
        if (workspaceDir) {
          await openWorkspaceRef.current(workspaceDir)
        }
        useSessionStore.getState().requestActivation(workspaceDir, sessionId)
      })()
    })
    return () => off()
  }, [])

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
    if (!(await confirmCloseWorkspace(targetPath))) return

    // 固定状态先落盘，再释放运行时；关闭标签不删除磁盘上的固定状态
    await saveEditorTabs(targetPath)
    await piAgentAPI.dispose(targetPath)
    await api.disposeWorkspace(targetPath).catch(() => undefined)
    await api.unwatchWorkspace(targetPath).catch(() => undefined)
    clearWorkspaceChat(targetPath)

    const wasActive = targetPath === workspace
    const wasHome = showHome
    const nextWorkspace = useWorkspaceStore.getState().closeWorkspace(targetPath)

    if (wasActive && !wasHome && !nextWorkspace) {
      setShowHome(true)
    }

    // 视图卸载后再释放按工作区的 store
    window.setTimeout(() => {
      disposeEditorStore(targetPath)
      disposeDiffStore(targetPath)
    }, 0)
  }

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
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex items-baseline gap-2">
            <BrandSeal size={20} />
            <span className="type-wordmark text-ink-muted">Workbench</span>
            <span className="mx-0.5 h-3 w-px self-center bg-rule-divide" aria-hidden="true" />
            <span className="type-signature text-ink-muted">TChen</span>
          </div>
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
              <button
                type="button"
                className={headerLink}
                onClick={() => emitAppEvent('open-command-palette')}
              >
                {t('commandPalette')}{' '}
                <span className="type-key text-ink-muted">{formatShortcut(paletteShortcut)}</span>
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
                          {streamingSessions.map(({ session, workspacePath: streamingWorkspace }) => (
                            <button
                              key={`${streamingWorkspace}\u0000${session.id}`}
                              type="button"
                              onClick={() => {
                                activateWorkspace(streamingWorkspace)
                                setShowHome(false)
                                useSessionStore.getState().setActive(streamingWorkspace, session.id)
                                setShowActivity(false)
                              }}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink transition-colors hover:bg-hover"
                            >
                              <span className="h-1 w-1 flex-shrink-0 animate-pulse rounded-full bg-accent" />
                              <span className="truncate">
                                {session.title || t('untitledSession')}
                              </span>
                              {openWorkspaces.length > 1 && (
                                <span className="ml-auto flex-shrink-0 type-caption text-ink-muted">
                                  {basename(streamingWorkspace)}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {!showHome && (
                <button
                  type="button"
                  className={headerLink}
                  onClick={() =>
                    emitAppEvent('workspace-toggle-terminal')
                  }
                >
                  {t('terminal')}
                </button>
              )}
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
          {workspace ? (
            <Button
              variant={showHome ? 'primary' : 'secondary'}
              size="sm"
              icon={showHome ? ArrowLeft : Home}
              onClick={() => setShowHome((value) => !value)}
            >
              {showHome ? t('backToWorkspace') : t('backToHome')}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={FolderOpen}
              onClick={() => void pickWorkspace()}
            >
              {t('openProject')}
            </Button>
          )}
          </div>
          {usesCustomWindowControls && <WindowControls />}
        </div>
      </header>

      {/* Workspace tabs */}
      {openWorkspaces.length > 0 && (
        <div className="flex flex-shrink-0 items-center overflow-x-auto border-b border-rule-divide bg-panel px-2">
          {openWorkspaces.map((path) => {
            const name = basename(path) ?? path
            const active = path === workspace
            const status = workspaceActivity(path)
            const statusLabel =
              status === 'needsAction'
                ? t('sessionNeedsAction')
                : status === 'error'
                  ? t('sessionError')
                  : status === 'running'
                    ? t('sessionRunning')
                    : ''
            const accessible = statusLabel ? `${name} · ${statusLabel}` : name
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
                  onClick={() => {
                    activateWorkspace(path)
                    setShowHome(false)
                  }}
                  title={statusLabel ? `${path} · ${statusLabel}` : path}
                  aria-label={accessible}
                  aria-busy={status === 'running' || undefined}
                  className="flex max-w-[200px] items-center gap-1.5 bg-transparent text-inherit"
                >
                  <Folder size={11} className="flex-shrink-0 opacity-70" />
                  <span className="truncate">{name}</span>
                  {status === 'running' ? (
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-accent"
                    />
                  ) : status === 'error' ? (
                    <AlertCircle
                      size={10}
                      className="flex-shrink-0 text-danger"
                      aria-hidden="true"
                    />
                  ) : status === 'needsAction' ? (
                    <span
                      aria-hidden="true"
                      className="relative flex h-1.5 w-1.5 flex-shrink-0 items-center justify-center rounded-full border border-warning shadow-[0_0_0_2px_rgb(var(--warning)_/_0.18)] animate-breathe"
                    />
                  ) : null}
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
      {workspace && <CommandPalette workspacePath={workspace} active={!showHome} />}

      {/* Debug panel */}
      {showDebug && (
        <div className="fixed bottom-4 right-4 z-30 max-h-80 w-96 overflow-y-auto border border-line bg-raised p-3 shadow-print">
          <IPCDebug />
        </div>
      )}

      {/* 每个打开的工作区常驻一个视图；首页只是切换可见性 */}
      <div className="relative flex min-h-0 flex-1 bg-surface">
        {openWorkspaces.map((path) => (
          <WorkspaceView
            key={path}
            workspacePath={path}
            active={!showHome && path === workspace}
          />
        ))}
        {(showHome || !workspace) && (
          <div className="absolute inset-0 flex flex-col overflow-hidden bg-surface">
            <WelcomeScreen
              recentWorkspaces={recentWorkspaces}
              onOpenProject={() => void pickWorkspace()}
              onOpenWorkspace={(path) => void openWorkspaceAt(path)}
              onOpenSettings={() => openSettings()}
              onRefreshRecent={() => void refreshRecentWorkspaces()}
            />
          </div>
        )}
      </div>

      <footer className="flex h-7 flex-shrink-0 items-center gap-4 border-t border-rule-divide bg-panel px-3.5 type-caption text-ink-muted">
        <span className="text-ink-muted">PI WORKBENCH</span>
        <span>LOCAL-FIRST</span>
        {workspace && (
          <span className="flex items-center gap-1.5 text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
            PI AGENT
          </span>
        )}
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
