import { create } from 'zustand'
import type { SessionSummary } from '../types/electron'
import { conversationKey } from './chatStore'

export const MAX_OPEN_SESSIONS = 8

/** 待操作原因；v1 只做占位，暂不产生触发 */
export type NeedsActionReason = 'review' | 'input' | 'confirm'

export interface WorkspaceSessions {
  sessions: SessionSummary[]
  open: string[]
  active: string | null
  panelOpen: boolean
}

const EMPTY_WORKSPACE: WorkspaceSessions = {
  sessions: [],
  open: [],
  active: null,
  panelOpen: false,
}

interface SessionState {
  byWorkspace: Record<string, WorkspaceSessions>
  /** conversationKey -> 是否正在流式输出 */
  streaming: Record<string, boolean>
  /** conversationKey -> 后台完成未读 */
  unread: Record<string, boolean>
  /** conversationKey -> 最近一次请求错误（保留到下次发送或成功回复） */
  errors: Record<string, string>
  /** conversationKey -> 待操作原因（工具审批等待时设置） */
  needsAction: Record<string, NeedsActionReason>
  /** 通知点击后待激活的会话（工作区切换完成后由 ChatPanel 消费） */
  pendingActivation: { workspaceDir: string; sessionId: string } | null
  /**
   * `workspacePath\0sessionId` -> 已确定的标题。
   * 由 `agent:session-title`（模型生成）与手动重命名写入，之后任何列表刷新都不能
   * 把它改回空或旧的回退文本：标题确定后不允许在屏幕上再变。
   */
  pinnedTitles: Record<string, string>

  requestActivation: (workspaceDir: string, sessionId: string) => void
  clearPendingActivation: () => void
  setSessions: (workspacePath: string, sessions: SessionSummary[]) => void
  pinTitle: (workspacePath: string, sessionId: string, title: string) => void
  setOpen: (workspacePath: string, open: string[], active: string | null) => void
  setActive: (workspacePath: string, active: string | null) => void
  addOpen: (workspacePath: string, sessionId: string, summary?: SessionSummary) => boolean
  closeOpen: (workspacePath: string, sessionId: string) => string | null
  removeSession: (workspacePath: string, sessionId: string) => string | null
  updateSession: (
    workspacePath: string,
    sessionId: string,
    patch: Partial<SessionSummary>
  ) => void
  setPanelOpen: (workspacePath: string, open: boolean) => void
  markStreaming: (workspacePath: string, sessionId: string, streaming: boolean) => void
  markUnread: (workspacePath: string, sessionId: string, unread: boolean) => void
  markError: (workspacePath: string, sessionId: string, message: string | null) => void
  markNeedsAction: (
    workspacePath: string,
    sessionId: string,
    reason: NeedsActionReason | null
  ) => void
  resetWorkspace: (workspacePath: string) => void
  reset: () => void
}

function workspace(state: SessionState, path: string): WorkspaceSessions {
  return state.byWorkspace[path] ?? EMPTY_WORKSPACE
}

function titleKey(path: string, sessionId: string): string {
  return `${path}\u0000${sessionId}`
}

/** 已确定的标题优先于任何传入的会话摘要 */
function withPinnedTitle(
  state: SessionState,
  path: string,
  session: SessionSummary
): SessionSummary {
  const pinned = state.pinnedTitles[titleKey(path, session.id)]
  return pinned && pinned !== session.title ? { ...session, title: pinned } : session
}

/**
 * 列表刷新只允许补全标题：已确定的标题（钉住 / 已有非空值）不会被刷成空。
 * 标题变空只可能来自会话还没定名，绝不应当把已经显示出来的标题收回。
 */
function applyTitlePolicy(
  state: SessionState,
  path: string,
  sessions: SessionSummary[]
): SessionSummary[] {
  const previous = new Map(
    (state.byWorkspace[path]?.sessions ?? []).map((session) => [session.id, session])
  )
  return sessions.map((session) => {
    const resolved = withPinnedTitle(state, path, session)
    if (resolved.title?.trim()) return resolved
    const previousTitle = previous.get(session.id)?.title?.trim()
    return previousTitle ? { ...resolved, title: previousTitle } : resolved
  })
}

function withWorkspace(
  state: SessionState,
  path: string,
  patch: Partial<WorkspaceSessions>
): Partial<SessionState> {
  return {
    byWorkspace: {
      ...state.byWorkspace,
      [path]: { ...workspace(state, path), ...patch },
    },
  }
}

export const useSessionStore = create<SessionState>((set) => ({
  byWorkspace: {},
  streaming: {},
  unread: {},
  errors: {},
  needsAction: {},
  pendingActivation: null,
  pinnedTitles: {},

  requestActivation: (workspaceDir, sessionId) =>
    set({ pendingActivation: { workspaceDir, sessionId } }),

  clearPendingActivation: () => set({ pendingActivation: null }),

  setSessions: (path, sessions) =>
    set((state) =>
      withWorkspace(state, path, { sessions: applyTitlePolicy(state, path, sessions) })
    ),

  /** 钉住一个已确定的标题，并立即应用；之后的列表刷新无法再降级或改写它 */
  pinTitle: (path, sessionId, title) =>
    set((state) => {
      const value = title.trim()
      if (!value) return state
      const current = workspace(state, path)
      return {
        pinnedTitles: { ...state.pinnedTitles, [titleKey(path, sessionId)]: value },
        byWorkspace: {
          ...state.byWorkspace,
          [path]: {
            ...current,
            sessions: current.sessions.map((session) =>
              session.id === sessionId ? { ...session, title: value } : session
            ),
          },
        },
      }
    }),

  setOpen: (path, open, active) =>
    set((state) => withWorkspace(state, path, { open, active })),

  setActive: (path, active) => set((state) => withWorkspace(state, path, { active })),

  addOpen: (path, sessionId, summary) => {
    let added = true
    set((state) => {
      const current = workspace(state, path)
      const existing = current.sessions.find((session) => session.id === sessionId)
      const nextSessions =
        summary && !existing
          ? [...current.sessions, withPinnedTitle(state, path, summary)]
          : summary && existing
            ? current.sessions.map((session) =>
                session.id === sessionId ? withPinnedTitle(state, path, summary) : session
              )
            : current.sessions

      if (current.open.includes(sessionId)) {
        return withWorkspace(state, path, {
          sessions: nextSessions,
          active: sessionId,
        })
      }
      if (current.open.length >= MAX_OPEN_SESSIONS) {
        added = false
        return state
      }
      return withWorkspace(state, path, {
        sessions: nextSessions,
        open: [...current.open, sessionId],
        active: sessionId,
      })
    })
    return added
  },

  closeOpen: (path, sessionId) => {
    let nextActive: string | null = null
    set((state) => {
      const current = workspace(state, path)
      const index = current.open.indexOf(sessionId)
      if (index === -1) return state
      const open = current.open.filter((id) => id !== sessionId)
      nextActive =
        current.active === sessionId
          ? open[Math.min(index, open.length - 1)] ?? null
          : current.active
      return withWorkspace(state, path, { open, active: nextActive })
    })
    return nextActive
  },

  removeSession: (path, sessionId) => {
    let nextActive: string | null = null
    set((state) => {
      const current = workspace(state, path)
      const index = current.open.indexOf(sessionId)
      const open = current.open.filter((id) => id !== sessionId)
      nextActive =
        current.active === sessionId
          ? open[Math.min(index === -1 ? 0 : index, open.length - 1)] ?? null
          : current.active
      return withWorkspace(state, path, {
        sessions: current.sessions.filter((session) => session.id !== sessionId),
        open,
        active: nextActive,
      })
    })
    set((state) => {
      const pinnedTitles = { ...state.pinnedTitles }
      delete pinnedTitles[titleKey(path, sessionId)]
      return { pinnedTitles }
    })
    return nextActive
  },

  updateSession: (path, sessionId, patch) =>
    set((state) => {
      const current = workspace(state, path)
      const pinned = state.pinnedTitles[titleKey(path, sessionId)]
      return withWorkspace(state, path, {
        sessions: current.sessions.map((session) => {
          if (session.id !== sessionId) return session
          const next = { ...session, ...patch }
          // 已显示的标题不被清空；已确定的标题以钉住的为准
          if (!next.title?.trim() && session.title?.trim()) next.title = session.title
          if (pinned) next.title = pinned
          return next
        }),
      })
    }),

  setPanelOpen: (path, open) => set((state) => withWorkspace(state, path, { panelOpen: open })),

  markStreaming: (path, sessionId, streaming) =>
    set((state) => {
      const key = conversationKey(path, sessionId)
      const streamingMap = { ...state.streaming }
      if (streaming) streamingMap[key] = true
      else delete streamingMap[key]
      return { streaming: streamingMap }
    }),

  markUnread: (path, sessionId, unread) =>
    set((state) => {
      const key = conversationKey(path, sessionId)
      const unreadMap = { ...state.unread }
      if (unread) unreadMap[key] = true
      else delete unreadMap[key]
      return { unread: unreadMap }
    }),

  markError: (path, sessionId, message) =>
    set((state) => {
      const key = conversationKey(path, sessionId)
      const errors = { ...state.errors }
      if (message) errors[key] = message
      else delete errors[key]
      return { errors }
    }),

  markNeedsAction: (path, sessionId, reason) =>
    set((state) => {
      const key = conversationKey(path, sessionId)
      const needsAction = { ...state.needsAction }
      if (reason) needsAction[key] = reason
      else delete needsAction[key]
      return { needsAction }
    }),

  resetWorkspace: (path) =>
    set((state) => {
      const byWorkspace = { ...state.byWorkspace }
      delete byWorkspace[path]
      const prefix = `${path}\u0000`
      const streaming = Object.fromEntries(
        Object.entries(state.streaming).filter(([key]) => !key.startsWith(prefix))
      )
      const unread = Object.fromEntries(
        Object.entries(state.unread).filter(([key]) => !key.startsWith(prefix))
      )
      const errors = Object.fromEntries(
        Object.entries(state.errors).filter(([key]) => !key.startsWith(prefix))
      )
      const needsAction = Object.fromEntries(
        Object.entries(state.needsAction).filter(([key]) => !key.startsWith(prefix))
      )
      const pinnedTitles = Object.fromEntries(
        Object.entries(state.pinnedTitles).filter(([key]) => !key.startsWith(prefix))
      )
      return { byWorkspace, streaming, unread, errors, needsAction, pinnedTitles }
    }),

  reset: () =>
    set({
      byWorkspace: {},
      streaming: {},
      unread: {},
      errors: {},
      needsAction: {},
      pendingActivation: null,
      pinnedTitles: {},
    }),
}))
