import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  PanelLeftOpen,
  PanelRightOpen,
} from 'lucide-react'
import { FileExplorer } from './FileExplorer'
import { ChatPanel } from './ChatPanel'
import { DiffViewer } from './DiffViewer'
import { TerminalPanel } from './TerminalPanel'
import { Spinner } from './ui'
import { WorkspaceScopeProvider } from '../workspace/WorkspaceScope'
import { subscribeEditorTabs } from '../workspace/editorTabs'
import { useI18nStore } from '../store/i18nStore'

const MonacoEditor = lazy(() =>
  import('./MonacoEditor').then((module) => ({ default: module.MonacoEditor }))
)

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 420
const CHAT_MIN = 280
const CHAT_MAX = 560

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

interface WorkspaceViewProps {
  workspacePath: string
  active: boolean
}

/**
 * 一个打开的工作区对应一个常驻视图。
 * 切换工作区 / 回首页只切换可见性，不卸载、不重置，编辑器和终端实例都保留。
 */
export const WorkspaceView: React.FC<WorkspaceViewProps> = ({ workspacePath, active }) => {
  const { t } = useI18nStore()
  const [showSidebar, setShowSidebar] = useState(true)
  const [showChat, setShowChat] = useState(true)
  const [showTerminal, setShowTerminal] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(232)
  const [chatWidth, setChatWidth] = useState(336)
  const containerRef = useRef<HTMLDivElement>(null)
  const sidebarCollapseRef = useRef<HTMLButtonElement | null>(null)
  const chatCollapseRef = useRef<HTMLButtonElement | null>(null)
  const sidebarRailRef = useRef<HTMLButtonElement | null>(null)
  const chatRailRef = useRef<HTMLButtonElement | null>(null)
  const sidebarFocusIntent = useRef(false)
  const chatFocusIntent = useRef(false)
  const reactId = useId()
  const filePanelId = `file-panel-${reactId}`
  const chatPanelId = `chat-panel-${reactId}`

  const collapseSidebar = useCallback(() => {
    sidebarFocusIntent.current = true
    setShowSidebar(false)
  }, [])

  const expandSidebar = useCallback(() => {
    sidebarFocusIntent.current = true
    setShowSidebar(true)
  }, [])

  const collapseChat = useCallback(() => {
    chatFocusIntent.current = true
    setShowChat(false)
  }, [])

  const expandChat = useCallback(() => {
    chatFocusIntent.current = true
    setShowChat(true)
  }, [])

  // 收起 / 展开后焦点落到对应的窄条或头部按钮
  useEffect(() => {
    if (!sidebarFocusIntent.current) return
    sidebarFocusIntent.current = false
    const target = showSidebar ? sidebarCollapseRef.current : sidebarRailRef.current
    target?.focus()
  }, [showSidebar])

  useEffect(() => {
    if (!chatFocusIntent.current) return
    chatFocusIntent.current = false
    const target = showChat ? chatCollapseRef.current : chatRailRef.current
    target?.focus()
  }, [showChat])

  // 回到前台时把焦点还给当前工作区
  useEffect(() => {
    if (!active) return
    const element = containerRef.current
    if (element && !element.contains(document.activeElement)) {
      element.focus({ preventScroll: true })
    }
  }, [active])

  // 顶栏“终端”按钮作用于当前工作区
  useEffect(() => {
    if (!active) return
    const onToggleTerminal = () => setShowTerminal((value) => !value)
    window.addEventListener('workspace-toggle-terminal', onToggleTerminal)
    return () => window.removeEventListener('workspace-toggle-terminal', onToggleTerminal)
  }, [active])

  // 标签变化防抖写入固定状态
  useEffect(() => subscribeEditorTabs(workspacePath), [workspacePath])

  const startResize = useCallback(
    (target: 'sidebar' | 'chat') => (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const startX = event.clientX
      const initial = target === 'sidebar' ? sidebarWidth : chatWidth

      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX
        if (target === 'sidebar') {
          setSidebarWidth(clamp(initial + delta, SIDEBAR_MIN, SIDEBAR_MAX))
        } else {
          setChatWidth(clamp(initial - delta, CHAT_MIN, CHAT_MAX))
        }
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [sidebarWidth, chatWidth]
  )

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      aria-hidden={!active}
      inert={!active}
      className={`absolute inset-0 flex bg-surface outline-none ${
        active ? 'visible' : 'pointer-events-none invisible'
      }`}
    >
      <WorkspaceScopeProvider value={workspacePath}>
        {showSidebar ? (
          <>
            <aside
              id={filePanelId}
              className="flex-shrink-0 overflow-hidden bg-panel"
              style={{ width: sidebarWidth }}
            >
              <FileExplorer
                workspacePath={workspacePath}
                onCollapse={collapseSidebar}
                collapseButtonRef={sidebarCollapseRef}
                panelId={filePanelId}
                active={active}
              />
            </aside>
            <div
              role="separator"
              aria-orientation="vertical"
              className="w-0.5 flex-shrink-0 cursor-col-resize bg-rule-seam transition-colors hover:bg-accent"
              onPointerDown={startResize('sidebar')}
            />
          </>
        ) : (
          <button
            ref={sidebarRailRef}
            type="button"
            aria-label={t('expandSidebar')}
            title={t('expandSidebar')}
            aria-controls={filePanelId}
            aria-expanded={false}
            onClick={expandSidebar}
            className="flex w-[26px] flex-shrink-0 items-center justify-center self-stretch border-r border-rule-divide bg-panel text-ink-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline-offset-[-2px]"
          >
            <PanelLeftOpen size={14} />
          </button>
        )}

        <section className="flex min-w-0 flex-1 flex-col">
          <Suspense
            fallback={
              <div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
                <Spinner size={14} />
              </div>
            }
          >
            <MonacoEditor workspacePath={workspacePath} active={active} />
          </Suspense>
          <TerminalPanel
            workspacePath={workspacePath}
            visible={showTerminal}
            onClose={() => setShowTerminal(false)}
            active={active}
          />
        </section>

        {showChat ? (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              className="w-0.5 flex-shrink-0 cursor-col-resize bg-rule-seam transition-colors hover:bg-accent"
              onPointerDown={startResize('chat')}
            />
            <aside
              id={chatPanelId}
              className="flex-shrink-0 overflow-hidden bg-panel"
              style={{ width: chatWidth }}
            >
              <ChatPanel
                workspacePath={workspacePath}
                onCollapse={collapseChat}
                collapseButtonRef={chatCollapseRef}
                panelId={chatPanelId}
                active={active}
              />
            </aside>
          </>
        ) : (
          <button
            ref={chatRailRef}
            type="button"
            aria-label={t('expandChat')}
            title={t('expandChat')}
            aria-controls={chatPanelId}
            aria-expanded={false}
            onClick={expandChat}
            className="flex w-[26px] flex-shrink-0 items-center justify-center self-stretch border-l border-rule-divide bg-panel text-ink-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline-offset-[-2px]"
          >
            <PanelRightOpen size={14} />
          </button>
        )}

        <DiffViewer workspacePath={workspacePath} active={active} />
      </WorkspaceScopeProvider>
    </div>
  )
}
