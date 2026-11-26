import '@fontsource/instrument-serif/latin-400.css'
import '@fontsource/instrument-serif/latin-400-italic.css'
import '@fontsource-variable/noto-serif-sc'
import '@fontsource-variable/noto-sans'
import '@fontsource-variable/noto-sans-sc'
import '@fontsource-variable/geist-mono'
import '../../../src/index.css'

import React from 'react'
import ReactDOM from 'react-dom/client'
import { CloudWebApp } from './CloudWebApp'
import { applyTheme, resolveInitialTheme } from './cloudWebClient'

applyTheme(resolveInitialTheme())

const root = document.getElementById('root')
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <CloudWebApp />
    </React.StrictMode>
  )
}
