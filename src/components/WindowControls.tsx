import React, { useEffect, useState } from 'react'
import { useI18nStore } from '../store/i18nStore'
import { MAIN_HOST, frameNameOf, sameHost, type HostId } from '../panelHost/types'

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
 *
 * `host` 决定按钮作用在哪个窗口：主窗口用窗口服务，辅助窗口按 frameName 寻址。
 * 渲染层始终跑在主窗口的 JS 上下文里，IPC 来源永远是主窗口，
 * 所以「操作哪个窗口」不能靠主进程从 sender 推断，必须显式传下去。
 */
export const WindowControls: React.FC<{ host?: HostId; compact?: boolean }> = ({
  host = MAIN_HOST,
  compact = false
}) => {
  const { t } = useI18nStore()
  const [maximized, setMaximized] = useState(false)
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  const isAux = host !== MAIN_HOST
  // 这里直接用 preload 桥（需要在无桥的 web 模式早退），所以自己补 frameName 前缀；
  // 走 `api` 门面的调用点由门面转换，两处都只用 frameNameOf，不写死前缀字面量。
  const frameName = frameNameOf(host)

  useEffect(() => {
    if (!api) return
    const readState = isAux ? api.auxWindowState(frameName) : api.isWindowMaximized()
    void readState.then((result) => {
      if (result?.maximized !== undefined) setMaximized(result.maximized)
    })
    return api.onWindowMaximizedChange((state) => {
      // 主窗口上报 `main`，辅助窗口上报 frameName：统一后再比较，否则永远对不上
      if (!state || !sameHost(state.host, host)) return
      setMaximized(state.maximized)
    })
  }, [api, host, isAux, frameName])

  if (!api) return null

  const run = (command: 'minimize' | 'toggleMaximize' | 'close') => {
    if (isAux) void api.auxWindowCommand(frameName, command)
    else if (command === 'minimize') void api.minimizeWindow()
    else if (command === 'close') void api.closeWindow()
    else void api.toggleMaximizeWindow()
  }

  const controlWidth = compact ? 'w-9' : 'w-[var(--titlebar-height)]'
  const controlClass =
    `flex h-full ${controlWidth} items-center justify-center text-ink-muted transition-colors duration-150 ` +
    'hover:bg-hover hover:text-ink active:bg-active'

  return (
    <div className="app-no-drag flex h-full flex-shrink-0 items-stretch border-l border-rule-divide">
      <button
        type="button"
        aria-label={t('windowMinimize')}
        title={t('windowMinimize')}
        className={controlClass}
        onClick={() => run('minimize')}
      >
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        aria-label={maximized ? t('windowRestore') : t('windowMaximize')}
        title={maximized ? t('windowRestore') : t('windowMaximize')}
        className={controlClass}
        onClick={() => run('toggleMaximize')}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        type="button"
        aria-label={t('close')}
        title={t('close')}
        className={`flex h-full ${controlWidth} items-center justify-center text-ink-muted transition-colors duration-150 hover:bg-danger hover:text-danger-fg active:bg-danger`}
        onClick={() => run('close')}
      >
        <CloseGlyph />
      </button>
    </div>
  )
}
