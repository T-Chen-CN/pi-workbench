/**
 * 云端页状态（全局单例：云端只有一个会话，与工作区无关，F-27）。
 *
 * 数据来自两处：主进程的配对状态（device agent）与客户端通道的帧。
 * 帧格式由 `pi-bridge/src/cloud-protocol.ts` 冻结，这里只做投影，不改协议。
 */

import { create } from 'zustand'
import { api } from '../api'
import { CLOUD_PROTOCOL_VERSION } from '../types/cloud'
import type {
  CloudAuthorizationRow,
  CloudChatRow,
  CloudClientState,
  CloudDeviceRow,
  CloudDeviceState,
  CloudLinkView,
  CloudNotice,
  CloudTaskRow,
  CloudTraceRow,
} from '../types/cloud'

interface CloudState {
  link: CloudLinkView
  deviceState: CloudDeviceState
  clientState: CloudClientState
  agentStatus: 'idle' | 'thinking' | 'replying' | 'error'
  canStopReply: boolean
  messages: CloudChatRow[]
  tasks: CloudTaskRow[]
  devices: CloudDeviceRow[]
  authorizations: CloudAuthorizationRow[]
  notices: CloudNotice[]
  /** 最近一次快照的游标：连接恢复时用于续读 */
  lastSeq: number
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
  answerQuestion: (taskId: string, text: string) => Promise<void>
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

function messageId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function toTaskRow(raw: any): CloudTaskRow | null {
  if (!raw || typeof raw !== 'object') return null
  const spec = raw.spec ?? {}
  return {
    id: String(raw.id ?? ''),
    title: String(spec.title ?? '(未命名工单)'),
    deviceId: String(spec.deviceId ?? spec.repo?.deviceId ?? ''),
    workspacePath: String(spec.repo?.workspacePath ?? ''),
    workUnitId: String(spec.workUnitId ?? ''),
    status: String(raw.status ?? 'queued') as CloudTaskRow['status'],
    createdAt: Number(raw.createdAt ?? Date.now()),
    updatedAt: Number(raw.updatedAt ?? Date.now()),
    startedAt: raw.startedAt ?? undefined,
    finishedAt: raw.finishedAt ?? undefined,
    terminalReason: raw.terminalReason ?? undefined,
    lastMilestone: raw.progress?.summary ?? undefined,
    worktreePath: raw.worktreePath ?? undefined,
    branch: raw.progress?.branch ?? undefined,
    result: raw.result
      ? {
          summary: String(raw.result.summary ?? ''),
          changedFiles: Array.isArray(raw.result.changedFiles) ? raw.result.changedFiles : [],
        }
      : undefined,
    error: raw.error ?? undefined,
  }
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id)
  if (index < 0) return [item, ...list].slice(0, 200)
  const next = list.slice()
  next[index] = item
  return next
}

export const useCloudStore = create<CloudState>((set, get) => ({
  link: { linked: false },
  deviceState: { status: 'unlinked', pending: 0 },
  clientState: { status: 'closed' },
  agentStatus: 'idle',
  canStopReply: false,
  messages: [],
  tasks: [],
  devices: [],
  authorizations: [],
  notices: [],
  lastSeq: 0,
  linking: false,
  error: null,
  initialized: false,

  init: async () => {
    if (!listenersAttached && typeof window !== 'undefined' && window.electronAPI) {
      listenersAttached = true
      api.onCloudState((state) => get().applyDeviceState(state))
      api.onCloudClientState((state) => get().applyClientState(state))
      api.onCloudClientFrame((frame) => get().applyFrame(frame))
    }
    await get().refreshStatus()
    // 重启后必须重新开通道：快照（含历史消息）只在这一步之后才来，
    // 不开就是「历史全没了」，而其实服务端一直有。
    if (get().link.linked) await get().openClient()
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
    const result = await api.cloudRefreshWorkspaces()
    if (!result.success) {
      set({ error: result.error ?? null })
    }
    return result.workspaces?.length ?? 0
  },

  unlink: async () => {
    await api.cloudClientClose()
    await api.cloudUnlink()
    set({
      link: { linked: false },
      deviceState: { status: 'unlinked', pending: 0 },
      clientState: { status: 'closed' },
      messages: [],
      tasks: [],
      devices: [],
      authorizations: [],
      notices: [],
    })
  },

  reconnect: async () => {
    const result = await api.cloudReconnect()
    if (!result.success) {
      set({ error: result.error ?? 'Reconnect failed' })
      return
    }
    if (result.state) set({ deviceState: result.state })
    await get().openClient()
  },

  openClient: async () => {
    if (!get().link.linked) return
    const result = await api.cloudClientOpen()
    if (result.state) set({ clientState: result.state })
    if (!result.success) set({ error: result.error ?? null })
  },

  say: async (text) => {
    const body = text.trim()
    if (!body) return
    const id = messageId()
    set((state) => ({
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
    await api.cloudClientSend({ type: 'stop_task', taskId })
  },

  answerQuestion: async (taskId, text) => {
    // 回答以普通用户消息进入云端会话，云端再把结论转给终端（F-23）
    await get().say(`关于工单 ${taskId}：${text}`)
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
    if (!frame || typeof frame !== 'object') return
    // 版本不符直接丢弃：宁可空着等快照，也不把未知帧当已知帧渲染
    if (frame.v !== CLOUD_PROTOCOL_VERSION) return

    if (frame.type === 'snapshot') {
      const snapshot = frame.snapshot ?? {}
      const messages: CloudChatRow[] = Array.isArray(snapshot.messages)
        ? snapshot.messages.map((message: any) => ({
            id: String(message.id ?? messageId()),
            role: message.role === 'user' ? 'user' : 'assistant',
            text: String(message.text ?? ''),
            at: Number(message.at ?? Date.now()),
            streaming: Boolean(message.streaming),
            traces: [],
            error: message.error,
          }))
        : []
      const tasks = Array.isArray(snapshot.tasks)
        ? snapshot.tasks.map(toTaskRow).filter((row: CloudTaskRow | null): row is CloudTaskRow => !!row)
        : []
      const devices: CloudDeviceRow[] = Array.isArray(snapshot.devices)
        ? snapshot.devices.map((device: any) => ({
            id: String(device.id ?? ''),
            name: String(device.name ?? device.id ?? ''),
            platform: String(device.platform ?? ''),
            online: Boolean(device.online),
            workspaces: Array.isArray(device.workspaces) ? device.workspaces : [],
            lastSeenAt: device.lastSeenAt,
          }))
        : []
      const authorizations: CloudAuthorizationRow[] = Array.isArray(snapshot.authorizations)
        ? snapshot.authorizations.map((item: any) => ({
            id: String(item.id ?? ''),
            items: Array.isArray(item.items) ? item.items : [],
            quota: Number(item.quota ?? 0),
            used: Number(item.used ?? 0),
            confirmedAt: Number(item.confirmedAt ?? 0),
            expiresAt: Number(item.expiresAt ?? 0),
            confirmedSummary: String(item.confirmedSummary ?? ''),
          }))
        : []
      set({
        messages,
        tasks,
        devices,
        authorizations,
        lastSeq: Number(frame.seq ?? snapshot.lastSeq ?? 0),
        agentStatus: snapshot.cloud?.status ?? 'idle',
        canStopReply: Boolean(snapshot.cloud?.canStopReply),
      })
      return
    }

    if (frame.type === 'event') {
      const event = frame.event ?? {}
      if (typeof frame.seq === 'number') {
        set((state) => (frame.seq > state.lastSeq ? { lastSeq: frame.seq } : {}))
      }
      switch (event.type) {
        case 'message_start': {
          const id = String(event.messageId ?? messageId())
          set((state) => {
            if (state.messages.some((row) => row.id === id)) return {}
            return {
              messages: [
                ...state.messages,
                {
                  id,
                  role: event.role === 'user' ? ('user' as const) : ('assistant' as const),
                  text: '',
                  at: Number(event.at ?? Date.now()),
                  streaming: event.role !== 'user',
                  traces: [],
                },
              ].slice(-400),
            }
          })
          return
        }
        case 'text_delta': {
          const delta = String(event.delta ?? '')
          if (!delta) return
          set((state) => {
            const messages = state.messages.slice()
            const last = messages[messages.length - 1]
            if (last && last.role === 'assistant' && last.streaming) {
              messages[messages.length - 1] = { ...last, text: last.text + delta }
            } else {
              messages.push({
                id: String(event.messageId ?? messageId()),
                role: 'assistant',
                text: delta,
                at: Date.now(),
                streaming: true,
                traces: [],
              })
            }
            return { messages: messages.slice(-400) }
          })
          return
        }
        case 'message_end': {
          set((state) => {
            const messages = state.messages.slice()
            const targetId = String(event.messageId ?? '')
            const byId = targetId ? messages.findIndex((row) => row.id === targetId) : -1
            if (byId >= 0) {
              messages[byId] = {
                ...messages[byId],
                text: String(event.text ?? messages[byId].text),
                streaming: false,
                error: event.error,
              }
              return { messages }
            }
            for (let index = messages.length - 1; index >= 0; index -= 1) {
              const row = messages[index]
              if (row.role !== 'assistant' || !row.streaming) continue
              messages[index] = {
                ...row,
                text: String(event.text ?? row.text),
                streaming: false,
                error: event.error,
              }
              break
            }
            return { messages }
          })
          return
        }
        case 'trace': {
          const trace = event.trace ?? {}
          set((state) => {
            const messages = state.messages.slice()
            const lastIndex = messages.length - 1
            const base = messages[lastIndex]
            const sameRow = Boolean(base && base.role === 'assistant')
            const row: CloudChatRow = sameRow
              ? base
              : {
                  id: messageId(),
                  role: 'assistant',
                  text: '',
                  at: Date.now(),
                  streaming: true,
                  traces: [],
                }
            const traces = row.traces.slice()
            const id = String(trace.toolCallId ?? '')
            const index = traces.findIndex((item) => item.id === id)
            if (trace.type === 'tool_start') {
              traces.push({
                id,
                toolName: String(trace.toolName ?? 'tool'),
                summary: String(trace.argsSummary ?? ''),
                status: 'running',
              })
            } else if (trace.type === 'tool_end' && index >= 0) {
              traces[index] = {
                ...traces[index],
                status: trace.status === 'error' ? 'error' : 'ok',
                summary: String(trace.resultPreview ?? traces[index].summary),
              }
            }
            const updated: CloudChatRow = { ...row, traces: traces.slice(-30) }
            if (sameRow) messages[lastIndex] = updated
            else messages.push(updated)
            return { messages: messages.slice(-400) }
          })
          return
        }
        case 'cloud_status':
          set({
            agentStatus: event.status ?? 'idle',
            canStopReply: event.status === 'thinking' || event.status === 'replying',
          })
          return
        case 'task': {
          const row = toTaskRow(event.task)
          if (row) set((state) => ({ tasks: upsertById(state.tasks, row) }))
          return
        }
        case 'device': {
          const device = event.device
          if (!device) return
          set((state) => ({
            devices: upsertById(state.devices, {
              id: String(device.id ?? ''),
              name: String(device.name ?? device.id ?? ''),
              platform: String(device.platform ?? ''),
              online: Boolean(device.online),
              workspaces: Array.isArray(device.workspaces) ? device.workspaces : [],
              lastSeenAt: device.lastSeenAt,
            }),
          }))
          return
        }
        case 'notice': {
          set((state) => ({
            notices: [
              {
                level: event.level ?? 'info',
                text: String(event.text ?? ''),
                at: Number(event.at ?? Date.now()),
                key: event.key,
              },
              ...state.notices,
            ].slice(0, 20),
          }))
          return
        }
        default:
          return
      }
    }

    if (frame.type === 'error') {
      set({ error: String(frame.message ?? 'cloud error') })
    }
    if (frame.type === 'ack') {
      set({ lastSeq: Math.max(get().lastSeq, Number(frame.seq ?? 0)) })
    }
  },

  applyDeviceState: (state) => set({ deviceState: state }),
  applyClientState: (state) => {
    if (state.status === 'open') {
      // 重连成功：先拉快照，避免增量缺口
      set({ clientState: state })
      return
    }
    set({ clientState: state })
  },
}))

/** 判断两行是不是同一个对象引用（trace 里用来决定追加还是覆盖） */

export function selectRunningTasks(state: CloudState): CloudTaskRow[] {
  return state.tasks.filter(
    (task) => task.status === 'assigned' || task.status === 'running' || task.status === 'waiting_human'
  )
}

export type { CloudChatRow, CloudTraceRow }
