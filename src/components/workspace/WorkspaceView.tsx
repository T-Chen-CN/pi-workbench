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
import { FileExplorer } from '../files/FileExplorer'
import { ChatPanel } from '../chat/ChatPanel'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { DiffViewer } from '../editor/DiffViewer'
import { SelectionQuoteButton } from '../ui/SelectionQuoteButton'
import { PanelSlot } from '../panels/PanelSlot'
import { GitView } from '../git/GitView'
import { CommitDetailView } from '../git/CommitDetailView'
import { Spinner } from '../ui/ui'
import { WorkspaceScopeProvider } from '../../workspace/WorkspaceScope'
import { subscribeEditorTabs } from '../../workspace/editorTabs'
import { useI18nStore } from '../../store/i18nStore'
import { useSessionStore } from '../../store/sessionStore'
import { useGitStore } from '../../store/gitStore'
import { useEditorStore } from '../../store/editorStore'
import { usePanelStore } from '../../store/panelStore'
import { useSettingsStore } from '../../store/settingsStore'
import { persistAppSettings } from '../../utils/persistSettings'
import { onAppEvent } from '../../utils/appEvents'
import { api } from '../../api'
import type { GitChangeScope } from '../../types/electron'

const FileView = lazy(() =>
  import('../editor/FileView').then((module) => ({ default: module.FileView }))
)
const TerminalPanel = lazy(() =>
  import('../editor/TerminalPanel').then((module) => ({ default: module.TerminalPanel }))
)

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 420
const GIT_SIDEBAR_MAX = 720
const CHAT_MIN = 280
const CHAT_MAX = 560
const TERMINAL_MIN = 100
const TERMINAL_MAX = 700
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
 * 切换工作区 / 回首页时使用 `hidden`（display: none）休眠非活动工作区的布局与绘制，
 * 同时保持组件与所有 Agent / 审批 / PTY 订阅常驻不卸载。
 */
export const WorkspaceView: React.FC<WorkspaceViewProps> = React.memo(function WorkspaceView({
  workspacePath,
  active,
}) {
  const t = useI18nStore((state) => state.t)
  const [showSidebar, setShowSidebar] = useState(true)
  const [showChat, setShowChat] = useState(true)
  const [showTerminal, setShowTerminal] = useState(false)
  // 侧栏宽度按标签分别记忆：文件树从持久化偏好初始化，Git 提交图可以拉宽到 720
  const [sidebarWidths, setSidebarWidths] = useState<Record<SidebarTab, number>>(() => ({
    files: useSettingsStore.getState().panelWidths.sidebar,
    git: 560,
  }))
  const [chatWidth, setChatWidth] = useState(() => useSettingsStore.getState().panelWidths.chat)
  const [terminalHeight, setTerminalHeight] = useState(
    () => useSettingsStore.getState().panelWidths.terminalHeight
  )
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

  // 容器宽度变化时重新计算侧栏上限（窗口缩放、聊天列收起/展开）；隐藏态 width=0 时忽略，避免休眠工作区白跑渲染
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry && entry.contentRect.width > 0) setContainerWidth(entry.contentRect.width)
    })
    observer.observe(element)
    if (element.clientWidth > 0) setContainerWidth(element.clientWidth)
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

  // 工作树依赖安装状态：主进程只推变化的那一个，不整表轮询
  useEffect(() => {
    if (typeof api.onGitWorktreeDeps !== 'function') return
    return api.onGitWorktreeDeps((payload) => {
      if (!sameWorkspacePath(payload.workspaceDir, workspacePath)) return
      useGitStore.getState().handleWorktreeDeps(workspacePath, payload)
    })
  }, [workspacePath])

  const resizeCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => resizeCleanupRef.current?.(), [])

  const startResize = useCallback(
    (target: 'sidebar' | 'chat') => (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      resizeCleanupRef.current?.()
      const startX = event.clientX
      const initial =
        target === 'sidebar'
          ? Math.min(sidebarWidths[sidebarTab], maxSidebarWidth(sidebarTab))
          : chatWidthShown
      let latest = initial

      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX
        if (target === 'sidebar') {
          const width = clamp(initial + delta, SIDEBAR_MIN, maxSidebarWidth(sidebarTab))
          latest = width
          setSidebarWidths((current) => ({ ...current, [sidebarTab]: width }))
        } else {
          const width = clamp(initial - delta, CHAT_MIN, maxChatWidth())
          latest = width
          setChatWidth(width)
        }
      }
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', cleanup)
        window.removeEventListener('pointercancel', cleanup)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null
        if (latest !== initial) {
          if (target === 'sidebar' && sidebarTab === 'files') {
            useSettingsStore.getState().setPanelWidths({ sidebar: latest })
            void persistAppSettings({ panelWidths: useSettingsStore.getState().panelWidths })
          } else if (target === 'chat') {
            useSettingsStore.getState().setPanelWidths({ chat: latest })
            void persistAppSettings({ panelWidths: useSettingsStore.getState().panelWidths })
          }
        }
      }
      resizeCleanupRef.current = cleanup
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', cleanup)
      window.addEventListener('pointercancel', cleanup)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [sidebarWidths, sidebarTab, maxSidebarWidth, chatWidthShown, maxChatWidth]
  )

  const startTerminalResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      resizeCleanupRef.current?.()
      const startY = event.clientY
      const initial = terminalHeight
      let latest = initial

      const onMove = (moveEvent: PointerEvent) => {
        const delta = startY - moveEvent.clientY
        const height = clamp(initial + delta, TERMINAL_MIN, TERMINAL_MAX)
        latest = height
        setTerminalHeight(height)
      }
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', cleanup)
        window.removeEventListener('pointercancel', cleanup)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null
        if (latest !== initial) {
          useSettingsStore.getState().setPanelWidths({ terminalHeight: latest })
          void persistAppSettings({ panelWidths: useSettingsStore.getState().panelWidths })
        }
      }
      resizeCleanupRef.current = cleanup
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', cleanup)
      window.addEventListener('pointercancel', cleanup)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [terminalHeight]
  )

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      aria-hidden={!active}
      inert={!active}
      className={`absolute inset-0 bg-surface outline-none ${
        active ? 'flex' : 'hidden'
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
                    <ErrorBoundary scope="pane" resetKey={`${viewRoot}:files`}>
                      <FileExplorer
                        workspacePath={viewRoot}
                        onCollapse={filesDetached ? undefined : collapseSidebar}
                        collapseButtonRef={sidebarCollapseRef}
                        panelId={filePanelId}
                        active={active || filesDetached}
                      />
                    </ErrorBoundary>
                  </PanelSlot>
                </div>
              )}
              {(sidebarTab === 'git' || gitDetached) && (
                <div className={sidebarTab === 'git' ? 'h-full' : 'hidden'} aria-hidden={sidebarTab !== 'git'}>
                  <PanelSlot panel="git">
                    <ErrorBoundary scope="pane" resetKey={`${workspacePath}:git`}>
                      <GitView workspacePath={workspacePath} active={active || gitDetached} />
                    </ErrorBoundary>
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
          {terminalMounted && !terminalDetached && showTerminal && (
            <div
              role="separator"
              aria-orientation="horizontal"
              className="h-0.5 flex-shrink-0 cursor-row-resize bg-rule-seam transition-colors hover:bg-accent"
              onPointerDown={startTerminalResize}
            />
          )}
          {terminalMounted && (
            <div
              className={
                terminalDetached
                  ? 'hidden'
                  : showTerminal
                    ? 'flex flex-shrink-0 flex-col [&>*]:!h-full'
                    : 'hidden'
              }
              style={!terminalDetached && showTerminal ? { height: terminalHeight } : undefined}
            >
              <PanelSlot panel="terminal">
                <ErrorBoundary scope="pane" resetKey={`${workspacePath}:terminal`}>
                  <Suspense fallback={null}>
                    <TerminalPanel
                      workspacePath={workspacePath}
                      cwd={viewRoot}
                      visible={showTerminal}
                      onClose={terminalDetached ? undefined : () => setShowTerminal(false)}
                      active={active || terminalDetached}
                    />
                  </Suspense>
                </ErrorBoundary>
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
                  active={active || chatDetached}
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
})
