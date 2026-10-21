import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/instrument-serif/400.css'
import '@fontsource/instrument-serif/400-italic.css'
import '@fontsource-variable/noto-serif-sc'
import '@fontsource-variable/noto-sans'
import '@fontsource-variable/noto-sans-sc'
import '@fontsource-variable/geist-mono'
import './monacoEnvironment'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installRendererLogging } from './api/rendererLog'
import './index.css'

installRendererLogging()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
