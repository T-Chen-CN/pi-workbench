/**
 * 仓库地图状态：按工作区保存扫描结果。
 *
 * 数据源在主进程（`electron/repo-map.ts`），这里只做三件事：
 * 缓存结果、合并增量补齐、避免同一工作区并发重复扫描。
 * 面板是常驻视图，切走再切回来不重扫 —— 除非 `git:changed` 说仓库变了。
 */

import { create } from 'zustand'
import { api } from '../api'
import type { RepoMapFile } from '../types/electron'

export interface WorkspaceRepoMapState {
  status: 'idle' | 'ready' | 'error'
  /** 已拿到过结果（区分「还没扫过」与「扫出来是空仓库」） */
  scanned: boolean
  scanning: boolean
  isRepo: boolean
  /** 仓库根：文件路径相对它，打开文件时用它拼绝对路径 */
  repoRoot: string | null
  files: RepoMapFile[]
  total: number
  described: number
  truncated: boolean
  error: string | null
  updatedAt: number | null
}

const EMPTY: WorkspaceRepoMapState = {
  status: 'idle',
  scanned: false,
  scanning: false,
  isRepo: true,
  repoRoot: null,
  files: [],
  total: 0,
  described: 0,
  truncated: false,
  error: null,
  updatedAt: null,
}

export function repoMapStateFor(
  state: { byWorkspace: Record<string, WorkspaceRepoMapState> },
  workspaceDir: string
): WorkspaceRepoMapState {
  return state.byWorkspace[workspaceDir] ?? EMPTY
}

function patch(
  state: { byWorkspace: Record<string, WorkspaceRepoMapState> },
  workspaceDir: string,
  changes: Partial<WorkspaceRepoMapState>
): Partial<{ byWorkspace: Record<string, WorkspaceRepoMapState> }> {
  return {
    byWorkspace: {
      ...state.byWorkspace,
      [workspaceDir]: { ...repoMapStateFor(state, workspaceDir), ...changes },
    },
  }
}

/** 同一工作区同时只跑一个 IPC 扫描：主进程会串行执行，重复调用只是白占队列 */
const inFlight = new Set<string>()

interface RepoMapStore {
  byWorkspace: Record<string, WorkspaceRepoMapState>
  scan: (workspaceDir: string, options?: { force?: boolean; paths?: string[] }) => Promise<void>
  reset: (workspaceDir: string) => void
}

export const useRepoMapStore = create<RepoMapStore>((set) => ({
  byWorkspace: {},

  scan: async (workspaceDir, options) => {
    if (typeof api.repoMapScan !== 'function') return
    if (inFlight.has(workspaceDir)) return
    inFlight.add(workspaceDir)
    set((state) => patch(state, workspaceDir, { scanning: true, error: null }))
    try {
      const result = options?.paths?.length
        ? await api.repoMapDescribe(workspaceDir, options.paths)
        : await api.repoMapScan(workspaceDir, options?.force ? { force: true } : undefined)
      if (!result.success) {
        set((state) =>
          patch(state, workspaceDir, {
            scanning: false,
            status: 'error',
            error: result.error ?? 'Scan failed',
          })
        )
        return
      }
      set((state) =>
        patch(state, workspaceDir, {
          scanning: false,
          scanned: true,
          status: 'ready',
          isRepo: result.isRepo,
          repoRoot: result.repoRoot ?? null,
          files: result.files,
          total: result.total,
          described: result.described,
          truncated: result.truncated,
          error: null,
          updatedAt: Date.now(),
        })
      )
    } catch (error) {
      set((state) =>
        patch(state, workspaceDir, {
          scanning: false,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      )
    } finally {
      inFlight.delete(workspaceDir)
    }
  },

  reset: (workspaceDir) => {
    inFlight.delete(workspaceDir)
    set((state) => {
      const next = { ...state.byWorkspace }
      delete next[workspaceDir]
      return { byWorkspace: next }
    })
  },
}))

/** 仅测试用：清空所有工作区的缓存 */
export function resetRepoMapStore(): void {
  inFlight.clear()
  useRepoMapStore.setState({ byWorkspace: {} })
}
