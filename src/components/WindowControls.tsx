import React, { useEffect, useState } from 'react'
import { useI18nStore } from '../store/i18nStore'

/**
 * 窗口控制 glyph：1.25px 直边描边，直角端点，与纸墨体系的细线语言一致。
 * 不使用 lucide，避免圆角/圆头图标与窗口边框风格冲突。
 */
const Glyph: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 13 13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.25"
    strokeLinecap="butt"
    strokeLinejoin="miter"
    aria-hidden="true"
  >
    {children}
  </svg>
)

const MinimizeGlyph = () => (
  <Glyph>
    <line x1="1.5" y1="6.5" x2="11.5" y2="6.5" />
  </Glyph>
)

const MaximizeGlyph = () => (
  <Glyph>
    <rect x="2" y="2" width="9" height="9" />
  </Glyph>
)

const RestoreGlyph = () => (
  <Glyph>
    <rect x="5.5" y="2" width="6" height="6" />
    <rect x="2" y="5.5" width="6" height="6" />
  </Glyph>
)

const CloseGlyph = () => (
  <Glyph>
    <line x1="2" y1="2" x2="11" y2="11" />
    <line x1="11" y1="2" x2="2" y2="11" />
  </Glyph>
)

/**
 * 自绘窗口按钮（Windows / Linux）。
 * macOS 使用原生红绿灯，不渲染此组件。
 */
export const WindowControls: React.FC = () => {
  const { t } = useI18nStore()
  const [maximized, setMaximized] = useState(false)
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined

  useEffect(() => {
    if (!api) return
    void api.isWindowMaximized().then((result) => setMaximized(result.maximized))
    return api.onWindowMaximizedChange(setMaximized)
  }, [api])

  if (!api) return null

  const controlClass =
    'flex h-full w-[var(--titlebar-height)] items-center justify-center text-ink-muted transition-colors duration-150 ' +
    'hover:bg-hover hover:text-ink active:bg-active'

  return (
    <div className="app-no-drag flex h-full flex-shrink-0 items-stretch border-l border-line">
      <button
        type="button"
        aria-label={t('windowMinimize')}
        title={t('windowMinimize')}
        className={controlClass}
        onClick={() => void api.minimizeWindow()}
      >
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        aria-label={maximized ? t('windowRestore') : t('windowMaximize')}
        title={maximized ? t('windowRestore') : t('windowMaximize')}
        className={controlClass}
        onClick={() => void api.toggleMaximizeWindow()}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        type="button"
        aria-label={t('close')}
        title={t('close')}
        className="flex h-full w-[var(--titlebar-height)] items-center justify-center text-ink-muted transition-colors duration-150 hover:bg-danger hover:text-danger-fg active:bg-danger"
        onClick={() => void api.closeWindow()}
      >
        <CloseGlyph />
      </button>
    </div>
  )
}
