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
import { GitView } from './GitView'
import { CommitDetailView } from './CommitDetailView'
import { Spinner } from './ui'
import { WorkspaceScopeProvider } from '../workspace/WorkspaceScope'
import { subscribeEditorTabs } from '../workspace/editorTabs'
import { useI18nStore } from '../store/i18nStore'
import { useSessionStore } from '../store/sessionStore'
import { useGitStore } from '../store/gitStore'
import { onAppEvent } from '../utils/appEvents'
import { api } from '../api'
import type { GitChangeScope } from '../types/electron'

const MonacoEditor = lazy(() =>
  import('./MonacoEditor').then((module) => ({ default: module.MonacoEditor }))
)

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 420
const GIT_SIDEBAR_MAX = 720
const CHAT_MIN = 280
const CHAT_MAX = 560

type SidebarTab = 'files' | 'git'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Windows 的路径大小写与分隔符不敏感，事件里的工作区路径按宽松方式比较 */
function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\+/g, '/').replace(/\/+$/, '')
  const a = normalize(left)
  const b = normalize(right)
  return window.electronAPI?.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

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
  // 侧栏宽度按标签分别记忆：文件树保持原宽度，Git 提交图可以拉宽到 720
  const [sidebarWidths, setSidebarWidths] = useState<Record<SidebarTab, number>>({
    files: 232,
    git: 560,
  })
  const [chatWidth, setChatWidth] = useState(336)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('files')
  const [containerWidth, setContainerWidth] = useState(0)
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
  const activeSessionId = useSessionStore(
    (state) => state.byWorkspace[workspacePath]?.active ?? null
  )
  const viewRoot = useGitStore((state) =>
    activeSessionId
      ? state.byWorkspace[workspacePath]?.bindings[activeSessionId]?.path ?? workspacePath
      : workspacePath
  )
  const detailOpen = useGitStore(
    (state) => state.byWorkspace[workspacePath]?.detailOpen ?? false
  )
  const closeCommitDetail = useGitStore((state) => state.closeCommitDetail)

  /** Git 标签允许更宽；窗口不够时上限随容器和聊天列收缩 */
  const maxSidebarWidth = useCallback(
    (tab: SidebarTab) => {
      const total = containerWidth || containerRef.current?.clientWidth || window.innerWidth
      const reserved = 260 + (showChat ? chatWidth : 0)
      const limit = tab === 'git' ? GIT_SIDEBAR_MAX : SIDEBAR_MAX
      return Math.max(SIDEBAR_MIN, Math.min(limit, total - reserved))
    },
    [containerWidth, showChat, chatWidth]
  )
  const sidebarWidth = Math.min(sidebarWidths[sidebarTab], maxSidebarWidth(sidebarTab))

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

  // 容器宽度变化时重新计算侧栏上限（窗口缩放、聊天列收起/展开）
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setContainerWidth(entry.contentRect.width)
    })
    observer.observe(element)
    setContainerWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  // 顶栏“终端”按钮作用于当前工作区
  useEffect(() => {
    if (!active) return
    const onToggleTerminal = () => setShowTerminal((value) => !value)
    const offToggle = onAppEvent('workspace-toggle-terminal', onToggleTerminal)
    return () => offToggle()
  }, [active])

  // 标签变化防抖写入固定状态；工作树模式按当前视图根保存
  useEffect(() => subscribeEditorTabs(workspacePath, viewRoot), [workspacePath, viewRoot])

  // 主进程推送的仓库变化：本地文件监听与定时 fetch 都从这里进入 Git 面板
  useEffect(() => {
    if (typeof api.onGitChanged !== 'function') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const pending = new Set<GitChangeScope>()
    const flush = () => {
      timer = null
      if (pending.size === 0) return
      const scopes = [...pending]
      pending.clear()
      void useGitStore.getState().handleChanged(workspacePath, scopes, activeSessionId)
    }
    const off = api.onGitChanged((payload) => {
      if (!sameWorkspacePath(payload.workspaceDir, workspacePath)) return
      for (const scope of payload.scopes) pending.add(scope)
      if (timer === null) timer = setTimeout(flush, 100)
    })
    return () => {
      off()
      if (timer !== null) clearTimeout(timer)
    }
  }, [workspacePath, activeSessionId])

  const startResize = useCallback(
    (target: 'sidebar' | 'chat') => (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      const startX = event.clientX
      const initial =
        target === 'sidebar'
          ? Math.min(sidebarWidths[sidebarTab], maxSidebarWidth(sidebarTab))
          : chatWidth

      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX
        if (target === 'sidebar') {
          const width = clamp(initial + delta, SIDEBAR_MIN, maxSidebarWidth(sidebarTab))
          setSidebarWidths((current) => ({ ...current, [sidebarTab]: width }))
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
    [sidebarWidths, sidebarTab, maxSidebarWidth, chatWidth]
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
              className="flex flex-shrink-0 flex-col overflow-hidden bg-panel"
              style={{ width: sidebarWidth }}
            >
              <div className="flex h-[34px] flex-shrink-0 items-center gap-0.5 border-b border-rule-divide px-1.5">
                <button
                  type="button"
                  onClick={() => setSidebarTab('files')}
                  className={`h-full border-b-2 px-2 type-label transition-colors ${
                    sidebarTab === 'files'
                      ? 'border-accent text-ink'
                      : 'border-transparent text-ink-muted hover:text-ink'
                  }`}
                >
                  {t('files')}
                </button>
                <button
                  type="button"
                  onClick={() => setSidebarTab('git')}
                  className={`h-full border-b-2 px-2 type-label transition-colors ${
                    sidebarTab === 'git'
                      ? 'border-accent text-ink'
                      : 'border-transparent text-ink-muted hover:text-ink'
                  }`}
                >
                  {t('gitView')}
                </button>
              </div>
              <div className="min-h-0 flex-1">
                {sidebarTab === 'files' ? (
                  <FileExplorer
                    workspacePath={viewRoot}
                    onCollapse={collapseSidebar}
                    collapseButtonRef={sidebarCollapseRef}
                    panelId={filePanelId}
                    active={active}
                  />
                ) : (
                  <GitView workspacePath={workspacePath} />
                )}
              </div>
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
          <div className="relative flex min-h-0 min-w-0 flex-1">
            <Suspense
              fallback={
                <div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
                  <Spinner size={14} />
                </div>
              }
            >
              <MonacoEditor workspacePath={workspacePath} viewRoot={viewRoot} active={active} />
            </Suspense>
            {detailOpen && (
              <CommitDetailView
                workspacePath={workspacePath}
                active={active}
                onClose={() => closeCommitDetail(workspacePath)}
              />
            )}
          </div>
          <TerminalPanel
            workspacePath={workspacePath}
            cwd={viewRoot}
            key={`${activeSessionId ?? 'none'}:${viewRoot}`}
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
                viewRoot={viewRoot}
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

        <DiffViewer workspacePath={viewRoot} active={active} />
      </WorkspaceScopeProvider>
    </div>
  )
}
