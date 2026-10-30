/**
 * 画布的读取与防抖保存。
 *
 * 状态由 `RepoMapCanvas` 持有（拖动时 60fps 变化，不能每帧进 store），
 * 这里只提供「加载」与「防抖落盘」两个动作，与 `workspace/editorTabs.ts` 保持同一套写法。
 */

import { api } from '../api'
import type { RepoMapCanvasState } from '../types/electron'
import {
  emptyCanvasState,
  sanitizeCanvasState,
} from '../utils/repoMapCanvasState'

/** 连续拖动 / 缩放只写一次盘 */
export const CANVAS_SAVE_DEBOUNCE_MS = 400

export async function loadRepoMapCanvas(workspacePath: string): Promise<RepoMapCanvasState> {
  try {
    if (typeof api.repoMapCanvasGet !== 'function') return emptyCanvasState()
    const result = await api.repoMapCanvasGet(workspacePath)
    return sanitizeCanvasState(result.state)
  } catch {
    return emptyCanvasState()
  }
}

export interface RepoMapCanvasSaver {
  /** 防抖保存：拖动结束时调用 */
  save: (state: RepoMapCanvasState) => void
  /** 立即写盘（切工作区 / 卸载 / 还原布局时） */
  flush: () => Promise<void>
  dispose: () => void
}

export function createRepoMapCanvasSaver(workspacePath: string): RepoMapCanvasSaver {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: RepoMapCanvasState | null = null
  let saving: Promise<void> = Promise.resolve()

  const write = async (state: RepoMapCanvasState): Promise<void> => {
    try {
      if (typeof api.repoMapCanvasSet !== 'function') return
      await api.repoMapCanvasSet(workspacePath, state)
    } catch {
      // 落盘失败不打断交互：下一次保存会覆盖
    }
  }

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!pending) {
      await saving
      return
    }
    const next = pending
    pending = null
    saving = saving.then(() => write(next))
    await saving
  }

  return {
    save: (state) => {
      pending = sanitizeCanvasState(state)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void flush()
      }, CANVAS_SAVE_DEBOUNCE_MS)
    },
    flush,
    dispose: () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      pending = null
    },
  }
}
