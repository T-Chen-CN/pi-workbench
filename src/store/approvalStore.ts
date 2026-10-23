import { create } from 'zustand'
import type { ApprovalRequestPayload } from '../types/electron'

interface ApprovalState {
  /** 全局待审批请求：按到达顺序排列 */
  requests: ApprovalRequestPayload[]
  add: (request: ApprovalRequestPayload) => void
  remove: (requestId: string) => void
  clearWorkspace: (workspaceDir: string) => void
  clearSession: (workspaceDir: string, sessionId: string) => void
  reset: () => void
}

/** 工具审批请求队列（AF-01）。响应由调用方通过 piAgentAPI 发出。 */
export const useApprovalStore = create<ApprovalState>((set) => ({
  requests: [],

  add: (request) =>
    set((state) => {
      if (state.requests.some((item) => item.requestId === request.requestId)) return state
      return { requests: [...state.requests, request] }
    }),

  remove: (requestId) =>
    set((state) => ({
      requests: state.requests.filter((item) => item.requestId !== requestId),
    })),

  clearWorkspace: (workspaceDir) =>
    set((state) => ({
      requests: state.requests.filter((item) => item.workspaceDir !== workspaceDir),
    })),

  clearSession: (workspaceDir, sessionId) =>
    set((state) => ({
      requests: state.requests.filter(
        (item) => !(item.workspaceDir === workspaceDir && item.sessionId === sessionId)
      ),
    })),

  reset: () => set({ requests: [] }),
}))
