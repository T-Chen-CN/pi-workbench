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
import type {
  DispatchConfigResult,
  DispatchPublicConfig,
  DispatchWorkerState,
} from '../types/electron'

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

/**
 * 主进程推送的是「运行态本身」，IPC 返回的是「配置 + 运行态」。
 * 两种形状都在这里归一，否则界面会一直显示空账本。
 */
function extract(payload: unknown): {
  config?: DispatchPublicConfig
  state?: DispatchWorkerState
  recent?: DispatchRecentTask[]
} {
  if (!payload || typeof payload !== 'object') return {}
  const source = payload as Record<string, unknown>
  const config = source.config as DispatchPublicConfig | undefined
  const state =
    (source.state as DispatchWorkerState | undefined) ??
    (typeof source.enabled === 'boolean' ? (source as unknown as DispatchWorkerState) : undefined) ??
    config?.state
  const recent = Array.isArray(source.recent)
    ? (source.recent as DispatchRecentTask[])
    : config?.state?.recent
  return { config, state, recent }
}

/** 每个动作的返回都是同一种形状：配置（含运行态）+ 账本 */
function merge(current: DispatchPublicConfig, result: DispatchConfigResult): Partial<DispatchState> {
  const config = result.config ?? current
  return {
    config,
    recent: config.state.recent,
    error: result.success ? null : result.error ?? null,
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
    set({ loading: false, ...merge(get().config, result) })
  },

  setEnabled: async (enabled) => {
    set({ busy: true, error: null })
    const result = await dispatchApi.setEnabled(enabled)
    set({ busy: false, ...merge(get().config, result) })
    if (result.success) await get().load()
  },

  addWorkspace: async () => {
    set({ busy: true, error: null })
    const result = await dispatchApi.addWorkspace()
    set({ busy: false, ...merge(get().config, result) })
  },

  updateWorkspace: async (input) => {
    set({ busy: true, error: null })
    const result = await dispatchApi.updateWorkspace(input)
    set({ busy: false, ...merge(get().config, result) })
  },

  removeWorkspace: async (id) => {
    set({ busy: true, error: null })
    const result = await dispatchApi.removeWorkspace(id)
    set({ busy: false, ...merge(get().config, result) })
  },

  stop: async () => {
    set({ busy: true, error: null })
    const result = await dispatchApi.stop()
    set({ busy: false, ...merge(get().config, result) })
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
