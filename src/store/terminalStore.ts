/**
 * 终端会话状态：PTY 句柄与输出回放缓冲不跟随组件生命周期。
 *
 * 面板被拆到独立窗口时，xterm 实例一定会在另一个 document 里重建；如果 PTY 和
 * 滚动内容也随组件销毁，拆一次窗就等于重启一次 shell。所以 id、状态与尾部输出
 * 由 store 持有，面板只负责「挂上 xterm、回放缓冲、转发按键」。
 *
 * 回放缓冲是 ANSI 原样字节流，只用尾部 REPLAY_LIMIT_BYTES：足够覆盖一屏多的历史，
 * 又不会把长跑命令的整段输出留在内存里。
 */

import { create } from 'zustand'
import { api } from '../api'
import { localizeError } from '../i18n/errors'
import { useI18nStore } from './i18nStore'

export type TerminalStatus = 'idle' | 'starting' | 'ready' | 'error'

const REPLAY_LIMIT_BYTES = 200_000

export interface TerminalEntry {
  /** PTY id；创建中为 null */
  id: string | null
  cwd: string | null
  status: TerminalStatus
  error: string | null
  shellName: string
  logPath: string | null
  /** ANSI 原样分片，保留尾部 */
  buffer: string[]
  bufferBytes: number
}

interface TerminalStoreState {
  byWorkspace: Record<string, TerminalEntry>
  /** 面板可见时调用：没有 PTY 就建一个，cwd 变了就换一个 */
  ensure: (workspacePath: string, cwd: string | null, cols: number, rows: number) => void
  restart: (workspacePath: string, cwd: string | null, cols: number, rows: number) => void
  /** 工作区关闭 / 应用退出：关 PTY 并丢弃缓冲 */
  close: (workspacePath: string) => void
  reset: () => void
}

const listeners = new Map<string, Set<(chunk: string) => void>>()
/** terminalId → workspacePath，事件只带 id */
const owners = new Map<string, string>()
/** 创建中的工作区，避免可见性抖动时重复建 PTY */
const pending = new Set<string>()
let bridgeOff: (() => void) | null = null

function emptyEntry(cwd: string | null): TerminalEntry {
  return {
    id: null,
    cwd,
    status: 'idle',
    error: null,
    shellName: '',
    logPath: null,
    buffer: [],
    bufferBytes: 0
  }
}

function emit(workspacePath: string, chunk: string): void {
  const set = listeners.get(workspacePath)
  if (!set) return
  for (const listener of set) listener(chunk)
}

function appendChunk(workspacePath: string, chunk: string): void {
  useTerminalStore.setState((state) => {
    const entry = state.byWorkspace[workspacePath]
    if (!entry) return state
    const buffer = [...entry.buffer, chunk]
    let bufferBytes = entry.bufferBytes + chunk.length
    while (bufferBytes > REPLAY_LIMIT_BYTES && buffer.length > 1) {
      bufferBytes -= buffer[0].length
      buffer.shift()
    }
    return {
      byWorkspace: { ...state.byWorkspace, [workspacePath]: { ...entry, buffer, bufferBytes } }
    }
  })
}

function ensureBridge(): void {
  if (bridgeOff) return
  const offData = api.onTerminalData(({ id, data }) => {
    const workspacePath = owners.get(id)
    if (!workspacePath) return
    appendChunk(workspacePath, data)
    emit(workspacePath, data)
  })
  const offExit = api.onTerminalExit(({ id, exitCode }) => {
    const workspacePath = owners.get(id)
    if (!workspacePath) return
    owners.delete(id)
    const { t } = useI18nStore.getState()
    const message = t('processExited', { code: exitCode })
    const chunk = `\r\n[${message}]\r\n`
    useTerminalStore.setState((state) => {
      const entry = state.byWorkspace[workspacePath]
      if (!entry || entry.id !== id) return state
      return {
        byWorkspace: {
          ...state.byWorkspace,
          [workspacePath]: { ...entry, status: 'error', error: message }
        }
      }
    })
    appendChunk(workspacePath, chunk)
    emit(workspacePath, chunk)
  })
  bridgeOff = () => {
    offData()
    offExit()
    bridgeOff = null
  }
}

function patch(workspacePath: string, next: Partial<TerminalEntry>): void {
  useTerminalStore.setState((state) => {
    const entry = state.byWorkspace[workspacePath]
    if (!entry) return state
    return { byWorkspace: { ...state.byWorkspace, [workspacePath]: { ...entry, ...next } } }
  })
}

async function spawn(workspacePath: string, cwd: string | null, cols: number, rows: number): Promise<void> {
  if (pending.has(workspacePath)) return
  pending.add(workspacePath)
  ensureBridge()
  patch(workspacePath, { status: 'starting', error: null, buffer: [], bufferBytes: 0 })

  const result = cwd
    ? await api.terminalCreate(workspacePath, cols, rows, cwd)
    : await api.terminalCreate(workspacePath, cols, rows)
  pending.delete(workspacePath)

  if (result.success && result.id) {
    owners.set(result.id, workspacePath)
    patch(workspacePath, {
      id: result.id,
      cwd,
      status: 'ready',
      shellName: result.shell ?? '',
      logPath: result.logPath ?? null,
      error: null
    })
    return
  }
  const message = result.error ? localizeError(result.error) : useI18nStore.getState().t('terminalCreateFailed')
  patch(workspacePath, { id: null, status: 'error', error: message })
  appendChunk(workspacePath, `\r\n${message}\r\n`)
  emit(workspacePath, `\r\n${message}\r\n`)
}

export const useTerminalStore = create<TerminalStoreState>((set, get) => ({
  byWorkspace: {},

  ensure: (workspacePath, cwd, cols, rows) => {
    const entry = get().byWorkspace[workspacePath]
    if (!entry) {
      set((state) => ({
        byWorkspace: { ...state.byWorkspace, [workspacePath]: emptyEntry(cwd) }
      }))
      void spawn(workspacePath, cwd, cols, rows)
      return
    }
    // 换工作树/会话导致 cwd 变化：与原来的 key 重挂一致，重开一个 shell
    if (entry.cwd !== cwd && entry.status !== 'starting') {
      get().restart(workspacePath, cwd, cols, rows)
      return
    }
    if (entry.status === 'idle') void spawn(workspacePath, cwd, cols, rows)
  },

  restart: (workspacePath, cwd, cols, rows) => {
    const entry = get().byWorkspace[workspacePath]
    const previousId = entry?.id ?? null
    if (previousId) {
      owners.delete(previousId)
      void api.terminalClose(previousId)
    }
    if (!entry) {
      set((state) => ({
        byWorkspace: { ...state.byWorkspace, [workspacePath]: emptyEntry(cwd) }
      }))
    } else {
      patch(workspacePath, {
        id: null,
        cwd,
        status: 'idle',
        error: null,
        shellName: '',
        logPath: null,
        buffer: [],
        bufferBytes: 0
      })
    }
    void spawn(workspacePath, cwd, cols, rows)
  },

  close: (workspacePath) => {
    const entry = get().byWorkspace[workspacePath]
    if (!entry) return
    if (entry.id) {
      owners.delete(entry.id)
      void api.terminalClose(entry.id)
    }
    listeners.delete(workspacePath)
    set((state) => {
      const byWorkspace = { ...state.byWorkspace }
      delete byWorkspace[workspacePath]
      return { byWorkspace }
    })
  },

  reset: () => {
    for (const entry of Object.values(get().byWorkspace)) {
      if (entry.id) {
        owners.delete(entry.id)
        void api.terminalClose(entry.id)
      }
    }
    pending.clear()
    listeners.clear()
    bridgeOff?.()
    set({ byWorkspace: {} })
  }
}))

/** 订阅某个工作区的实时输出（面板独享，回放用 store 里的缓冲） */
export function subscribeTerminalData(workspacePath: string, listener: (chunk: string) => void): () => void {
  const set = listeners.get(workspacePath) ?? new Set()
  set.add(listener)
  listeners.set(workspacePath, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(workspacePath)
  }
}

/** 回放缓冲（拼接后的 ANSI 原文） */
export function terminalReplay(workspacePath: string): string {
  const entry = useTerminalStore.getState().byWorkspace[workspacePath]
  return entry ? entry.buffer.join('') : ''
}

/** 当前 PTY id（快捷方法，避免面板订阅整个 entry） */
export function terminalId(workspacePath: string): string | null {
  return useTerminalStore.getState().byWorkspace[workspacePath]?.id ?? null
}
