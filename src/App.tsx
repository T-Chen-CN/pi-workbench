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
import './App.css'

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
    <div className="app">
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      <header className="header">
        <h1>{t('appTitle')}</h1>
        <div className="header-actions">
          {workspace && (
            <span className="workspace-path">{workspace}</span>
          )}
          {import.meta.env.DEV && (
            <button className="debug-toggle" onClick={() => setShowDebug(!showDebug)}>
              {showDebug ? '🐛' : '⚙️'}
            </button>
          )}
          <button
            className="settings-toggle"
            onClick={() => setShowSettings(!showSettings)}
            title={t('settings')}
          >
            ⚙️
          </button>
          <button onClick={workspace ? closeWorkspace : openWorkspace}>
            {workspace ? t('closeProject') : t('openProject')}
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          <p>{error}</p>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {showDebug && (
        <div className="debug-panel">
          <IPCDebug />
        </div>
      )}

      <ToastContainer messages={toast.messages} onClose={toast.remove} />
      <DiffViewer />

      <main className="main">
        {workspace ? (
          <div className="workspace">
            <aside className="sidebar">
              <FileExplorer workspacePath={workspace} />
            </aside>
            <section className="editor-section">
              <MonacoEditor />
            </section>
            <aside className="chat-section">
              <ChatPanel />
            </aside>
          </div>
        ) : (
          <div className="welcome">
            <h2>{t('welcome')}</h2>
            <p>{t('welcomeSubtitle')}</p>
            <button onClick={openWorkspace} className="cta-button">
              {t('openProject')}
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
