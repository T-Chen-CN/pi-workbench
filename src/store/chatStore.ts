import { create } from 'zustand'
import type {
  AgentImagePayload,
  AgentStreamEvent,
  AgentTracePart,
  ContextUsageInfo,
  ConversationBranchGroup,
  FileEdit,
  MessageContext,
  SessionPermission,
  SessionStatsInfo,
  StructuredPlan,
} from '../types/electron'

/** 会话级设置：模型、思考级别与权限 */
export interface SessionSettings {
  modelId?: string
  thinkingLevel?: string
  permission?: SessionPermission
}

export interface ChatUsage {
  input: number
  output: number
  /** 本轮花在思考上的输出 token（output 的子集） */
  reasoning: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}

export interface ChatMessage {
  id: string
  /** 对应 JSONL 会话记录中的持久化 entryId（用于精确分支匹配与轮末对账） */
  entryId?: string
  /** system：上下文压缩等分隔提示，不属于对话内容 */
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  /** 按发生顺序排列的文本 / 思考 / 工具片段（assistant） */
  parts?: AgentTracePart[]
  /** 内部：当前 thinking 片段的开始时间，用于计算时长 */
  thinkingStartedAt?: number
  isLoading?: boolean
  /** 正在流式接收文本增量 */
  isStreaming?: boolean
  /** 本轮模型调用的 token 用量 */
  usage?: ChatUsage
  /** 本轮 Agent 修改过的文件（用于消息内的变更卡） */
  edits?: FileEdit[]
  /** 用户消息附带的图片（R-08），发送后与历史恢复时展示 */
  images?: Array<{ data: string; mimeType: string }>
  /** 用户消息随行的引用与附件：发送时写入，历史恢复时由 bridge 从记录解析 */
  context?: MessageContext
  /** 同一用户消息下的回复分支（R-03） */
  branch?: {
    userTimestamp: number
    activeIndex: number
    entryIds: string[]
  }
}

export interface ChatAttachment {
  id: string
  kind: 'file' | 'snippet' | 'image'
  path: string
  name: string
  /** 片段起止行（1-based，含端点） */
  startLine?: number
  endLine?: number
  /** 片段附加时的内容快照；整文件只传路径，由 Agent 自己读取 */
  content?: string
  /** 图像附件：base64（不含 data: 前缀）与 MIME */
  mimeType?: string
  data?: string
  /** 文件 / 图像的字节数（用于展示与限制） */
  size?: number
  /** 文件最后修改时间（ms）；Dialog 选中的文件才有 */
  mtime?: number
  /** 文件 MIME；Dialog 选中的文件才有 */
  mime?: string
  /** 位于工作区之外（UI 上标注，并告知模型） */
  external?: boolean
  /** 引用块在 prompt 里的标题（对话引用没有文件路径时使用） */
  label?: string
}

export type NewChatAttachment = Omit<ChatAttachment, 'id'> & { id?: string }

export interface PendingMessage {
  id: string
  text: string
  /** 排队时一并转入的图片；只存在于内存，不随排队消息落盘 */
  images?: AgentImagePayload[]
  /** 排队时一并转入的文件附件（只含路径与元信息） */
  attachments?: ChatAttachment[]
}

export interface ConversationState {
  messages: ChatMessage[]
  isLoading: boolean
  /** 正在执行上下文压缩（手动或自动）；压缩期间不可中止 */
  isCompacting: boolean
  error: string | null
  attachments: ChatAttachment[]
  draftInput: string
  /** 运行中排队的待发送消息 */
  pending: PendingMessage[]
  /** 最近一次读取的上下文占用 */
  contextUsage: ContextUsageInfo | null
  /** 会话级模型与思考级别 */
  sessionSettings: SessionSettings | null
  /** 供应商自动重试状态 */
  retryStatus: {
    attempt: number
    maxAttempts: number
    delayMs: number
    message?: string
    /** 收到 retry_start 的本地时间，用于实时倒计时（R-19） */
    receivedAt?: number
  } | null
  /** 会话累计用量与成本 */
  sessionStats: SessionStatsInfo | null
  /** 下一条消息是否自动带上当前查看的文档（发送后自动复位） */
  quoteCurrentFile: boolean
}

const EMPTY_CONVERSATION: ConversationState = {
  messages: [],
  isLoading: false,
  isCompacting: false,
  error: null,
  attachments: [],
  draftInput: '',
  pending: [],
  contextUsage: null,
  sessionSettings: null,
  retryStatus: null,
  sessionStats: null,
  quoteCurrentFile: false
}

/** 会话在 store 中的键：工作区 + 会话，避免跨工作区串数据 */
export function conversationKey(workspacePath: string, sessionId: string): string {
  return `${workspacePath}\u0000${sessionId}`
}

type ToolStartEvent = Extract<AgentStreamEvent, { type: 'tool_start' }>
type ToolUpdateEvent = Extract<AgentStreamEvent, { type: 'tool_update' }>
type ToolEndEvent = Extract<AgentStreamEvent, { type: 'tool_end' }>

interface ChatState {
  conversations: Record<string, ConversationState>
  /** 欢迎页带入的草稿，等工作区会话初始化后写入激活会话 */
  pendingDraft: string
  pendingDraftWorkspace: string | null

  ensureConversation: (key: string) => void
  removeConversation: (key: string) => void
  setPendingDraft: (value: string, workspacePath?: string) => void
  clearPendingDraft: () => void
  addMessage: (key: string, message: Omit<ChatMessage, 'id' | 'timestamp'>) => string
  startStreamingMessage: (key: string) => string
  appendTextPart: (key: string, id: string, delta: string) => void
  appendThinkingPart: (
    key: string,
    id: string,
    delta: string,
    options?: { redacted?: boolean }
  ) => void
  startToolPart: (key: string, id: string, event: ToolStartEvent) => void
  updateToolPart: (key: string, id: string, event: ToolUpdateEvent) => void
  endToolPart: (key: string, id: string, event: ToolEndEvent) => void
  finishStreamingMessage: (key: string, id: string, content?: string) => void
  setMessageUsage: (key: string, id: string, usage: ChatUsage) => void
  setMessageEdits: (key: string, id: string, edits: FileEdit[]) => void
  removeMessageEdit: (key: string, id: string, path: string) => void
  addAttachment: (key: string, attachment: NewChatAttachment) => void
  removeAttachment: (key: string, id: string) => void
  /** 按 id 消费已被消息带走的附件；未提交的附件保持不变 */
  consumeAttachments: (key: string, ids: string[]) => void
  setDraftInput: (key: string, value: string) => void
  /** 引用当前查看的文档开关（只作用于下一次发送） */
  setQuoteCurrentFile: (key: string, value: boolean) => void
  addPending: (
    key: string,
    text: string,
    images?: AgentImagePayload[],
    attachments?: ChatAttachment[]
  ) => PendingMessage
  removePending: (key: string, id: string) => void
  setContextUsage: (key: string, usage: ContextUsageInfo | null) => void
  setSessionSettings: (
    key: string,
    settings: SessionSettings | null
  ) => void
  setRetryStatus: (
    key: string,
    status: {
      attempt: number
      maxAttempts: number
      delayMs: number
      message?: string
    } | null
  ) => void
  setSessionStats: (key: string, stats: SessionStatsInfo | null) => void
  removeMessage: (key: string, id: string) => void
  /** 应用回复分支分组（R-03），按用户消息时间戳匹配到其后的助手消息 */
  setMessageBranches: (key: string, groups: ConversationBranchGroup[]) => void
  /** 在指定助手消息中插入 / 更新结构化计划卡（R-04） */
  appendPlanPart: (key: string, messageId: string, plan: StructuredPlan) => void
  /**
   * 追加上下文压缩点（R-05）：挂到当前消息的末尾，位置跟随输出顺序。
   * 默认目标是正在流式输出的助手消息，其次是最后一条助手消息，
   * 都没有时新建一条只含分隔线的助手消息。
   */
  appendCompactionPart: (
    key: string,
    part: Extract<AgentTracePart, { type: 'compaction' }>,
    options?: { beforePendingTurn?: boolean }
  ) => void
  /** 按计划 id 更新所有计划卡（R-04） */
  applyPlanUpdate: (key: string, plan: StructuredPlan) => void
  /** 历史恢复时追加一份计划消息（R-04） */
  appendPlanMessage: (key: string, plan: StructuredPlan) => void
  truncateLastTurn: (key: string) => void
  setMessages: (key: string, messages: Array<Omit<ChatMessage, 'id'>>) => void
  /** 轮末以磁盘会话记录为单一真相源对账，保留仅存内存的 edits/plan 卡并稳定未变消息引用 */
  reconcileMessages: (key: string, messages: Array<Omit<ChatMessage, 'id'>>) => void
  setLoading: (key: string, loading: boolean) => void
  setCompacting: (key: string, compacting: boolean) => void
  setError: (key: string, error: string | null) => void
  reset: () => void
}

function conversation(state: ChatState, key: string): ConversationState {
  return state.conversations[key] ?? EMPTY_CONVERSATION
}

/** 只更新已存在的会话；关闭标签后迟到的流式回调不能把会话重新创建出来 */
function updateExisting(
  state: ChatState,
  key: string,
  updater: (current: ConversationState) => ConversationState
): Partial<ChatState> | ChatState {
  const current = state.conversations[key]
  if (!current) return state
  return {
    conversations: { ...state.conversations, [key]: updater(current) },
  }
}

/** 只更新指定消息；消息不存在时保持原状态 */
function updateMessage(
  state: ChatState,
  key: string,
  id: string,
  updater: (message: ChatMessage) => ChatMessage
): Partial<ChatState> | ChatState {
  return updateExisting(state, key, (current) => {
    let found = false
    const messages = current.messages.map((message) => {
      if (message.id !== id) return message
      found = true
      return updater(message)
    })
    if (!found) return current
    return { ...current, messages }
  })
}

function nextPartId(parts: AgentTracePart[], prefix: string): string {
  const ids = new Set(parts.map((part) => part.id))
  let index = 1
  while (ids.has(`${prefix}-${index}`)) index += 1
  return `${prefix}-${index}`
}

function textFromParts(parts: AgentTracePart[] | undefined): string {
  return (parts ?? [])
    .filter(
      (part): part is Extract<AgentTracePart, { type: 'text' }> => part.type === 'text'
    )
    .map((part) => part.text)
    .join('\n')
}

/** 在写入 text/tool 之前结束当前 thinking 片段并记录时长 */
function closeThinking(message: ChatMessage, now = Date.now()): ChatMessage {
  if (!message.thinkingStartedAt) return message
  const parts = message.parts ? [...message.parts] : []
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part.type !== 'thinking') continue
    if (part.durationMs === undefined) {
      parts[index] = { ...part, durationMs: Math.max(0, now - message.thinkingStartedAt) }
    }
    break
  }
  return { ...message, parts, thinkingStartedAt: undefined }
}

export const useChatStore = create<ChatState>((set) => ({
  conversations: {},
  pendingDraft: '',
  pendingDraftWorkspace: null,

  setPendingDraft: (value, workspacePath) =>
    set({ pendingDraft: value, pendingDraftWorkspace: workspacePath ?? null }),
  clearPendingDraft: () => set({ pendingDraft: '', pendingDraftWorkspace: null }),

  ensureConversation: (key) =>
    set((state) =>
      state.conversations[key]
        ? state
        : { conversations: { ...state.conversations, [key]: { ...EMPTY_CONVERSATION } } }
    ),

  removeConversation: (key) =>
    set((state) => {
      if (!state.conversations[key]) return state
      const conversations = { ...state.conversations }
      delete conversations[key]
      return { conversations }
    }),

  addMessage: (key, message) => {
    const id = `msg-${Date.now()}-${Math.random()}`
    set((state) => ({
      conversations: {
        ...state.conversations,
        [key]: {
          ...conversation(state, key),
          messages: [
            ...conversation(state, key).messages,
            {
              ...message,
              id,
              timestamp: Date.now(),
            },
          ],
        },
      },
    }))
    return id
  },

  startStreamingMessage: (key) => {
    const id = `msg-${Date.now()}-${Math.random()}`
    set((state) => ({
      conversations: {
        ...state.conversations,
        [key]: {
          ...conversation(state, key),
          messages: [
            ...conversation(state, key).messages,
            {
              id,
              role: 'assistant',
              content: '',
              parts: [],
              timestamp: Date.now(),
              isStreaming: true,
            },
          ],
        },
      },
    }))
    return id
  },

  appendTextPart: (key, id, delta) =>
    set((state) => {
      if (!delta) return state
      return updateMessage(state, key, id, (message) => {
        const existingParts = message.parts ?? []
        const last = existingParts[existingParts.length - 1]
        // 尚未进入可见正文时忽略纯空白前导增量，避免误截断思考计时或切碎过程组
        if (last?.type !== 'text' && !delta.trim()) return message
        const next = closeThinking(message)
        const parts = next.parts ? [...next.parts] : []
        const tail = parts[parts.length - 1]
        if (tail?.type === 'text') {
          parts[parts.length - 1] = { ...tail, text: tail.text + delta }
        } else {
          parts.push({ type: 'text', id: nextPartId(parts, 'text'), text: delta })
        }
        return { ...next, parts, content: next.content + delta }
      })
    }),

  appendThinkingPart: (key, id, delta, options) =>
    set((state) =>
      updateMessage(state, key, id, (message) => {
        const parts = message.parts ? [...message.parts] : []
        const last = parts[parts.length - 1]
        const redacted = options?.redacted === true
        if (last?.type === 'thinking' && !last.redacted && !redacted) {
          parts[parts.length - 1] = { ...last, text: last.text + delta }
        } else {
          parts.push({
            type: 'thinking',
            id: nextPartId(parts, 'thinking'),
            text: delta,
            redacted,
          })
        }
        return {
          ...message,
          parts,
          thinkingStartedAt: message.thinkingStartedAt ?? Date.now(),
        }
      })
    ),

  startToolPart: (key, id, event) =>
    set((state) =>
      updateMessage(state, key, id, (message) => {
        const next = closeThinking(message)
        const parts = next.parts ? [...next.parts] : []
        const part: AgentTracePart = {
          type: 'tool',
          id: event.toolCallId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          argsSummary: event.argsSummary,
          status: 'running',
          parentToolCallId: event.parentToolCallId,
        }
        const existing = parts.findIndex(
          (item) => item.type === 'tool' && item.toolCallId === event.toolCallId
        )
        if (existing >= 0) parts[existing] = part
        else parts.push(part)
        return { ...next, parts }
      })
    ),

  updateToolPart: (key, id, event) =>
    set((state) =>
      updateMessage(state, key, id, (message) => {
        if (!message.parts) return message
        const parts = message.parts.map((part) =>
          part.type === 'tool' && part.toolCallId === event.toolCallId
            ? { ...part, resultPreview: event.resultPreview ?? part.resultPreview }
            : part
        )
        return { ...message, parts }
      })
    ),

  endToolPart: (key, id, event) =>
    set((state) =>
      updateMessage(state, key, id, (message) => {
        if (!message.parts) return message
        let found = false
        const parts = message.parts.map((part) => {
          if (part.type !== 'tool' || part.toolCallId !== event.toolCallId) return part
          found = true
          return {
            ...part,
            status: event.status,
            isError: event.status === 'error',
            durationMs: event.durationMs,
            resultPreview: event.resultPreview ?? part.resultPreview,
            filePath: event.filePath ?? part.filePath,
          }
        })
        if (!found) {
          parts.push({
            type: 'tool',
            id: event.toolCallId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            argsSummary: '',
            status: event.status,
            isError: event.status === 'error',
            durationMs: event.durationMs,
            resultPreview: event.resultPreview,
            filePath: event.filePath,
            parentToolCallId: event.parentToolCallId,
          })
        }
        return { ...message, parts }
      })
    ),

  finishStreamingMessage: (key, id, content) =>
    set((state) =>
      updateMessage(state, key, id, (message) => {
        const next = closeThinking(message)
        let parts = (next.parts ?? []).map((part) =>
          part.type === 'tool' && part.status === 'running'
            ? { ...part, status: 'error' as const, isError: true }
            : part
        )
        if (parts.length === 0) {
          const text = content ?? next.content
          parts = text
            ? [{ type: 'text', id: nextPartId(parts, 'text'), text }]
            : []
        } else if (!parts.some((part) => part.type === 'text') && content) {
          parts.push({ type: 'text', id: nextPartId(parts, 'text'), text: content })
        }
        return {
          ...next,
          parts,
          content: textFromParts(parts) || next.content,
          isStreaming: false,
          thinkingStartedAt: undefined
        }
      })
    ),

  setMessageUsage: (key, id, usage) =>
    set((state) =>
      updateMessage(state, key, id, (message) => ({ ...message, usage }))
    ),

  setMessageEdits: (key, id, edits) =>
    set((state) => updateMessage(state, key, id, (message) => ({ ...message, edits }))),

  removeMessageEdit: (key, id, path) =>
    set((state) =>
      updateMessage(state, key, id, (message) => ({
        ...message,
        edits: (message.edits ?? []).filter((edit) => edit.path !== path),
      }))
    ),

  addAttachment: (key, attachment) =>
    set((state) =>
      updateExisting(state, key, (current) => {
        const id =
          attachment.id ??
          (attachment.kind === 'snippet'
            ? `snippet:${attachment.path}:${attachment.startLine}-${attachment.endLine}`
            : attachment.kind === 'image'
              ? `image:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
              : `file:${attachment.path}`)
        if (current.attachments.some((item) => item.id === id)) return current
        return {
          ...current,
          attachments: [...current.attachments, { ...attachment, id }],
        }
      })
    ),

  removeAttachment: (key, id) =>
    set((state) =>
      updateExisting(state, key, (current) => ({
        ...current,
        attachments: current.attachments.filter((item) => item.id !== id),
      }))
    ),

  consumeAttachments: (key, ids) =>
    set((state) => {
      if (ids.length === 0) return state
      return updateExisting(state, key, (current) => ({
        ...current,
        attachments: current.attachments.filter((item) => !ids.includes(item.id)),
      }))
    }),

  setDraftInput: (key, value) =>
    set((state) =>
      updateExisting(state, key, (current) => ({ ...current, draftInput: value }))
    ),

  setQuoteCurrentFile: (key, value) =>
    set((state) => updateExisting(state, key, (current) => ({ ...current, quoteCurrentFile: value }))),

  addPending: (key, text, images, attachments) => {
    const item: PendingMessage = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      ...(images && images.length > 0 ? { images } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    }
    set((state) =>
      updateExisting(state, key, (current) => ({
        ...current,
        pending: [...current.pending, item],
      }))
    )
    return item
  },

  removePending: (key, id) =>
    set((state) =>
      updateExisting(state, key, (current) => ({
        ...current,
        pending: current.pending.filter((item) => item.id !== id),
      }))
    ),

  setContextUsage: (key, usage) =>
    set((state) => updateExisting(state, key, (current) => ({ ...current, contextUsage: usage }))),

  setSessionSettings: (key, settings) =>
    set((state) =>
      updateExisting(state, key, (current) => ({ ...current, sessionSettings: settings }))
    ),

  setRetryStatus: (key, status) =>
    set((state) =>
      updateExisting(state, key, (current) => ({
        ...current,
        retryStatus: status ? { ...status, receivedAt: Date.now() } : null,
      }))
    ),

  setSessionStats: (key, stats) =>
    set((state) => updateExisting(state, key, (current) => ({ ...current, sessionStats: stats }))),

  setMessageBranches: (key, groups) =>
    set((state) =>
      updateExisting(state, key, (current) => {
        if (current.messages.length === 0) return current
        const byEntryId = new Map<string, ConversationBranchGroup>()
        const byTimestamp = new Map<number, ConversationBranchGroup>()
        for (const group of groups) {
          if (group.userEntryId) byEntryId.set(group.userEntryId, group)
          byTimestamp.set(group.userTimestamp, group)
        }
        let activeUserEntryId: string | undefined
        let userTimestamp: number | null = null
        const messages = current.messages.map((message) => {
          if (message.role === 'user') {
            activeUserEntryId = message.entryId
            userTimestamp = message.timestamp
            return message
          }
          let group =
            (activeUserEntryId ? byEntryId.get(activeUserEntryId) : undefined) ??
            (userTimestamp !== null ? byTimestamp.get(userTimestamp) : undefined)
          // 实时流式乐观用户消息在轮末对账前时间戳可能与主进程差几百毫秒，放宽 5s 就近兜底
          if (!group && userTimestamp !== null) {
            let bestDelta = 5000
            for (const candidate of groups) {
              const delta = Math.abs(candidate.userTimestamp - userTimestamp)
              if (delta <= bestDelta) {
                bestDelta = delta
                group = candidate
              }
            }
          }
          if (!group) {
            if (!message.branch) return message
            const next = { ...message }
            delete next.branch
            return next
          }
          return {
            ...message,
            branch: {
              userTimestamp: group.userTimestamp,
              activeIndex: group.activeIndex,
              entryIds: group.branches.map((option) => option.entryId),
            },
          }
        })
        return { ...current, messages }
      })
    ),

  appendPlanPart: (key, messageId, plan) =>
    set((state) =>
      updateMessage(state, key, messageId, (message) => {
        const next = closeThinking(message)
        const parts = next.parts ? [...next.parts] : []
        const existing = parts.findIndex(
          (part) => part.type === 'plan' && part.plan.id === plan.id
        )
        const planPart: AgentTracePart = {
          type: 'plan',
          id: `plan-part-${plan.id}`,
          plan,
        }
        if (existing >= 0) parts[existing] = planPart
        else parts.push(planPart)
        return { ...next, parts }
      })
    ),

  applyPlanUpdate: (key, plan) =>
    set((state) =>
      updateExisting(state, key, (current) => {
        let changed = false
        const messages = current.messages.map((message) => {
          if (!message.parts?.some((part) => part.type === 'plan' && part.plan.id === plan.id)) {
            return message
          }
          changed = true
          return {
            ...message,
            parts: message.parts.map((part) =>
              part.type === 'plan' && part.plan.id === plan.id ? { ...part, plan } : part
            ),
          }
        })
        return changed ? { ...current, messages } : current
      })
    ),

  appendPlanMessage: (key, plan) =>
    set((state) =>
      updateExisting(state, key, (current) => {
        if (
          current.messages.some((message) =>
            message.parts?.some((part) => part.type === 'plan' && part.plan.id === plan.id)
          )
        ) {
          return current
        }
        return {
          ...current,
          messages: [
            ...current.messages,
            {
              id: `msg-plan-${plan.id}`,
              role: 'assistant',
              content: '',
              timestamp: plan.createdAt,
              parts: [{ type: 'plan', id: `plan-part-${plan.id}`, plan }],
            },
          ],
        }
      })
    ),

  appendCompactionPart: (key, part, options) =>
    set((state) =>
      updateExisting(state, key, (current) => {
        if (
          part.entryId &&
          current.messages.some((msg) =>
            msg.parts?.some((p) => p.type === 'compaction' && p.entryId === part.entryId)
          )
        ) {
          return current
        }
        const messages = [...current.messages]
        // 手动压缩期间若已有新消息在末尾等待续跑，分隔线必须落在这条等待中的用户消息之前，与 JSONL 顺序一致
        let pendingTurnStart = -1
        if (options?.beforePendingTurn && messages.length >= 2) {
          const last = messages[messages.length - 1]
          const prev = messages[messages.length - 2]
          if (
            last.role === 'assistant' &&
            last.isStreaming &&
            !last.content &&
            (!last.parts || last.parts.length === 0) &&
            prev.role === 'user'
          ) {
            pendingTurnStart = messages.length - 2
          }
        }

        if (pendingTurnStart >= 0) {
          let index = -1
          for (let cursor = pendingTurnStart - 1; cursor >= 0; cursor -= 1) {
            if (messages[cursor].role === 'assistant') {
              index = cursor
              break
            }
          }
          if (index < 0) {
            messages.splice(pendingTurnStart, 0, {
              id: `msg-${Date.now()}-${Math.random()}`,
              role: 'assistant',
              content: '',
              timestamp: part.timestamp,
              parts: [part],
            })
          } else {
            const target = messages[index]
            messages[index] = { ...target, parts: [...(target.parts ?? []), part] }
          }
          return { ...current, messages }
        }

        let index = -1
        for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
          if (messages[cursor].role === 'assistant' && messages[cursor].isStreaming) {
            index = cursor
            break
          }
        }
        if (index < 0) {
          for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
            if (messages[cursor].role === 'assistant') {
              index = cursor
              break
            }
          }
        }
        if (index < 0) {
          messages.push({
            id: `msg-${Date.now()}-${Math.random()}`,
            role: 'assistant',
            content: '',
            timestamp: part.timestamp,
            parts: [part],
          })
        } else {
          const target = messages[index]
          messages[index] = { ...target, parts: [...(target.parts ?? []), part] }
        }
        return { ...current, messages }
      })
    ),

  removeMessage: (key, id) =>
    set((state) =>
      updateExisting(state, key, (current) => ({
        ...current,
        messages: current.messages.filter((message) => message.id !== id),
      }))
    ),

  /** 删除最后一条用户消息及其后的全部消息（编辑重发前调用） */
  truncateLastTurn: (key) =>
    set((state) =>
      updateExisting(state, key, (current) => {
        let lastUser = -1
        for (let index = current.messages.length - 1; index >= 0; index--) {
          if (current.messages[index].role === 'user') {
            lastUser = index
            break
          }
        }
        if (lastUser < 0) return current
        return { ...current, messages: current.messages.slice(0, lastUser) }
      })
    ),

  setMessages: (key, messages) =>
    set((state) => ({
      conversations: {
        ...state.conversations,
        [key]: {
          ...conversation(state, key),
          messages: messages.map((message, index) => {
            const parts =
              message.parts ??
              (message.role === 'assistant' && message.content
                ? [
                    {
                      type: 'text' as const,
                      id: `text-${index + 1}`,
                      text: message.content,
                    },
                  ]
                : undefined)
            return {
              ...message,
              id: message.entryId ? `entry-${message.entryId}` : `msg-${message.timestamp}-${index}`,
              parts,
              thinkingStartedAt: undefined,
            }
          }),
        },
      },
    })),

  reconcileMessages: (key, diskMessages) =>
    set((state) =>
      updateExisting(state, key, (current) => {
        if (diskMessages.length === 0) return current
        // 收集内存中仅在实时态持有的 edits / plan 卡片与原 React id，避免轮末对账丢卡或整屏闪动
        const prevByEntryId = new Map<string, ChatMessage>()
        const prevAssistants: ChatMessage[] = []
        for (const msg of current.messages) {
          if (msg.entryId) prevByEntryId.set(msg.entryId, msg)
          if (msg.role === 'assistant') prevAssistants.push(msg)
        }
        let assistantCursor = 0
        const nextMessages: ChatMessage[] = diskMessages.map((message, index) => {
          const prev =
            (message.entryId ? prevByEntryId.get(message.entryId) : undefined) ??
            (message.role === 'assistant' ? prevAssistants[assistantCursor] : current.messages[index])
          if (message.role === 'assistant') assistantCursor += 1

          const baseParts =
            message.parts ??
            (message.role === 'assistant' && message.content
              ? [{ type: 'text' as const, id: `text-${index + 1}`, text: message.content }]
              : undefined)

          // 保留仅挂在内存态的 plan 卡片（不写入 JSONL entries）
          const prevPlanParts = (prev?.parts ?? []).filter((part) => part.type === 'plan')
          let mergedParts = baseParts
          if (prevPlanParts.length > 0 && message.role === 'assistant') {
            const existingPlanIds = new Set(
              (baseParts ?? [])
                .filter((p): p is Extract<AgentTracePart, { type: 'plan' }> => p.type === 'plan')
                .map((p) => p.plan.id)
            )
            const missingPlans = prevPlanParts.filter(
              (p) => p.type === 'plan' && !existingPlanIds.has(p.plan.id)
            )
            if (missingPlans.length > 0) {
              mergedParts = [...(baseParts ?? []), ...missingPlans]
            }
          }

          return {
            ...message,
            id:
              prev?.id ??
              (message.entryId ? `entry-${message.entryId}` : `msg-${message.timestamp}-${index}`),
            parts: mergedParts,
            usage: message.usage ?? prev?.usage,
            edits: prev?.edits && prev.edits.length > 0 ? prev.edits : message.edits,
            branch: prev?.branch ?? message.branch,
            isStreaming: false,
            thinkingStartedAt: undefined,
          }
        })
        return { ...current, messages: nextMessages }
      })
    ),

  setLoading: (key, loading) =>
    set((state) =>
      updateExisting(state, key, (current) => ({ ...current, isLoading: loading }))
    ),

  setCompacting: (key, compacting) =>
    set((state) =>
      updateExisting(state, key, (current) => ({ ...current, isCompacting: compacting }))
    ),

  setError: (key, error) =>
    set((state) =>
      updateExisting(state, key, (current) => ({ ...current, error }))
    ),

  reset: () => set({ conversations: {}, pendingDraft: '', pendingDraftWorkspace: null }),
}))
