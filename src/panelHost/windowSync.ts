/**
 * 跨原生 BrowserWindow 状态同步（Phase E · 原生多窗口架构）。
 *
 * 主窗口与各独立拆出面板窗口通过主进程 `sync:broadcast` → `sync:state` 保持一致：
 * - 主题（Paper / Ink / System）与界面语言（zh / en）实时同步；
 * - 活跃会话（active-session）双向同步；
 * - 拆出窗口点击文件 / 设置请求转发给主窗口打开并置前；
 * - 面板 UI 快照（展开目录、滚动位置）在拆窗 / 回位往返中保持连续；
 * - 所有入站应用均由 `suppressBroadcast` 保护，杜绝跨窗回声循环。
 */

import { api } from '../api'
import type { SettingsSection } from '../components/settings/Settings'
import { useGitStore } from '../store/gitStore'
import { useI18nStore } from '../store/i18nStore'
import { usePanelStore } from '../store/panelStore'
import { useSessionStore } from '../store/sessionStore'
import { useThemeStore } from '../store/themeStore'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { WindowSyncMessage } from '../types/electron'
import { emitAppEvent } from '../utils/appEvents'
import { openFileInEditor } from '../workspace/openFileInEditor'
import {
  listPanelUi,
  setPanelUiWriteListener,
  writePanelUiLocal,
} from './panelUiState'
import { MAIN_HOST, type HostId, type PanelId } from './types'

type WindowSyncPayload =
  | { kind: 'theme'; mode: 'light' | 'dark' | 'system' }
  | { kind: 'language'; language: 'zh' | 'en' }
  | { kind: 'active-session'; workspaceDir: string; sessionId: string | null }
  | { kind: 'open-file'; workspaceDir: string; filePath: string; line?: number }
  | { kind: 'panel-ui-state'; workspaceDir: string; name: string; value: unknown }
  | { kind: 'worktree-changed'; workspaceDir: string; sessionId?: string | null; root?: string }
  | { kind: 'panel-docked'; workspaceDir: string; panel: PanelId; hostId: string }
  | { kind: 'panel-ready'; workspaceDir: string; panel: PanelId }
  | { kind: 'open-settings'; section?: string }

let activeHostId: HostId = MAIN_HOST
let suppressBroadcast = false

function normalizePathCmp(value: string): string {
  const normalized = value.replace(/\\+/g, '/').replace(/\/+$/, '')
  return typeof window !== 'undefined' && window.electronAPI?.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized
}

function findMatchingOpenWorkspace(targetRoot: string): string | null {
  const openWorkspaces = useWorkspaceStore.getState().openWorkspaces
  const target = normalizePathCmp(targetRoot)
  for (const ws of openWorkspaces) {
    const candidate = normalizePathCmp(ws)
    if (target === candidate || target.startsWith(`${candidate}/`)) {
      return ws
    }
  }
  return null
}

/** 向其它窗口广播跨窗状态消息（入站应用期间自动静默，防止回声循环） */
export function broadcastSync(payload: WindowSyncPayload, sourceHost?: HostId): void {
  if (suppressBroadcast) return
  if (typeof api.syncBroadcast !== 'function') return
  const message: WindowSyncMessage = {
    ...payload,
    sourceHost: sourceHost ?? activeHostId,
  }
  void api.syncBroadcast(message).catch(() => undefined)
}

export interface InstallWindowSyncOptions {
  workspaceDir?: string
  panel?: PanelId
}

/**
 * 在当前窗口安装跨窗状态同步。
 * 返回清理函数，在窗口卸载时注销所有订阅。
 */
export function installWindowSync(
  hostId: HostId,
  options?: InstallWindowSyncOptions
): () => void {
  activeHostId = hostId

  const applyIncoming = (message: WindowSyncMessage): void => {
    if (!message || typeof message !== 'object') return
    if (message.sourceHost === hostId) return

    suppressBroadcast = true
    try {
      switch (message.kind) {
        case 'theme': {
          if (useThemeStore.getState().mode !== message.mode) {
            useThemeStore.getState().setMode(message.mode)
          }
          break
        }
        case 'language': {
          if (useI18nStore.getState().language !== message.language) {
            useI18nStore.getState().setLanguage(message.language)
          }
          break
        }
        case 'active-session': {
          const current = useSessionStore.getState().byWorkspace[message.workspaceDir]?.active ?? null
          if (current !== message.sessionId) {
            useSessionStore.getState().setActive(message.workspaceDir, message.sessionId)
          }
          break
        }
        case 'open-file': {
          if (hostId !== MAIN_HOST) break
          const matched = findMatchingOpenWorkspace(message.workspaceDir)
          if (matched) {
            useWorkspaceStore.getState().openWorkspace(matched)
            emitAppEvent('focus-workspace')
          }
          void openFileInEditor(message.workspaceDir, message.filePath, {
            revealLine: message.line,
          })
          break
        }
        case 'panel-ui-state': {
          writePanelUiLocal(message.workspaceDir, message.name, message.value)
          break
        }
        case 'worktree-changed': {
          void useGitStore
            .getState()
            .refreshWorktrees(message.workspaceDir, message.sessionId ?? null)
          break
        }
        case 'panel-docked': {
          if (hostId === MAIN_HOST) {
            usePanelStore.getState().handleWindowClosed(message.hostId)
          }
          break
        }
        case 'open-settings': {
          if (hostId === MAIN_HOST) {
            emitAppEvent(
              'open-settings',
              message.section ? { section: message.section as SettingsSection } : undefined
            )
          }
          break
        }
        case 'panel-ready': {
          if (hostId !== MAIN_HOST) break
          // 新打开的拆出窗口就绪：回推当前主题、语言、活跃会话与面板 UI 快照
          suppressBroadcast = false
          broadcastSync({ kind: 'theme', mode: useThemeStore.getState().mode }, MAIN_HOST)
          broadcastSync({ kind: 'language', language: useI18nStore.getState().language }, MAIN_HOST)
          const activeSession =
            useSessionStore.getState().byWorkspace[message.workspaceDir]?.active ?? null
          if (activeSession !== null) {
            broadcastSync(
              {
                kind: 'active-session',
                workspaceDir: message.workspaceDir,
                sessionId: activeSession,
              },
              MAIN_HOST
            )
          }
          for (const entry of listPanelUi(message.workspaceDir)) {
            broadcastSync(
              {
                kind: 'panel-ui-state',
                workspaceDir: message.workspaceDir,
                name: entry.name,
                value: entry.value,
              },
              MAIN_HOST
            )
          }
          break
        }
      }
    } finally {
      suppressBroadcast = false
    }
  }

  const offIpc = typeof api.onSyncState === 'function' ? api.onSyncState(applyIncoming) : () => {}

  const offTheme = useThemeStore.subscribe((state, prev) => {
    if (suppressBroadcast || state.mode === prev.mode) return
    broadcastSync({ kind: 'theme', mode: state.mode }, hostId)
  })

  const offLang = useI18nStore.subscribe((state, prev) => {
    if (suppressBroadcast || state.language === prev.language) return
    broadcastSync({ kind: 'language', language: state.language }, hostId)
  })

  const offSession = useSessionStore.subscribe((state, prev) => {
    if (suppressBroadcast || state.byWorkspace === prev.byWorkspace) return
    for (const [workspaceDir, ws] of Object.entries(state.byWorkspace)) {
      const prevActive = prev.byWorkspace[workspaceDir]?.active ?? null
      const nextActive = ws.active ?? null
      if (nextActive !== prevActive) {
        broadcastSync({ kind: 'active-session', workspaceDir, sessionId: nextActive }, hostId)
      }
    }
  })

  setPanelUiWriteListener((workspaceDir, name, value) => {
    broadcastSync({ kind: 'panel-ui-state', workspaceDir, name, value }, hostId)
  })

  if (hostId !== MAIN_HOST && options?.workspaceDir && options?.panel) {
    broadcastSync(
      {
        kind: 'panel-ready',
        workspaceDir: options.workspaceDir,
        panel: options.panel,
      },
      hostId
    )
  }

  return () => {
    offIpc()
    offTheme()
    offLang()
    offSession()
    setPanelUiWriteListener(null)
    if (activeHostId === hostId) activeHostId = MAIN_HOST
  }
}
