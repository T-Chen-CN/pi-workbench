import { useState, useEffect } from 'react'
import { api } from './api'
import { FileExplorer } from './components/FileExplorer'
import { MonacoEditor } from './components/MonacoEditor'
import { ChatPanel } from './components/ChatPanel'
import { DiffViewer } from './components/DiffViewer'
import { IPCDebug } from './components/IPCDebug'
import { Settings } from './components/Settings'
import { ToastContainer, useToast } from './components/Toast'
import { useI18nStore } from './store/i18nStore'

export default function App() {
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showDebug, setShowDebug] = useState(import.meta.env.DEV)
  const [showSettings, setShowSettings] = useState(false)
  const toast = useToast()
  const { t, setLanguage, language } = useI18nStore()

  // 初始化语言为中文
  useEffect(() => {
    if (language !== 'zh') {
      setLanguage('zh')
    }
  }, [])

  const openWorkspace = async () => {
    try {
      setError(null)
      const result = await api.openDirectoryDialog()
      if (result.success && !result.canceled && result.path) {
        setWorkspace(result.path)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(message)
      console.error('Failed to open workspace:', error)
    }
  }

  const closeWorkspace = () => {
    setWorkspace(null)
  }

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-[#1e1e1e]">
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}

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
            onClick={workspace ? closeWorkspace : openWorkspace}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white border-none rounded transition-colors text-sm font-medium"
          >
            {workspace ? t('closeProject') : t('openProject')}
          </button>
        </div>
      </header>

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

      <ToastContainer messages={toast.messages} onClose={toast.remove} />
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
              <ChatPanel />
            </aside>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-600 dark:text-gray-400 text-center gap-5">
            <h2 className="text-2xl text-gray-900 dark:text-gray-100 m-0">{t('welcome')}</h2>
            <p className="text-base m-0">{t('welcomeSubtitle')}</p>
            <button
              onClick={openWorkspace}
              className="px-6 py-2.5 text-base bg-blue-600 hover:bg-blue-700 text-white border-none rounded transition-colors font-medium"
            >
              {t('openProject')}
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
