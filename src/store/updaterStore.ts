import { create } from 'zustand'
import type { UpdateState } from '../types/electron'

/**
 * 全局更新状态。
 *
 * 更新事件由 App 统一订阅，设置页、状态栏和安装弹窗都只读这个 store，
 * 避免关闭设置页后丢失下载进度或“已下载待安装”状态。
 */
export const INITIAL_UPDATE_STATE: UpdateState = {
  status: 'idle',
  currentVersion: '',
  platform: 'web',
  canAutoInstall: false,
}

interface UpdaterStoreState {
  state: UpdateState
  /** 本次运行中用户选择“稍后”的版本；重启应用后自动清除 */
  deferredVersion: string | null
  /** 用户从状态栏主动请求打开安装弹窗 */
  promptRequested: boolean
  applyState: (state: UpdateState) => void
  deferPrompt: (version: string | null | undefined) => void
  requestPrompt: () => void
}

export const useUpdaterStore = create<UpdaterStoreState>((set) => ({
  state: INITIAL_UPDATE_STATE,
  deferredVersion: null,
  promptRequested: false,

  applyState: (state) =>
    set((current) => {
      // 出现新版本时，之前对旧版本的“稍后”自动失效
      const deferredVersion =
        current.deferredVersion !== null &&
        state.version !== undefined &&
        current.deferredVersion !== state.version
          ? null
          : current.deferredVersion
      return { state, deferredVersion }
    }),

  deferPrompt: (version) =>
    set({
      deferredVersion: version ?? null,
      promptRequested: false,
    }),

  requestPrompt: () => set({ promptRequested: true }),
}))

/** 是否应展示安装弹窗：已下载、可自动安装，且用户没有对同一版本选择稍后 */
export function shouldShowUpdatePrompt(store: {
  state: UpdateState
  deferredVersion: string | null
  promptRequested: boolean
}): boolean {
  if (store.state.status !== 'downloaded' || !store.state.canAutoInstall) return false
  if (store.promptRequested) return true
  if (!store.state.version) return true
  return store.state.version !== store.deferredVersion
}
