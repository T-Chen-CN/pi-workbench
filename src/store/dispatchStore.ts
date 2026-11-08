/**
 * 派活状态：配置（开关 + 工作区白名单）、运行态、最近完成的任务。
 *
 * 与 `cloudStore` 分开是刻意的：派活的失败不该污染云端会话的错误横幅，
 * 反过来也一样。
 */

import { create } from 'zustand'
import {
  EMPTY_DISPATCH_CONFIG,
  dispatchApi,
  type DispatchWorkspace,
} from '../api/dispatch'
import type { DispatchPublicConfig, DispatchWorkerState } from '../types/electron'

export interface DispatchRecentTask {
  taskId: string
  workspaceLabel: string
  state: 'completed' | 'failed' | 'canceled'
  summary: string
  sessionId: string | null
  at: number
}

interface DispatchState {
  config: DispatchPublicConfig
  loading: boolean
  busy: boolean
  error: string | null
  /** 最近完成的任务：从主进程的账本读，界面只展示 */
  recent: DispatchRecentTask[]
  load: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  addWorkspace: () => Promise<void>
  updateWorkspace: (input: { id: string; label?: string; description?: string }) => Promise<void>
  removeWorkspace: (id: string) => Promise<void>
  stop: () => Promise<void>
  /** 主进程推送的运行态（也带最近任务） */
  applyState: (payload: unknown) => void
}

function extract(payload: unknown): {
  config?: DispatchPublicConfig
  state?: DispatchWorkerState
  recent?: DispatchRecentTask[]
} {
  if (!payload || typeof payload !== 'object') return {}
  const source = payload as Record<string, unknown>
  const config = source.config as DispatchPublicConfig | undefined
  return {
    config,
    state: (source.state as DispatchWorkerState | undefined) ?? config?.state,
    recent: Array.isArray(source.recent) ? (source.recent as DispatchRecentTask[]) : undefined,
  }
}

export const useDispatchStore = create<DispatchState>((set, get) => ({
  config: EMPTY_DISPATCH_CONFIG,
  loading: false,
  busy: false,
  error: null,
  recent: [],

  load: async () => {
    set({ loading: true, error: null })
    const result = await dispatchApi.get()
    set({
      loading: false,
      config: result.config ?? EMPTY_DISPATCH_CONFIG,
      error: result.success ? null : result.error ?? null,
    })
  },

  setEnabled: async (enabled) => {
    set({ busy: true, error: null })
    const result = await dispatchApi.setEnabled(enabled)
    set({
      busy: false,
      config: result.config ?? get().config,
      error: result.success ? null : result.error ?? null,
    })
    if (result.success) await get().load()
  },

  addWorkspace: async () => {
    set({ busy: true, error: null })
    const result = await dispatchApi.addWorkspace()
    set({
      busy: false,
      config: result.config ?? get().config,
      error: result.success ? null : result.error ?? null,
    })
  },

  updateWorkspace: async (input) => {
    set({ busy: true, error: null })
    const result = await dispatchApi.updateWorkspace(input)
    set({
      busy: false,
      config: result.config ?? get().config,
      error: result.success ? null : result.error ?? null,
    })
  },

  removeWorkspace: async (id) => {
    set({ busy: true, error: null })
    const result = await dispatchApi.removeWorkspace(id)
    set({
      busy: false,
      config: result.config ?? get().config,
      error: result.success ? null : result.error ?? null,
    })
  },

  stop: async () => {
    set({ busy: true, error: null })
    const result = await dispatchApi.stop()
    set({
      busy: false,
      config: result.config ?? get().config,
      error: result.success ? null : result.error ?? null,
    })
  },

  applyState: (payload) => {
    const { config, state, recent } = extract(payload)
    const next = config ?? get().config
    set({
      config: state ? { ...next, state } : next,
      recent: recent ?? get().recent,
    })
  },
}))

export function dispatchWorkspaces(config: DispatchPublicConfig): DispatchWorkspace[] {
  return config.workspaces
}
