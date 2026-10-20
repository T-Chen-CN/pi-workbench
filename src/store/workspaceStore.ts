import { create } from 'zustand'

interface WorkspaceState {
  /** 当前激活的工作区 */
  workspacePath: string | null
  /** 本次会话中打开的工作区（标签页） */
  openWorkspaces: string[]
  recentWorkspaces: string[]
  setWorkspace: (path: string | null) => void
  /** 打开并激活一个工作区（已打开时只切换） */
  openWorkspace: (path: string) => void
  /** 关闭工作区标签；返回切换后的当前工作区 */
  closeWorkspace: (path: string) => string | null
  setRecentWorkspaces: (paths: string[]) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspacePath: null,
  openWorkspaces: [],
  recentWorkspaces: [],

  setWorkspace: (path) => set({ workspacePath: path }),

  openWorkspace: (path) =>
    set((state) => ({
      workspacePath: path,
      openWorkspaces: state.openWorkspaces.includes(path)
        ? state.openWorkspaces
        : [...state.openWorkspaces, path],
    })),

  closeWorkspace: (path) => {
    const state = get()
    const openWorkspaces = state.openWorkspaces.filter((item) => item !== path)
    const workspacePath =
      state.workspacePath === path
        ? openWorkspaces[openWorkspaces.length - 1] ?? null
        : state.workspacePath

    set({ openWorkspaces, workspacePath })
    return workspacePath
  },

  setRecentWorkspaces: (paths) => set({ recentWorkspaces: paths }),
}))
