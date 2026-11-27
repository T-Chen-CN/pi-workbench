import React, { lazy, Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/instrument-serif/latin-400.css'
import '@fontsource/instrument-serif/latin-400-italic.css'
import '@fontsource-variable/noto-serif-sc'
import '@fontsource-variable/noto-sans'
import '@fontsource-variable/noto-sans-sc'
import '@fontsource-variable/geist-mono'
import App from './App'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { installRendererLogging } from './api/rendererLog'
import { installDocumentRenderBridge } from './api/documentRender'
import { installElectronClipboardShim } from './utils/clipboard'
import { parseDetachedWindowParams } from './panelHost/types'
import { useI18nStore } from './store/i18nStore'
import { useThemeStore, type ThemeMode } from './store/themeStore'
import './index.css'

const DetachedPanelApp = lazy(() =>
  import('./components/panels/DetachedPanelApp').then((module) => ({
    default: module.DetachedPanelApp,
  }))
)

installRendererLogging()
// Electron 自定义协议下让 Streamdown 等组件内建的 navigator.clipboard.writeText 走主进程剪贴板
installElectronClipboardShim()

// 主进程把已保存的主题与语言带在 URL 上：在首帧之前写入 store，
// 否则首帧 effect 会按默认浅色重画一次，暗色主题会闪。
const startupParams = new URLSearchParams(window.location.search)
const detachedParams = parseDetachedWindowParams(window.location.search)
const startupTheme = startupParams.get('theme')
if (startupTheme === 'dark' || startupTheme === 'light') {
  useThemeStore.setState({ mode: startupTheme as ThemeMode })
}
const startupLang = startupParams.get('lang')
if (startupLang === 'zh' || startupLang === 'en') {
  useI18nStore.getState().setLanguage(startupLang)
  document.documentElement.lang = startupLang === 'zh' ? 'zh-CN' : 'en'
}

// 扫描件按页渲成图片只由主窗口承接，避免拆出面板窗口重复渲染回传
if (!detachedParams) {
  installDocumentRenderBridge()
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {detachedParams ? (
        <Suspense fallback={null}>
          <DetachedPanelApp
            panel={detachedParams.panel}
            workspacePath={detachedParams.workspaceDir}
            hostId={detachedParams.hostId}
          />
        </Suspense>
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </React.StrictMode>,
)
