import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { PanelLeftOpen, PanelRightOpen } from 'lucide-react'
import { FileExplorer } from './FileExplorer'
import { ChatPanel } from './ChatPanel'
import { ErrorBoundary } from './ErrorBoundary'
import { DiffViewer } from './DiffViewer'
import { SelectionQuoteButton } from './SelectionQuoteButton'
import { PanelSlot } from './PanelSlot'
import { TerminalPanel } from './TerminalPanel'
import { GitView } from './GitView'
import { CommitDetailView } from './CommitDetailView'
import { Spinner } from './ui'
import { WorkspaceScopeProvider } from '../workspace/WorkspaceScope'
import { subscribeEditorTabs } from '../workspace/editorTabs'
import { useI18nStore } from '../store/i18nStore'
import { useSessionStore } from '../store/sessionStore'
import { useGitStore } from '../store/gitStore'
import { useEditorStore } from '../store/editorStore'
import { usePanelStore } from '../store/panelStore'
import { onAppEvent } from '../utils/appEvents'
import { api } from '../api'
import type { GitChangeScope } from '../types/electron'

const FileView = lazy(() =>
  import('./FileView').then((module) => ({ default: module.FileView }))
)

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 420
const GIT_SIDEBAR_MAX = 720
const CHAT_MIN = 280
const CHAT_MAX = 560
/** 两侧可拖拽面板都给编辑器留出的最小宽度，低于这个值预览区就只剩一道缝 */
const EDITOR_MIN = 260

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
    git: 560
  })
  const [chatWidth, setChatWidth] = useState(336)
  // 面板拆到独立窗口后：主窗口这一侧完全让位（不占宽、不占高、不留占位）。
  // 但 PanelSlot 必须继续挂载 —— portal 的 fiber 挂在这里，卸载会把独立窗口里的面板一起拆掉。
  const detached = usePanelStore((state) => state.panelHost[workspacePath])
  const chatDetached = detached?.chat !== undefined
  const filesDetached = detached?.files !== undefined
  const gitDetached = detached?.git !== undefined
  const terminalDetached = detached?.terminal !== undefined
  /** 侧栏是 files / git 共用的：只要还剩一个停靠，侧栏就还能出现 */
  const sidebarHasDocked = !filesDetached || !gitDetached
  const sidebarMounted = showSidebar || filesDetached || gitDetached
  const sidebarShown = showSidebar && sidebarHasDocked
  const chatMounted = showChat || chatDetached
  const chatShown = showChat && !chatDetached
  const terminalMounted = showTerminal || terminalDetached
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('files')
  // 当前标签被拆走时切到还在的那一边，避免标签条指向一个已经不在这里的面板
  useEffect(() => {
    if (sidebarTab === 'files' && filesDetached && !gitDetached) setSidebarTab('git')
    else if (sidebarTab === 'git' && gitDetached && !filesDetached) setSidebarTab('files')
  }, [sidebarTab, filesDetached, gitDetached])
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
  const activeSessionId = useSessionStore((state) => state.byWorkspace[workspacePath]?.active ?? null)
  const viewRoot = useGitStore((state) =>
    activeSessionId
      ? (state.byWorkspace[workspacePath]?.bindings[activeSessionId]?.path ?? workspacePath)
      : workspacePath
  )
  // 面板级错误边界的重置键：切会话 / 切文件后自动重试渲染
  const chatResetKey = `${viewRoot}:${activeSessionId ?? ''}`
  const editorResetKey = useEditorStore(viewRoot, (state) => state.currentFile?.path ?? '')
  const detailOpen = useGitStore((state) => state.byWorkspace[workspacePath]?.detailOpen ?? false)
  const closeCommitDetail = useGitStore((state) => state.closeCommitDetail)

  /** Git 标签允许更宽；窗口不够时上限随容器和聊天列收缩 */
  const maxSidebarWidth = useCallback(
    (tab: SidebarTab) => {
      const total = containerWidth || containerRef.current?.clientWidth || window.innerWidth
      const reserved = EDITOR_MIN + (chatShown ? chatWidth : 0)
      const limit = tab === 'git' ? GIT_SIDEBAR_MAX : SIDEBAR_MAX
      return Math.max(SIDEBAR_MIN, Math.min(limit, total - reserved))
    },
    [containerWidth, chatShown, chatWidth]
  )
  const sidebarWidth = Math.min(sidebarWidths[sidebarTab], maxSidebarWidth(sidebarTab))

  /** 聊天栏同样要给编辑器留出 EDITOR_MIN：只受 280/560 绝对上下限约束会把预览区压成 0 并被自己盖住 */
  const maxChatWidth = useCallback(() => {
    const total = containerWidth || containerRef.current?.clientWidth || window.innerWidth
    const reserved = EDITOR_MIN + (sidebarShown ? sidebarWidth : 0)
    return Math.max(CHAT_MIN, Math.min(CHAT_MAX, total - reserved))
  }, [containerWidth, sidebarShown, sidebarWidth])
  // 窗口变窄时聊天列跟着收，和侧栏的显示宽度保持同一套规则
  const chatWidthShown = Math.min(chatWidth, maxChatWidth())

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

  // 顶栏“终端”按钮作用于当前工作区；终端已拆出时不作用——布局这边没有可切换的东西，
  // 动了只会让独立窗口里的 xterm 拿到 visible=false
  useEffect(() => {
    if (!active) return
    const onToggleTerminal = () => {
      if (usePanelStore.getState().panelHost[workspacePath]?.terminal) return
      setShowTerminal((value) => !value)
    }
    const offToggle = onAppEvent('workspace-toggle-terminal', onToggleTerminal)
    return () => offToggle()
  }, [active, workspacePath])

  // 标签变化防抖写入固定状态；工作树模式按当前视图根保存
  useEffect(() => subscribeEditorTabs(workspacePath, viewRoot), [workspacePath, viewRoot])

  /**
   * Git 工作树绑定后，源码在另一个目录下。工作区根的监听覆盖不到它，
   * 不补这一层的话 Agent 改完工作树里的文件，编辑器里打开的文档不会自动刷新。
   */
  useEffect(() => {
    if (viewRoot === workspacePath) return
    void api.watchWorkspace(viewRoot).catch(() => undefined)
    return () => {
      void api.unwatchWorkspace(viewRoot).catch(() => undefined)
    }
  }, [viewRoot, workspacePath])

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
        target === 'sidebar' ? Math.min(sidebarWidths[sidebarTab], maxSidebarWidth(sidebarTab)) : chatWidthShown

      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX
        if (target === 'sidebar') {
          const width = clamp(initial + delta, SIDEBAR_MIN, maxSidebarWidth(sidebarTab))
          setSidebarWidths((current) => ({ ...current, [sidebarTab]: width }))
        } else {
          setChatWidth(clamp(initial - delta, CHAT_MIN, maxChatWidth()))
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
    [sidebarWidths, sidebarTab, maxSidebarWidth, chatWidthShown, maxChatWidth]
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
        {/* 侧栏是 files / git 共用的：还剩一个停靠就保留侧栏，两个都拆出就整块让位。
            已拆出的那个也必须保持挂载 —— portal 的 fiber 挂在这里 */}
        {sidebarMounted && (
          <aside
            id={filePanelId}
            className={sidebarShown ? 'flex flex-shrink-0 flex-col overflow-hidden bg-panel' : 'hidden'}
            style={sidebarShown ? { width: sidebarWidth } : undefined}
          >
            <div className="flex h-[34px] flex-shrink-0 items-center gap-0.5 border-b border-rule-divide px-1.5">
              <button
                type="button"
                onClick={() => setSidebarTab('files')}
                className={`${filesDetached ? 'hidden ' : ''}h-full border-b-2 px-2 type-label transition-colors ${
                  sidebarTab === 'files' ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink'
                }`}
              >
                {t('files')}
              </button>
              <button
                type="button"
                onClick={() => setSidebarTab('git')}
                className={`${gitDetached ? 'hidden ' : ''}h-full border-b-2 px-2 type-label transition-colors ${
                  sidebarTab === 'git' ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink'
                }`}
              >
                {t('gitView')}
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {/* 已拆出的面板必须保持挂载（portal 在别的窗口里），只是主窗口这边不显示 */}
              {(sidebarTab === 'files' || filesDetached) && (
                <div className={sidebarTab === 'files' ? 'h-full' : 'hidden'} aria-hidden={sidebarTab !== 'files'}>
                  <PanelSlot panel="files">
                    <FileExplorer
                      workspacePath={viewRoot}
                      onCollapse={filesDetached ? undefined : collapseSidebar}
                      collapseButtonRef={sidebarCollapseRef}
                      panelId={filePanelId}
                      active={active}
                    />
                  </PanelSlot>
                </div>
              )}
              {(sidebarTab === 'git' || gitDetached) && (
                <div className={sidebarTab === 'git' ? 'h-full' : 'hidden'} aria-hidden={sidebarTab !== 'git'}>
                  <PanelSlot panel="git">
                    <GitView workspacePath={workspacePath} />
                  </PanelSlot>
                </div>
              )}
            </div>
          </aside>
        )}
        {sidebarShown && (
          <div
            role="separator"
            aria-orientation="vertical"
            className="w-0.5 flex-shrink-0 cursor-col-resize bg-rule-seam transition-colors hover:bg-accent"
            onPointerDown={startResize('sidebar')}
          />
        )}
        {!showSidebar && sidebarHasDocked && (
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
          <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <Suspense
              fallback={
                <div className="flex min-h-0 flex-1 items-center justify-center bg-surface">
                  <Spinner size={14} />
                </div>
              }
            >
              {/* 编辑器 / 阅读视图单独兜底：Monaco 出错只坏一块，不整窗白屏 */}
              <ErrorBoundary scope="pane" resetKey={`${viewRoot}:${editorResetKey}`}>
                <FileView workspacePath={workspacePath} viewRoot={viewRoot} active={active} />
              </ErrorBoundary>
            </Suspense>
            {detailOpen && (
              <CommitDetailView
                workspacePath={workspacePath}
                active={active}
                onClose={() => closeCommitDetail(workspacePath)}
              />
            )}
          </div>
          {/* 终端拆出后，主窗口这一侧不留行高；`visible` 仍是面板自身的可见性，
              否则独立窗口里的 xterm 会拿到 visible=false 而不初始化 / 不适配尺寸 */}
          {terminalMounted && (
            <div className={terminalDetached ? 'hidden' : 'contents'}>
              <PanelSlot panel="terminal">
                <TerminalPanel
                  workspacePath={workspacePath}
                  cwd={viewRoot}
                  visible={showTerminal}
                  onClose={terminalDetached ? undefined : () => setShowTerminal(false)}
                  active={active}
                />
              </PanelSlot>
            </div>
          )}
        </section>

        {chatShown && (
          <div
            role="separator"
            aria-orientation="vertical"
            className="w-0.5 flex-shrink-0 cursor-col-resize bg-rule-seam transition-colors hover:bg-accent"
            onPointerDown={startResize('chat')}
          />
        )}
        {/* 拆出后整列（含接缝）让给编辑器，但面板必须保持挂载 */}
        {chatMounted && (
          <aside
            id={chatPanelId}
            className={chatShown ? 'flex-shrink-0 overflow-hidden bg-panel' : 'hidden'}
            style={chatShown ? { width: chatWidthShown } : undefined}
          >
            <PanelSlot panel="chat">
              <ErrorBoundary scope="pane" resetKey={chatResetKey}>
                <ChatPanel
                  workspacePath={workspacePath}
                  viewRoot={viewRoot}
                  onCollapse={chatDetached ? undefined : collapseChat}
                  collapseButtonRef={chatCollapseRef}
                  panelId={chatPanelId}
                  active={active}
                />
              </ErrorBoundary>
            </PanelSlot>
          </aside>
        )}
        {!chatMounted && (
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
        {/* 划词引用：只挂当前可见的工作区，避免隐藏视图抢走别的视图的选区 */}
        {active && <SelectionQuoteButton />}
      </WorkspaceScopeProvider>
    </div>
  )
}
