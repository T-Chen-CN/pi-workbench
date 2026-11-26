/**
 * 云端页状态（全局单例：云端只有一个会话，与工作区无关，F-27）。
 *
 * 协议帧投影与状态归并统一复用 `@pi-workbench/cloud-ui` 的 `applyCloudFrame`，
 * 保证桌面端与云端 Web 共享同一份思考流 / 工具轨迹 / 未读游标 / 工单状态机逻辑。
 */

import { create } from 'zustand'
import {
  INITIAL_CLOUD_SESSION_STATE,
  applyCloudFrame,
  type CloudSessionState,
} from '@pi-workbench/cloud-ui'
import { api } from '../api'
import { CLOUD_PROTOCOL_VERSION } from '../types/cloud'
import type {
  CloudAuthorizationRow,
  CloudAwaySummaryRow,
  CloudChatRow,
  CloudClientState,
  CloudDeviceRow,
  CloudDeviceState,
  CloudLinkView,
  CloudNotice,
  CloudTaskRow,
  CloudTraceRow,
  CloudUnitRow,
} from '../types/cloud'

interface CloudState extends CloudSessionState {
  link: CloudLinkView
  deviceState: CloudDeviceState
  clientState: CloudClientState
  linking: boolean
  error: string | null
  initialized: boolean

  init: () => Promise<void>
  refreshStatus: () => Promise<void>
  refreshWorkspaces: () => Promise<number>
  pair: (input: { baseUrl: string; code: string; deviceName?: string }) => Promise<boolean>
  unlink: () => Promise<void>
  reconnect: () => Promise<void>
  openClient: () => Promise<void>
  say: (text: string) => Promise<void>
  stopReply: () => Promise<void>
  stopTask: (taskId: string) => Promise<void>
  /** 结束工作单元（F-19a 的人工入口，脏树 / 用户放弃时用）；false = 没送到，调用方要提示 */
  closeUnit: (unitId: string) => Promise<boolean>
  answerQuestion: (taskId: string, text: string) => Promise<void>
  /** 向运行中/等待回答的工单直接发送追加指令或回复（C-03d） */
  sendTaskMessage: (taskId: string, text: string) => Promise<boolean>
  /** 上报已读游标并多端清零未读数（F-52 / C-03c） */
  markRead: () => Promise<void>
  confirmPlan: (input: {
    planText: string
    items: Array<{ deviceId: string; workspacePath: string }>
    quota: number
  }) => Promise<boolean>
  applyFrame: (frame: unknown) => void
  applyDeviceState: (state: CloudDeviceState) => void
  applyClientState: (state: CloudClientState) => void
}

let listenersAttached = false
const listenerUnsubs: Array<() => void> = []

export function disposeCloudStoreListeners(): void {
  while (listenerUnsubs.length > 0) {
    try {
      listenerUnsubs.pop()?.()
    } catch {
      // ignore
    }
  }
  listenersAttached = false
}

function messageId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function pickSessionSlice(state: CloudState): CloudSessionState {
  return {
    messages: state.messages,
    tasks: state.tasks,
    devices: state.devices,
    units: state.units,
    authorizations: state.authorizations,
    notices: state.notices,
    awaySummary: state.awaySummary,
    lastSeq: state.lastSeq,
    lastReadSeq: state.lastReadSeq,
    unreadCount: state.unreadCount,
    agentStatus: state.agentStatus,
    canStopReply: state.canStopReply,
    stoppingTaskIds: state.stoppingTaskIds,
  }
}

export const useCloudStore = create<CloudState>((set, get) => ({
  ...INITIAL_CLOUD_SESSION_STATE,
  link: { linked: false },
  deviceState: { status: 'unlinked', pending: 0 },
  clientState: { status: 'closed' },
  linking: false,
  error: null,
  initialized: false,

  init: async () => {
    if (!listenersAttached && typeof window !== 'undefined' && window.electronAPI) {
      listenersAttached = true
      listenerUnsubs.push(
        api.onCloudState((state) => get().applyDeviceState(state)),
        api.onCloudClientState((state) => get().applyClientState(state)),
        api.onCloudClientFrame((frame) => get().applyFrame(frame))
      )
    }
    await get().refreshStatus()
    // 通道已打开时不再重复 requestSnapshot()，避免切回云端页时冲掉进行中的工具轨迹与未落盘流式前缀
    if (get().link.linked && get().clientState.status !== 'open') await get().openClient()
    set({ initialized: true })
  },

  refreshStatus: async () => {
    try {
      const result = await api.cloudLinkStatus()
      if (!result.success) {
        set({ error: result.error ?? null })
        return
      }
      set({ link: result.link, deviceState: result.state, error: null })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  pair: async (input) => {
    set({ linking: true, error: null })
    try {
      const result = await api.cloudPair(input)
      if (!result.success) {
        set({ error: result.error ?? 'Pairing failed' })
        return false
      }
      set({
        link: result.link ?? { linked: true },
        deviceState: result.state ?? { status: 'connecting', pending: 0 },
      })
      await get().openClient()
      return true
    } finally {
      set({ linking: false })
    }
  },

  refreshWorkspaces: async () => {
    try {
      const result = await api.cloudRefreshWorkspaces()
      if (!result.success) {
        set({ error: result.error ?? null })
      }
      return result.workspaces?.length ?? 0
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
      return 0
    }
  },

  unlink: async () => {
    let unlinkError: string | null = null
    try {
      await api.cloudClientClose()
      await api.cloudUnlink()
    } catch (error) {
      unlinkError = error instanceof Error ? error.message : String(error)
    }
    set({
      ...INITIAL_CLOUD_SESSION_STATE,
      link: { linked: false },
      deviceState: { status: 'unlinked', pending: 0 },
      clientState: { status: 'closed' },
      error: unlinkError,
    })
  },

  reconnect: async () => {
    try {
      const result = await api.cloudReconnect()
      if (!result.success) {
        set({ error: result.error ?? 'Reconnect failed' })
        return
      }
      if (result.state) set({ deviceState: result.state })
      await get().openClient()
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  openClient: async () => {
    if (!get().link.linked) return
    try {
      const result = await api.cloudClientOpen()
      if (result.state) set({ clientState: result.state })
      if (!result.success) set({ error: result.error ?? null })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  say: async (text) => {
    const body = text.trim()
    if (!body) return
    const id = messageId()
    set((state) => ({
      awaySummary: null,
      messages: [
        ...state.messages,
        { id, role: 'user' as const, text: body, at: Date.now(), traces: [] },
      ].slice(-400),
    }))
    const result = await api.cloudClientSend({
      type: 'say',
      text: body,
      clientMessageId: id,
    })
    if (!result.success) {
      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: messageId(),
            role: 'assistant',
            text: '',
            at: Date.now(),
            traces: [],
            error: result.error ?? '消息未送达',
          },
        ],
      }))
    }
  },

  stopReply: async () => {
    await api.cloudClientSend({ type: 'stop_reply' })
  },

  stopTask: async (taskId) => {
    set((state) => ({
      stoppingTaskIds: { ...state.stoppingTaskIds, [taskId]: true },
    }))
    const result = await api.cloudClientSend({ type: 'stop_task', taskId })
    if (!result.success) {
      set((state) => {
        const next = { ...state.stoppingTaskIds }
        delete next[taskId]
        return { stoppingTaskIds: next }
      })
    }
  },

  closeUnit: async (unitId) => {
    const result = await api.cloudClientSend({ type: 'close_unit', unitId })
    if (!result.success) set({ error: result.error ?? '结束工作单元未送达' })
    return result.success
  },

  answerQuestion: async (taskId, text) => {
    const ok = await get().sendTaskMessage(taskId, text)
    if (!ok) {
      // 回退：发送普通用户消息
      await get().say(`关于工单 ${taskId}：${text}`)
    }
  },

  sendTaskMessage: async (taskId, text) => {
    const body = text.trim()
    if (!taskId || !body) return false
    const result = await api.cloudClientSend({
      type: 'task_message',
      taskId,
      text: body,
      at: Date.now(),
    })
    if (!result.success) {
      set({ error: result.error ?? '补充指令未送达' })
      return false
    }
    return true
  },

  markRead: async () => {
    const { lastSeq, unreadCount, lastReadSeq, clientState } = get()
    if (clientState.status !== 'open') return
    // 只在确实存在未读时上报：read_state 广播自身会递增 seq，按 lastSeq > lastReadSeq 触发会造成无限循环风暴
    if (unreadCount <= 0) return
    set({ unreadCount: 0, lastReadSeq: Math.max(lastReadSeq, lastSeq) })
    await api.cloudClientSend({ type: 'mark_read', seq: lastSeq, at: Date.now() })
  },

  confirmPlan: async (input) => {
    const result = await api.cloudClientSend({
      type: 'confirm_plan',
      planText: input.planText,
      items: input.items,
      quota: input.quota,
    })
    if (!result.success) {
      set({ error: result.error ?? '确认未送达' })
      return false
    }
    return true
  },

  applyFrame: (raw) => {
    const frame = raw as any
    if (!frame || typeof frame !== 'object' || frame.v !== CLOUD_PROTOCOL_VERSION) return
    if (frame.type === 'ack') {
      set((state) => ({ lastSeq: Math.max(state.lastSeq, Number(frame.seq ?? 0)) }))
      return
    }
    set((state) => {
      const applied = applyCloudFrame(pickSessionSlice(state), frame, {
        matchOptimisticUserEcho: true,
        incrementUnreadOnEvents: true,
      })
      if (frame.type === 'snapshot') {
        // 收到整份快照说明连接真的通了：清掉上一轮的失败文案，否则会永久挂在空状态里
        return { ...applied.state, error: null }
      }
      if (applied.frameError) {
        return { ...applied.state, error: applied.frameError }
      }
      return applied.state
    })
  },

  applyDeviceState: (state) => set({ deviceState: state }),
  applyClientState: (state) => set({ clientState: state }),
}))

export function selectRunningTasks(state: CloudState): CloudTaskRow[] {
  return state.tasks.filter(
    (task) =>
      task.status === 'assigned' || task.status === 'running' || task.status === 'waiting_human'
  )
}

export type {
  CloudAuthorizationRow,
  CloudAwaySummaryRow,
  CloudChatRow,
  CloudDeviceRow,
  CloudNotice,
  CloudTraceRow,
  CloudUnitRow,
}
