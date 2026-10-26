/** 每个工作区的 Git 工作树、分支、提交与 GitHub 状态 */

import { create } from 'zustand'
import { api } from '../api'
import type {
  GitBranchInfo,
  GitCommitDetail,
  GitCommitInfo,
  GitRepoInfo,
  GitSessionBinding,
  GitStatusInfo,
  GitWorktreeView,
  GithubPrStatus,
} from '../types/electron'

export interface WorkspaceGitState {
  repo: GitRepoInfo | null
  worktrees: GitWorktreeView[]
  branches: GitBranchInfo[]
  bindings: Record<string, GitSessionBinding>
  status: GitStatusInfo | null
  commits: GitCommitInfo[]
  commitDetail: GitCommitDetail | null
  /** 正在加载的提交 sha；用于立即高亮与加载态 */
  detailPending: string | null
  pr: GithubPrStatus | null
  loading: boolean
  error: string | null
}

const EMPTY: WorkspaceGitState = {
  repo: null,
  worktrees: [],
  branches: [],
  bindings: {},
  status: null,
  commits: [],
  commitDetail: null,
  detailPending: null,
  pr: null,
  loading: false,
  error: null,
}

/** 每个工作区最近一次详情请求的序号：后发的请求让先发的响应失效 */
const detailRequests = new Map<string, number>()

interface GitState {
  byWorkspace: Record<string, WorkspaceGitState>
  load: (workspaceDir: string, activeSessionId?: string | null) => Promise<void>
  refreshWorktrees: (workspaceDir: string, activeSessionId?: string | null) => Promise<void>
  loadBranches: (workspaceDir: string) => Promise<void>
  switchWorktree: (
    workspaceDir: string,
    sessionId: string,
    target: string,
    base?: string
  ) => Promise<{ success: boolean; error?: string; scheduled?: boolean }>
  loadCommits: (workspaceDir: string, limit?: number, branch?: string) => Promise<void>
  loadCommitDetail: (workspaceDir: string, sha: string) => Promise<void>
  loadPr: (workspaceDir: string, worktreePath?: string) => Promise<void>
  setGithubToken: (token: string) => Promise<{ success: boolean; error?: string }>
  checkout: (workspaceDir: string, worktreePath: string, branch: string) => Promise<{ success: boolean; error?: string }>
  merge: (
    workspaceDir: string,
    worktreePath: string,
    branch: string,
    strategy?: 'merge' | 'squash' | 'rebase'
  ) => Promise<{ success: boolean; error?: string }>
  sessionRoot: (workspaceDir: string, sessionId?: string | null) => string | null
  reset: (workspaceDir: string) => void
}

function workspace(state: GitState, path: string): WorkspaceGitState {
  return state.byWorkspace[path] ?? EMPTY
}

function patch(
  state: GitState,
  path: string,
  changes: Partial<WorkspaceGitState>
): Partial<GitState> {
  return {
    byWorkspace: {
      ...state.byWorkspace,
      [path]: { ...workspace(state, path), ...changes },
    },
  }
}

export const useGitStore = create<GitState>((set, get) => ({
  byWorkspace: {},

  load: async (workspaceDir, activeSessionId) => {
    if (typeof api.gitRepoInfo !== 'function') return
    set((state) => patch(state, workspaceDir, { loading: true, error: null }))
    try {
      const info = await api.gitRepoInfo(workspaceDir)
      if (!info.success) {
        set((state) => patch(state, workspaceDir, { loading: false, error: info.error ?? null }))
        return
      }
      const repo = info.repo ?? null
      let binding: GitSessionBinding | null = null
      if (repo && activeSessionId) {
        const bound = await api.gitSessionBinding(workspaceDir, activeSessionId)
        binding = bound.binding ?? null
      }
      let branches: GitBranchInfo[] = []
      if (repo) {
        const result = await api.gitBranches(workspaceDir)
        branches = result.branches ?? []
      }
      set((state) =>
        patch(state, workspaceDir, {
          repo,
          worktrees: info.worktrees ?? [],
          branches,
          loading: false,
          bindings: binding && activeSessionId ? { [activeSessionId]: binding } : {},
        })
      )
    } catch (error) {
      set((state) =>
        patch(state, workspaceDir, {
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        })
      )
    }
  },

  refreshWorktrees: async (workspaceDir, activeSessionId) => {
    if (typeof api.gitListWorktrees !== 'function') return
    try {
      const result = await api.gitListWorktrees(workspaceDir, activeSessionId ?? undefined)
      if (!result.success) return
      set((state) => patch(state, workspaceDir, { worktrees: result.worktrees ?? [] }))
    } catch {
      // 忽略刷新失败；下一次轮询或用户操作会再试
    }
  },

  loadBranches: async (workspaceDir) => {
    if (typeof api.gitBranches !== 'function') return
    const result = await api.gitBranches(workspaceDir)
    if (result.success) {
      set((state) => patch(state, workspaceDir, { branches: result.branches ?? [] }))
    }
  },

  switchWorktree: async (workspaceDir, sessionId, target, base) => {
    if (typeof api.gitBindWorktree !== 'function') return { success: false, error: 'Git is unavailable' }
    try {
      const result = await api.gitBindWorktree(workspaceDir, sessionId, target, base)
      if (!result.success || !result.worktree) {
        return { success: false, error: result.error ?? 'Unable to switch worktree' }
      }
      const worktree = result.worktree
      const scheduled = Boolean(result.switched?.scheduled)
      set((state) => {
        const current = workspace(state, workspaceDir)
        const existing = current.worktrees.some((item) => item.id === worktree.id)
        return patch(state, workspaceDir, {
          // 轮次边界切换尚未生效时，视图保持旧根；收到 session-root-changed 后再刷新
          bindings: scheduled
            ? current.bindings
            : {
                ...current.bindings,
                [sessionId]: { key: worktree.id, path: worktree.path, branch: worktree.branch },
              },
          worktrees: existing
            ? current.worktrees.map((item) => (item.id === worktree.id ? worktree : item))
            : [...current.worktrees, worktree],
        })
      })
      return {
        success: true,
        scheduled: result.switched?.scheduled,
        error: result.switched?.success === false ? result.switched.error : undefined,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  loadCommits: async (workspaceDir, limit = 80, branch) => {
    if (typeof api.gitLog !== 'function') return
    const result = await api.gitLog(workspaceDir, limit, branch)
    if (result.success) {
      set((state) => patch(state, workspaceDir, { commits: result.commits ?? [] }))
    }
  },

  loadCommitDetail: async (workspaceDir, sha) => {
    if (typeof api.gitCommitDetail !== 'function') return
    const current = workspace(get(), workspaceDir)
    // 已经是这一条且没有在途请求时不再重复查询
    if (current.commitDetail?.commit.sha.startsWith(sha) && !current.detailPending) return

    const token = (detailRequests.get(workspaceDir) ?? 0) + 1
    detailRequests.set(workspaceDir, token)
    set((state) => patch(state, workspaceDir, { detailPending: sha }))

    const result = await api.gitCommitDetail(workspaceDir, sha).catch(() => null)
    // 期间又点了别的提交：丢弃这次响应，避免旧结果覆盖新选择
    if (detailRequests.get(workspaceDir) !== token) return
    set((state) =>
      patch(state, workspaceDir, {
        commitDetail: result?.success ? result.detail ?? null : null,
        detailPending: null,
      })
    )
  },

  loadPr: async (workspaceDir, worktreePath) => {
    if (typeof api.gitPrStatus !== 'function') return
    const result = await api.gitPrStatus(workspaceDir, worktreePath)
    if (result.success) {
      set((state) => patch(state, workspaceDir, { pr: result.status ?? null }))
    }
  },

  setGithubToken: async (token) => {
    if (typeof api.gitSetGithubToken !== 'function') return { success: false, error: 'Git is unavailable' }
    try {
      const result = await api.gitSetGithubToken(token)
      return { success: result.success, error: result.error }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  checkout: async (workspaceDir, worktreePath, branch) => {
    if (typeof api.gitCheckout !== 'function') return { success: false, error: 'Git is unavailable' }
    const result = await api.gitCheckout(workspaceDir, worktreePath, branch)
    if (result.success) {
      await get().refreshWorktrees(workspaceDir)
      await get().loadBranches(workspaceDir)
    }
    return { success: result.success, error: result.error }
  },

  merge: async (workspaceDir, worktreePath, branch, strategy) => {
    if (typeof api.gitMerge !== 'function') return { success: false, error: 'Git is unavailable' }
    const result = await api.gitMerge(workspaceDir, worktreePath, branch, strategy)
    if (result.success) {
      await get().refreshWorktrees(workspaceDir)
      await get().loadBranches(workspaceDir)
    }
    return { success: result.success, error: result.error }
  },

  sessionRoot: (workspaceDir, sessionId) => {
    if (!sessionId) return null
    return get().byWorkspace[workspaceDir]?.bindings[sessionId]?.path ?? null
  },

  reset: (workspaceDir) =>
    set((state) => {
      // 让在途的详情请求失效，避免它们把结果写回已重置的工作区
      detailRequests.set(workspaceDir, (detailRequests.get(workspaceDir) ?? 0) + 1)
      const byWorkspace = { ...state.byWorkspace }
      delete byWorkspace[workspaceDir]
      return { byWorkspace }
    }),
}))
