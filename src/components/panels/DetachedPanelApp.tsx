/**
 * 独立拆出面板的原生 BrowserWindow 应用根组件（Phase E · 多窗口架构）。
 *
 * 当主进程通过 `panel:detach` 打开 `?windowMode=panel&panel=<id>&workspace=<path>&hostId=<id>` 时，
 * 由 `src/main.tsx` 直接挂载本组件：
 * - 复用完全一致的 Paper & Ink 主题、i18n 与设置状态；
 * - 接入 `installWindowSync` 与主进程广播事件（审批、崩溃、Git 变化、文件树变化、终端 PTY）；
 * - 内部挂载 `<PanelWindowFrame>` 与 `<DiffViewer>`，确保审阅变更、确认弹窗与 Toast 都在当前拆出窗口就地呈现。
 */

import React, { lazy, Suspense, useEffect } from 'react'
import { api } from '../../api'
import { piAgentAPI } from '../../api/piAgentAPI'
import { ChatPanel } from '../chat/ChatPanel'
import { DiffViewer } from '../editor/DiffViewer'
import { FileExplorer } from '../files/FileExplorer'
import { CommitDetailView } from '../git/CommitDetailView'
import { GitView } from '../git/GitView'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { Spinner } from '../ui/ui'
import { HostProvider } from '../../panelHost/HostContext'
import { setFocusedHostResolver } from '../../panelHost/focus'
import { broadcastSync, installWindowSync } from '../../panelHost/windowSync'
import type { HostId, PanelId } from '../../panelHost/types'
import { useApprovalStore } from '../../store/approvalStore'
import { conversationKey, useChatStore } from '../../store/chatStore'
import { useGitStore } from '../../store/gitStore'
import { useI18nStore } from '../../store/i18nStore'
import { useSessionStore } from '../../store/sessionStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useResolvedTheme } from '../../store/themeStore'
import { toast } from '../../store/toastStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { WorkspaceStoresProvider } from '../../store/WorkspaceStoresContext'
import type { GitChangeScope } from '../../types/electron'
import { onAppEvent } from '../../utils/appEvents'
import { basename } from '../../utils/filePath'
import { WorkspaceScopeProvider } from '../../workspace/WorkspaceScope'
import { PanelWindowFrame } from './PanelWindowFrame'

const TerminalPanel = lazy(() =>
  import('../editor/TerminalPanel').then((module) => ({ default: module.TerminalPanel }))
)

function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\+/g, '/').replace(/\/+$/, '')
  const a = normalize(left)
  const b = normalize(right)
  return window.electronAPI?.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export interface DetachedPanelAppProps {
  panel: PanelId
  workspacePath: string
  hostId: HostId
}

export const DetachedPanelApp: React.FC<DetachedPanelAppProps> = ({
  panel,
  workspacePath,
  hostId,
}) => {
  const language = useI18nStore((state) => state.language)
  const resolvedTheme = useResolvedTheme()
  const activeSessionId = useSessionStore((state) => state.byWorkspace[workspacePath]?.active ?? null)
  const viewRoot = useGitStore((state) =>
    activeSessionId
      ? (state.byWorkspace[workspacePath]?.bindings[activeSessionId]?.path ?? workspacePath)
      : workspacePath
  )
  const detailOpen = useGitStore((state) => state.byWorkspace[workspacePath]?.detailOpen ?? false)
  const closeCommitDetail = useGitStore((state) => state.closeCommitDetail)

  // 固定本窗口的焦点宿主标识与工作区上下文，保证 Toast / Dialog 落在当前独立窗口
  useEffect(() => {
    setFocusedHostResolver(() => hostId)
    useWorkspaceStore.getState().openWorkspace(workspacePath)
  }, [hostId, workspacePath])

  // 同步文档主题、语言与窗口标题（只显示工作区名，与 ADR-001 保持一致）
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark')
  }, [resolvedTheme])

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
    document.title = basename(workspacePath) || workspacePath
  }, [language, workspacePath])

  // 挂载跨窗口状态同步（主题、语言、活跃会话、面板 UI 快照、文件打开转发）
  useEffect(
    () => installWindowSync(hostId, { workspaceDir: workspacePath, panel }),
    [hostId, workspacePath, panel]
  )

  // 水合排序/快捷键/预算等应用设置（主题与语言优先保留启动参数与实时同步值）
  useEffect(() => {
    let cancelled = false
    void api
      .getSettings()
      .then((result) => {
        if (cancelled || !result.success || !result.settings) return
        useSettingsStore.getState().hydrate(result.settings)
      })
      .catch((error) => {
        console.error('[DetachedPanelApp] Failed to hydrate settings:', error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 拆出窗口内点击「打开设置」时转发给主窗口
  useEffect(
    () =>
      onAppEvent('open-settings', (detail) => {
        broadcastSync({ kind: 'open-settings', section: detail?.section }, hostId)
      }),
    [hostId]
  )

  // 拆出窗口是 chat 时，接入审批请求、审批解决与 Agent utilityProcess 崩溃自愈广播
  useEffect(() => {
    if (panel !== 'chat') return
    const offRequest = piAgentAPI.onApprovalRequest((request) => {
      useApprovalStore.getState().add(request)
      useSessionStore.getState().markNeedsAction(request.workspaceDir, request.sessionId, 'input')
    })
    const offResolved = piAgentAPI.onApprovalResolved(({ requestId, workspaceDir, sessionId }) => {
      useApprovalStore.getState().remove(requestId)
      const remaining = useApprovalStore
        .getState()
        .requests.some(
          (item) => item.workspaceDir === workspaceDir && item.sessionId === sessionId
        )
      if (!remaining) {
        useSessionStore.getState().markNeedsAction(workspaceDir, sessionId, null)
      }
    })
    const offHostCrashed = piAgentAPI.onHostCrashed(
      ({ workspaceDir, exitCode, interruptedSessionIds }) => {
        const chatState = useChatStore.getState()
        const crashMessage = `Agent process crashed (exit code ${exitCode}). Send a message to automatically restart.`
        const targetKeys = new Set<string>(
          interruptedSessionIds.map((sessionId) => conversationKey(workspaceDir, sessionId))
        )
        const prefix = `${workspaceDir}\u0000`
        for (const [key, conv] of Object.entries(chatState.conversations)) {
          if (key.startsWith(prefix) && (conv.isLoading || conv.isCompacting)) {
            targetKeys.add(key)
          }
        }
        for (const key of targetKeys) {
          chatState.setLoading(key, false)
          chatState.setCompacting(key, false)
          chatState.setError(key, crashMessage)
        }
        toast.error(crashMessage)
      }
    )
    return () => {
      offRequest()
      offResolved()
      offHostCrashed()
      useApprovalStore.getState().reset()
    }
  }, [panel])

  // 拆出窗口是 git 时，接入仓库变更与工作树依赖安装推送
  useEffect(() => {
    if (panel !== 'git') return
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
    const offChanged = api.onGitChanged((payload) => {
      if (!sameWorkspacePath(payload.workspaceDir, workspacePath)) return
      for (const scope of payload.scopes) pending.add(scope)
      if (timer === null) timer = setTimeout(flush, 100)
    })
    const offDeps =
      typeof api.onGitWorktreeDeps === 'function'
        ? api.onGitWorktreeDeps((payload) => {
            if (!sameWorkspacePath(payload.workspaceDir, workspacePath)) return
            useGitStore.getState().handleWorktreeDeps(workspacePath, payload)
          })
        : () => {}
    return () => {
      offChanged()
      offDeps()
      if (timer !== null) clearTimeout(timer)
    }
  }, [panel, workspacePath, activeSessionId])

  // 同步当前会话绑定的工作树根（确保文件树 / 终端 / 聊天在工作树会话下指向正确目录）
  useEffect(() => {
    if (!activeSessionId) return
    void useGitStore.getState().load(workspacePath, activeSessionId)
  }, [workspacePath, activeSessionId])

  return (
    <HostProvider host={hostId}>
      <WorkspaceScopeProvider value={workspacePath}>
        <WorkspaceStoresProvider workspacePath={workspacePath}>
          <div className="h-screen w-screen overflow-hidden bg-panel text-ink">
            <PanelWindowFrame panel={panel} workspacePath={workspacePath} host={hostId}>
              <ErrorBoundary scope="pane" resetKey={`${viewRoot}:${panel}:${activeSessionId ?? ''}`}>
                {panel === 'files' && <FileExplorer workspacePath={viewRoot} active />}
                {panel === 'git' && (
                  <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                    <GitView workspacePath={workspacePath} active />
                    {detailOpen && (
                      <CommitDetailView
                        workspacePath={workspacePath}
                        active
                        onClose={() => closeCommitDetail(workspacePath)}
                      />
                    )}
                  </div>
                )}
                {panel === 'chat' && (
                  <ChatPanel workspacePath={workspacePath} viewRoot={viewRoot} active />
                )}
                {panel === 'terminal' && (
                  <Suspense
                    fallback={
                      <div className="flex min-h-0 flex-1 items-center justify-center bg-panel">
                        <Spinner size={14} />
                      </div>
                    }
                  >
                    <TerminalPanel workspacePath={workspacePath} cwd={viewRoot} visible active />
                  </Suspense>
                )}
              </ErrorBoundary>
              <DiffViewer workspacePath={viewRoot} active />
            </PanelWindowFrame>
          </div>
        </WorkspaceStoresProvider>
      </WorkspaceScopeProvider>
    </HostProvider>
  )
}
