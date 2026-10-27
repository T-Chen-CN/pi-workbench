import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/instrument-serif/400.css'
import '@fontsource/instrument-serif/400-italic.css'
import '@fontsource-variable/noto-serif-sc'
import '@fontsource-variable/noto-sans'
import '@fontsource-variable/noto-sans-sc'
import '@fontsource-variable/geist-mono'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installRendererLogging } from './api/rendererLog'
import { useI18nStore } from './store/i18nStore'
import { useThemeStore, type ThemeMode } from './store/themeStore'
import './index.css'

installRendererLogging()

// 主进程把已保存的主题与语言带在 URL 上：在首帧之前写入 store，
// 否则 App 第一个 effect 会按默认浅色重画一次，暗色主题会闪。
const startupParams = new URLSearchParams(window.location.search)
const startupTheme = startupParams.get('theme')
if (startupTheme === 'dark' || startupTheme === 'light') {
  useThemeStore.setState({ mode: startupTheme as ThemeMode })
}
const startupLang = startupParams.get('lang')
if (startupLang === 'zh' || startupLang === 'en') {
  useI18nStore.getState().setLanguage(startupLang)
  document.documentElement.lang = startupLang === 'zh' ? 'zh-CN' : 'en'
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
