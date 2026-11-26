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
  CloudAwaySummaryRow,
  CloudChangedFileRow,
  CloudChatRow,
  CloudClientState,
  CloudDeviceRow,
  CloudDeviceState,
  CloudLinkView,
  CloudNotice,
  CloudSecretHitRow,
  CloudTaskRow,
  CloudTraceRow,
  CloudUnitRow,
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
  /** 工作单元：回收状态就在这里（干净自动回收 / 脏树待手动结束） */
  units: CloudUnitRow[]
  notices: CloudNotice[]
  /** 客户端离线期间的工单汇总（F-51 / A-23） */
  awaySummary: CloudAwaySummaryRow | null
  /** 已点击停止、等待终态回执的工单 id（F-30 显示「正在停止」） */
  stoppingTaskIds: Record<string, true>
  /** 最近一次快照的游标：连接恢复时用于续读 */
  lastSeq: number
  /** 服务端持久化的已读游标与未读数（F-52 / C-03c） */
  lastReadSeq: number
  unreadCount: number
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

/** 服务端回显用户消息的 id 前缀（`u-<clientMessageId>`，见 cloud-session.echoUserMessage） */
const USER_ECHO_PREFIX = 'u-'


function messageId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function toChangedFiles(raw: unknown): CloudChangedFileRow[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item) => ({
      path: String(item.path ?? ''),
      kind: String(item.kind ?? 'modified'),
      ...(typeof item.attention === 'string' && item.attention ? { attention: item.attention } : {}),
    }))
    .filter((item) => Boolean(item.path))
}

function toSecretHits(raw: unknown): CloudSecretHitRow[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item) => ({
      path: String(item.path ?? ''),
      line: Number(item.line ?? 0),
      kind: String(item.kind ?? ''),
    }))
    .filter((item) => Boolean(item.path) && item.line > 0 && Boolean(item.kind))
}

function toTaskRow(raw: any): CloudTaskRow | null {
  if (!raw || typeof raw !== 'object') return null
  const spec = raw.spec ?? {}
  const changedFiles = toChangedFiles(raw.result?.changedFiles ?? raw.progress?.changedFiles)
  const secretHits = toSecretHits(raw.result?.secretHits ?? raw.progress?.secretHits)
  const summary = raw.result?.summary ?? (raw.status === 'done' ? raw.progress?.summary : undefined)
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
    question: raw.question && typeof raw.question.text === 'string' ? raw.question : undefined,
    worktreePath: raw.worktreePath ?? undefined,
    branch: raw.progress?.branch ?? undefined,
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(secretHits.length > 0 ? { secretHits } : {}),
    result:
      summary || changedFiles.length > 0 || secretHits.length > 0
        ? {
            summary: String(summary ?? ''),
            changedFiles,
            ...(secretHits.length > 0 ? { secretHits } : {}),
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

function upsertUnit(list: CloudUnitRow[], unit: CloudUnitRow): CloudUnitRow[] {
  const index = list.findIndex((entry) => entry.unitId === unit.unitId)
  if (index < 0) return [unit, ...list].slice(0, 200)
  const next = list.slice()
  next[index] = unit
  return next
}

function toUnitRow(raw: any): CloudUnitRow | null {
  if (!raw || typeof raw !== 'object') return null
  const unitId = String(raw.unitId ?? '')
  if (!unitId) return null
  return {
    unitId,
    deviceId: String(raw.deviceId ?? ''),
    workspacePath: String(raw.workspacePath ?? ''),
    worktreePath: raw.worktreePath ?? undefined,
    branch: raw.branch ?? undefined,
    createdAt: Number(raw.createdAt ?? Date.now()),
    closedAt: typeof raw.closedAt === 'number' ? raw.closedAt : null,
    closeRequestedAt: raw.closeRequestedAt ?? undefined,
    dirtyAt: raw.dirtyAt ?? undefined,
  }
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
  units: [],
  notices: [],
  awaySummary: null,
  stoppingTaskIds: {},
  lastSeq: 0,
  lastReadSeq: 0,
  unreadCount: 0,
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
    try {
      await api.cloudClientClose()
      await api.cloudUnlink()
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
    set({
      link: { linked: false },
      deviceState: { status: 'unlinked', pending: 0 },
      clientState: { status: 'closed' },
      messages: [],
      tasks: [],
      devices: [],
      authorizations: [],
      units: [],
      notices: [],
      lastSeq: 0,
      agentStatus: 'idle',
      canStopReply: false,
      error: null,
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
    if (unreadCount === 0 && lastSeq <= lastReadSeq) return
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
      const units: CloudUnitRow[] = Array.isArray(snapshot.units)
        ? snapshot.units
            .map(toUnitRow)
            .filter((row: CloudUnitRow | null): row is CloudUnitRow => !!row)
        : []
      const awaySummary: CloudAwaySummaryRow | null =
        snapshot.awaySummary && typeof snapshot.awaySummary.text === 'string'
          ? {
              since: Number(snapshot.awaySummary.since ?? 0),
              until: Number(snapshot.awaySummary.until ?? 0),
              text: String(snapshot.awaySummary.text),
              items: Array.isArray(snapshot.awaySummary.items) ? snapshot.awaySummary.items : [],
            }
          : null
      set({
        messages,
        tasks,
        devices,
        authorizations,
        units,
        awaySummary,
        stoppingTaskIds: {},
        lastSeq: Number(frame.seq ?? snapshot.lastSeq ?? 0),
        lastReadSeq: Number(snapshot.lastReadSeq ?? 0),
        unreadCount: Number(snapshot.unreadCount ?? 0),
        agentStatus: snapshot.cloud?.status ?? 'idle',
        canStopReply: Boolean(snapshot.cloud?.canStopReply),
        // 收到整份快照说明连接真的通了：清掉上一轮的失败文案，否则会永久挂在空状态里
        error: null,
      })
      return
    }

    if (frame.type === 'event') {
      const event = frame.event ?? {}
      const seqPatch = (state: CloudState): Partial<CloudState> =>
        typeof frame.seq === 'number' && frame.seq > state.lastSeq ? { lastSeq: frame.seq } : {}
      switch (event.type) {
        case 'message_start': {
          const id = String(event.messageId ?? messageId())
          const isUser = event.role === 'user'
          set((state) => {
            const seq = seqPatch(state)
            if (state.messages.some((row) => row.id === id)) return seq
            // 服务端回显的用户消息 id 是 `u-<clientMessageId>`，而本端已经乐观追加过一条
            // 以 clientMessageId 为 id 的气泡；这里把本地那条的 id 改成服务端 id，
            // 否则同一个句子会出现两个气泡（后续 message_end / 编辑也找不到它）
            if (isUser && id.startsWith(USER_ECHO_PREFIX)) {
              const localId = id.slice(USER_ECHO_PREFIX.length)
              const index = state.messages.findIndex((row) => row.id === localId)
              if (index >= 0) {
                const messages = state.messages.slice()
                messages[index] = { ...messages[index], id }
                return { ...seq, messages }
              }
            }
            return {
              ...seq,
              messages: [
                ...state.messages,
                {
                  id,
                  role: isUser ? ('user' as const) : ('assistant' as const),
                  text: '',
                  at: Number(event.at ?? Date.now()),
                  streaming: !isUser,
                  traces: [],
                },
              ].slice(-400),
            }
          })
          return
        }
        case 'text_delta': {
          const delta = String(event.delta ?? '')
          if (!delta) {
            if (typeof frame.seq === 'number') {
              set((state) => seqPatch(state))
            }
            return
          }
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
            return { ...seqPatch(state), messages: messages.slice(-400) }
          })
          return
        }
        case 'message_end': {
          set((state) => {
            const messages = state.messages.slice()
            const targetId = String(event.messageId ?? '')
            const isAssistantUnread =
              !targetId.startsWith(USER_ECHO_PREFIX) && String(event.text ?? '').trim().length > 0
            const nextUnread = isAssistantUnread ? state.unreadCount + 1 : state.unreadCount
            const byId = targetId ? messages.findIndex((row) => row.id === targetId) : -1
            if (byId >= 0) {
              messages[byId] = {
                ...messages[byId],
                text: String(event.text ?? messages[byId].text),
                streaming: false,
                error: event.error,
              }
              return { ...seqPatch(state), messages, unreadCount: nextUnread }
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
            return { ...seqPatch(state), messages, unreadCount: nextUnread }
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
            return { ...seqPatch(state), messages: messages.slice(-400) }
          })
          return
        }
        case 'cloud_status':
          set((state) => ({
            ...seqPatch(state),
            agentStatus: event.status ?? 'idle',
            canStopReply: event.status === 'thinking' || event.status === 'replying',
          }))
          return
        case 'task': {
          const row = toTaskRow(event.task)
          set((state) => {
            if (!row) return seqPatch(state)
            const active =
              row.status === 'queued' ||
              row.status === 'assigned' ||
              row.status === 'running' ||
              row.status === 'waiting_human'
            let stoppingTaskIds = state.stoppingTaskIds
            if (!active && stoppingTaskIds[row.id]) {
              stoppingTaskIds = { ...stoppingTaskIds }
              delete stoppingTaskIds[row.id]
            }
            return {
              ...seqPatch(state),
              tasks: upsertById(state.tasks, row),
              stoppingTaskIds,
            }
          })
          return
        }
        case 'device': {
          const device = event.device
          if (!device) {
            if (typeof frame.seq === 'number') set((state) => seqPatch(state))
            return
          }
          set((state) => ({
            ...seqPatch(state),
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
        case 'unit': {
          const row = toUnitRow(event.unit)
          set((state) => ({
            ...seqPatch(state),
            ...(row ? { units: upsertUnit(state.units, row) } : {}),
          }))
          return
        }
        case 'notice': {
          set((state) => ({
            ...seqPatch(state),
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
        case 'read_state': {
          set((state) => ({
            ...seqPatch(state),
            lastReadSeq: Number(event.lastReadSeq ?? state.lastReadSeq),
            unreadCount: Number(event.unreadCount ?? 0),
          }))
          return
        }
        default:
          if (typeof frame.seq === 'number') set((state) => seqPatch(state))
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
  applyClientState: (state) => set({ clientState: state }),
}))

/** 判断两行是不是同一个对象引用（trace 里用来决定追加还是覆盖） */

export function selectRunningTasks(state: CloudState): CloudTaskRow[] {
  return state.tasks.filter(
    (task) => task.status === 'assigned' || task.status === 'running' || task.status === 'waiting_human'
  )
}

export type { CloudChatRow, CloudTraceRow }
