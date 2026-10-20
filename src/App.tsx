import { useState, useEffect } from 'react'
import { api } from './api'
import { piAgentAPI } from './api/piAgentAPI'
import { FileExplorer } from './components/FileExplorer'
import { MonacoEditor } from './components/MonacoEditor'
import { ChatPanel } from './components/ChatPanel'
import { DiffViewer } from './components/DiffViewer'
import { IPCDebug } from './components/IPCDebug'
import { Settings } from './components/Settings'
import { ToastContainer } from './components/Toast'
import { useToastStore } from './store/toastStore'
import { useI18nStore } from './store/i18nStore'
import { useWorkspaceStore } from './store/workspaceStore'
import { useEditorStore } from './store/editorStore'
import { useChatStore } from './store/chatStore'
import { useDiffStore } from './store/diffStore'

export default function App() {
  const {
    workspacePath: workspace,
    openWorkspaces,
    recentWorkspaces,
    openWorkspace: activateWorkspace,
    setRecentWorkspaces,
  } = useWorkspaceStore()
  const [error, setError] = useState<string | null>(null)
  const [showDebug, setShowDebug] = useState(import.meta.env.DEV)
  const [showSettings, setShowSettings] = useState(false)
  const toastMessages = useToastStore((state) => state.messages)
  const removeToast = useToastStore((state) => state.remove)

  // 允许子组件（如 ChatPanel）请求打开设置面板
  useEffect(() => {
    const openSettings = () => setShowSettings(true)
    window.addEventListener('open-settings', openSettings)
    return () => window.removeEventListener('open-settings', openSettings)
  }, [])
  const { t, setLanguage, language } = useI18nStore()

  // 初始化语言为中文
  useEffect(() => {
    if (language !== 'zh') {
      setLanguage('zh')
    }
  }, [language, setLanguage])

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

  const resetWorkspaceState = () => {
    useEditorStore.getState().reset()
    useChatStore.getState().reset()
    useDiffStore.getState().clearDiff()
  }

  const confirmCloseWorkspace = (): boolean => {
    if (!useEditorStore.getState().hasDirtyFiles()) return true
    return window.confirm(t('discardChangesConfirm'))
  }

  const openWorkspaceAt = async (targetPath: string) => {
    try {
      setError(null)

      if (targetPath === workspace) return

      if (workspace && !confirmCloseWorkspace()) {
        return
      }

      // 初始化工作区目录（.pi-workbench）
      const initResult = await api.initWorkspace(targetPath)
      if (!initResult.success) {
        setError(initResult.error || 'Failed to initialize workspace')
        return
      }

      // 切换当前工作区：停止旧监听、重置 UI 状态，但保留各工作区的 Agent 实例
      await api.unwatchWorkspace().catch(() => undefined)
      resetWorkspaceState()

      activateWorkspace(targetPath)

      api.watchWorkspace(targetPath).catch((err) =>
        console.error('Failed to watch workspace:', err)
      )

      const recent = await api.addRecentWorkspace(targetPath)
      if (recent.success) setRecentWorkspaces(recent.workspaces)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      console.error('Failed to open workspace:', err)
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
      setError(message)
      console.error('Failed to open workspace:', err)
    }
  }

  const closeWorkspaceTab = async (targetPath: string) => {
    const closingCurrent = targetPath === workspace
    if (closingCurrent && !confirmCloseWorkspace()) return

    // 只释放该工作区的 Agent 与会话资源
    await piAgentAPI.dispose(targetPath)
    const nextWorkspace = useWorkspaceStore.getState().closeWorkspace(targetPath)

    if (!closingCurrent) return

    await api.unwatchWorkspace().catch(() => undefined)
    resetWorkspaceState()

    if (nextWorkspace) {
      api.watchWorkspace(nextWorkspace).catch((err) =>
        console.error('Failed to watch workspace:', err)
      )
    }
  }

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-[#1e1e1e]">
      {showSettings && (
        <div className="fixed inset-0 z-40 bg-gray-900 overflow-auto">
          <Settings onClose={() => setShowSettings(false)} />
        </div>
      )}

      {/* Header */}
      <header className="flex justify-between items-center px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#252526] flex-shrink-0 gap-4">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('appTitle')}</h1>
        <div className="flex items-center gap-3">
          {workspace && (
            <span className="text-gray-600 dark:text-gray-400 text-sm max-w-xs overflow-hidden text-ellipsis whitespace-nowrap">
              {workspace}
            </span>
          )}
          {import.meta.env.DEV && (
            <button
              onClick={() => setShowDebug(!showDebug)}
              className="bg-none border-none cursor-pointer text-lg p-1 opacity-60 hover:opacity-100 transition-opacity"
            >
              {showDebug ? '🐛' : '⚙️'}
            </button>
          )}
          <button
            onClick={() => setShowSettings(!showSettings)}
            title={t('settings')}
            className="bg-none border-none cursor-pointer text-lg p-1 opacity-60 hover:opacity-100 transition-opacity"
          >
            ⚙️
          </button>
          <button
            onClick={() => (workspace ? void closeWorkspaceTab(workspace) : void pickWorkspace())}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white border-none rounded transition-colors text-sm font-medium"
          >
            {workspace ? t('closeProject') : t('openProject')}
          </button>
        </div>
      </header>

      {/* Workspace tabs */}
      {openWorkspaces.length > 0 && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#252526] overflow-x-auto flex-shrink-0">
          {openWorkspaces.map((path) => {
            const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
            const active = path === workspace
            return (
              <div
                key={path}
                className={`flex items-center rounded text-sm ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                }`}
              >
                <button
                  onClick={() => void openWorkspaceAt(path)}
                  title={path}
                  className="px-3 py-1 bg-none border-none cursor-pointer text-inherit"
                >
                  {name}
                </button>
                <button
                  onClick={() => void closeWorkspaceTab(path)}
                  title={t('close')}
                  className={`px-1.5 py-1 bg-none border-none cursor-pointer text-inherit ${
                    active ? 'hover:text-gray-200' : 'hover:text-gray-900 dark:hover:text-gray-100'
                  }`}
                >
                  ×
                </button>
              </div>
            )
          })}
          <button
            onClick={() => void pickWorkspace()}
            title={t('openProject')}
            className="px-2 py-1 text-sm bg-none border-none cursor-pointer text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
          >
            ＋
          </button>
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div className="flex justify-between items-center px-4 py-2 bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-b border-red-300 dark:border-red-700/50 flex-shrink-0">
          <p className="m-0 flex-1">{error}</p>
          <button
            onClick={() => setError(null)}
            className="bg-none border-none text-red-700 dark:text-red-400 cursor-pointer text-xl p-1"
          >
            ×
          </button>
        </div>
      )}

      {/* Debug Panel */}
      {showDebug && (
        <div className="fixed bottom-5 right-5 w-96 max-h-80 bg-gray-50 dark:bg-[#252526] border-2 border-blue-600 rounded-lg p-4 shadow-lg overflow-y-auto z-50 text-xs">
          <IPCDebug />
        </div>
      )}

      <ToastContainer messages={toastMessages} onClose={removeToast} />
      <DiffViewer />

      {/* Main Content */}
      <main className="flex-1 overflow-hidden flex bg-white dark:bg-[#1e1e1e]">
        {workspace ? (
          <div className="grid grid-cols-[250px_1fr_300px] w-full h-full gap-px bg-gray-300 dark:bg-gray-700">
            {/* Sidebar */}
            <aside className="bg-gray-50 dark:bg-[#252526] border-r border-gray-200 dark:border-gray-700 overflow-y-auto">
              <FileExplorer workspacePath={workspace} />
            </aside>

            {/* Editor Section */}
            <section className="flex flex-col bg-white dark:bg-[#1e1e1e]">
              <MonacoEditor />
            </section>

            {/* Chat Section */}
            <aside className="bg-gray-50 dark:bg-[#252526] border-l border-gray-200 dark:border-gray-700 overflow-y-auto">
              <ChatPanel workspacePath={workspace} />
            </aside>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-600 dark:text-gray-400 text-center gap-5 p-6">
            <h2 className="text-2xl text-gray-900 dark:text-gray-100 m-0">{t('welcome')}</h2>
            <p className="text-base m-0">{t('welcomeSubtitle')}</p>
            <button
              onClick={pickWorkspace}
              className="px-6 py-2.5 text-base bg-blue-600 hover:bg-blue-700 text-white border-none rounded transition-colors font-medium"
            >
              {t('openProject')}
            </button>

            {recentWorkspaces.length > 0 && (
              <div className="w-full max-w-lg mt-2 text-left">
                <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-500 mb-2">
                  {t('recentWorkspaces')}
                </p>
                <div className="flex flex-col gap-1">
                  {recentWorkspaces.map((recentPath) => (
                    <button
                      key={recentPath}
                      onClick={() => openWorkspaceAt(recentPath)}
                      title={recentPath}
                      className="w-full text-left px-3 py-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#252526] hover:bg-gray-100 dark:hover:bg-[#2d2d30] text-sm text-gray-700 dark:text-gray-300 overflow-hidden text-ellipsis whitespace-nowrap"
                    >
                      {recentPath}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
