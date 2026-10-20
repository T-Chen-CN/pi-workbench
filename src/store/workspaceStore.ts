import { create } from 'zustand'

interface WorkspaceState {
  workspacePath: string | null
  recentWorkspaces: string[]
  setWorkspace: (path: string | null) => void
  setRecentWorkspaces: (paths: string[]) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspacePath: null,
  recentWorkspaces: [],

  setWorkspace: (path) => set({ workspacePath: path }),
  setRecentWorkspaces: (paths) => set({ recentWorkspaces: paths }),
}))
