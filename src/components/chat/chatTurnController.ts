/**
 * 纯 TypeScript 聊天轮次控制器（零 React 依赖）：
 * 封装消息负载构建、斜杠命令解析、排队/插话（steer）、重试、编辑重发、
 * 分支切换、工具审批与结构化计划响应、以及工作树轮次边界切换编排。
 */

import { piAgentAPI } from '../../api/piAgentAPI'
import { buildContextPrompt, CONTEXT_BLOCK_START, type ContextEntry } from '../../api/chatContext'
import {
  conversationKey,
  useChatStore,
  type ChatAttachment,
  type ChatMessage,
  type PendingMessage,
} from '../../store/chatStore'
import { useSessionStore } from '../../store/sessionStore'
import { useApprovalStore } from '../../store/approvalStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useGitStore } from '../../store/gitStore'
import { editorStoreFor } from '../../store/editorStore'
import { toast } from '../../store/toastStore'
import { confirmDialog, promptDialog } from '../../store/dialogStore'
import { localizeError } from '../../i18n/errors'
import type { TranslationKey, TranslationParams } from '../../i18n/translations'
import { createTraceBuffer } from '../../utils/streamBuffer'
import { MAX_TOTAL_IMAGE_BASE64_CHARS } from '../../utils/imageAttachment'
import { emitAppEvent } from '../../utils/appEvents'
import {
  MAX_CONTEXT_SNIPPET_CHARS,
  MAX_CONTEXT_TOTAL_CHARS,
} from '../../utils/chatPanelShared'
import {
  attachmentsToContextEntries,
  attachmentsToMessageContext,
  contextToAttachments,
} from '../../workspace/chatAttachments'
import {
  clearBudgetWarned,
  clearForceSend,
  clearTurnStopped,
  getChatSubmitHandler,
  isForceSend,
  isTurnStopped,
  markForceSend,
  markTurnStopped,
  type ChatSubmitOptions,
} from '../../workspace/chatTurnControl'
import type {
  AgentImagePayload,
  ApprovalDecision,
  MessageContext,
  PromptTemplateInfo,
  SessionMode,
  SessionPermission,
  SkillInfo,
  StructuredPlan,
} from '../../types/electron'
import type { OpenFile } from '../../types'

export type ChatTranslate = (key: TranslationKey, params?: TranslationParams) => string

export type BuiltInSlashKind = 'help' | 'plan' | 'act' | 'compact' | 'clear' | 'model' | 'custom'

export interface ParsedSlashCommand {
  command: string
  argument: string
  kind: BuiltInSlashKind
}

const BUILTIN_SLASH_MAP: Record<string, BuiltInSlashKind> = {
  '/help': 'help',
  '/plan': 'plan',
  '/act': 'act',
  '/compact': 'compact',
  '/clear': 'clear',
  '/model': 'model',
}

/** 解析斜杠命令：非 `/` 开头返回 null */
export function parseSlashCommand(inputValue: string): ParsedSlashCommand | null {
  const trimmed = inputValue.trim()
  if (!trimmed.startsWith('/')) return null
  const [rawCommand, ...rest] = trimmed.split(/\s+/)
  const command = rawCommand.toLowerCase()
  const argument = rest.join(' ').trim()
  return {
    command,
    argument,
    kind: BUILTIN_SLASH_MAP[command] ?? 'custom',
  }
}

export interface FilterContextAttachmentsCallbacks {
  onSnippetTooLarge?: (name: string) => void
  onTotalTooLarge?: () => void
}

/**
 * 过滤上下文片段附件（守住单段与总字符上限）：
 * 过滤必须在发送前完成，使气泡回显与真正发给模型的 prompt 共享同一份快照。
 */
export function filterContextAttachments(
  attachments: readonly ChatAttachment[],
  callbacks?: FilterContextAttachmentsCallbacks
): ChatAttachment[] {
  let snippetChars = 0
  return attachments.filter((attachment) => {
    if (attachment.kind !== 'snippet') return true
    const content = attachment.content ?? ''
    if (!content) return false
    if (content.length > MAX_CONTEXT_SNIPPET_CHARS) {
      callbacks?.onSnippetTooLarge?.(attachment.name)
      return false
    }
    if (snippetChars + content.length > MAX_CONTEXT_TOTAL_CHARS) {
      callbacks?.onTotalTooLarge?.()
      return false
    }
    snippetChars += content.length
    return true
  })
}

export interface BuildTurnPayloadInput {
  userMessage: string
  acceptedAttachments: readonly ChatAttachment[]
  quoteFile: Pick<OpenFile, 'path' | 'name'> | null
  promptImages: AgentImagePayload[]
  attachmentOnlyText?: (count: number) => string
}

export interface BuiltTurnPayload {
  prompt: string
  promptImages: AgentImagePayload[]
  messageContext: MessageContext | undefined
  displayContent: string
  attachmentCount: number
}

/** 构建单轮请求的最终 prompt 与用户气泡回显内容（纯函数，无副作用） */
export function buildTurnPayload(input: BuildTurnPayloadInput): BuiltTurnPayload {
  const { userMessage, acceptedAttachments, quoteFile, promptImages, attachmentOnlyText } = input
  const attachmentCount = acceptedAttachments.filter(
    (attachment) => attachment.kind !== 'image'
  ).length
  const messageContext = attachmentsToMessageContext(
    [...acceptedAttachments],
    quoteFile ? [{ path: quoteFile.path, name: quoteFile.name }] : []
  )
  const displayContent =
    userMessage ||
    (messageContext
      ? ''
      : attachmentCount > 0 && attachmentOnlyText
        ? attachmentOnlyText(attachmentCount)
        : '')

  const contextEntries: ContextEntry[] = attachmentsToContextEntries([...acceptedAttachments])
  // 「引用当前文档」只交路径，不受片段截断限制，由 Agent 按需读取
  if (quoteFile) {
    contextEntries.push({
      kind: 'file',
      path: quoteFile.path,
      name: quoteFile.name,
    })
  }
  // 重试 / 编辑重发已带上下文块时不得重复包裹
  const prompt = userMessage.includes(CONTEXT_BLOCK_START)
    ? userMessage
    : buildContextPrompt(userMessage, contextEntries)

  return {
    prompt,
    promptImages,
    messageContext,
    displayContent,
    attachmentCount,
  }
}

export interface BuiltSteerPayload {
  text: string
  images: AgentImagePayload[] | undefined
  context: MessageContext | undefined
}

/** 构建运行中插话（steer）的 prompt 与消息上下文 */
export function buildSteerPayload(item: PendingMessage): BuiltSteerPayload {
  const steerEntries = item.attachments ? attachmentsToContextEntries(item.attachments) : []
  const text = steerEntries.length > 0 ? buildContextPrompt(item.text, steerEntries) : item.text
  const context = item.attachments ? attachmentsToMessageContext(item.attachments) : undefined
  return {
    text,
    images: item.images && item.images.length > 0 ? item.images : undefined,
    context,
  }
}

/**
 * 截断类错误用结构化字段 + i18n 生成文案；其余错误走 localizeError。
 * 不在此给出「降低思考强度」之类的建议——思考强度是用户的选择。
 */
export function describeAgentFailure(
  result: {
    error?: string
    errorCode?: 'output-truncated' | 'empty-response'
    outputLimit?: number
    usage?: { output: number; reasoning: number }
  },
  translate: ChatTranslate
): string {
  if (result.errorCode) {
    const limit = (result.outputLimit ?? 0).toLocaleString()
    if (result.errorCode === 'empty-response') {
      return translate('agentEmptyResponse', { limit })
    }
    const output = result.usage?.output ?? 0
    const reasoning = result.usage?.reasoning ?? 0
    const body = Math.max(0, output - reasoning)
    return translate('agentOutputTruncated', {
      reasoning: reasoning.toLocaleString(),
      body: body.toLocaleString(),
      limit,
    })
  }
  return result.error ? localizeError(result.error) : translate('agentResponseFailed')
}

export function buildPlanExecutionPrompt(
  plan: StructuredPlan,
  translate: ChatTranslate
): string {
  const steps = plan.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n')
  return translate('planExecutePrompt', { steps })
}

export type ChatTurnAgentAPI = Pick<
  typeof piAgentAPI,
  | 'chat'
  | 'abort'
  | 'steer'
  | 'sessionsOpen'
  | 'getContextUsage'
  | 'listPromptResources'
  | 'rewindLastUser'
  | 'switchBranch'
  | 'respondApproval'
  | 'approvePlan'
  | 'rejectPlan'
>

export interface ChatTurnControllerDeps {
  workspacePath: string
  getEditorRoot: () => string
  getActiveSessionId: () => string | null
  getAvailableModels: () => string[]
  getImagesAllowed: () => boolean
  getImageProcessingCount: () => number
  getPromptResources: () => { templates: PromptTemplateInfo[]; skills: SkillInfo[] }
  setPromptResources: (next: { templates: PromptTemplateInfo[]; skills: SkillInfo[] }) => void
  getLatestProposedPlan: () => { plan: StructuredPlan; messageId: string } | null
  translate: ChatTranslate
  agentAPI?: ChatTurnAgentAPI
  chatStore?: () => ReturnType<typeof useChatStore.getState>
  sessionStore?: () => ReturnType<typeof useSessionStore.getState>
  approvalStore?: () => ReturnType<typeof useApprovalStore.getState>
  settingsStore?: () => ReturnType<typeof useSettingsStore.getState>
  workspaceStore?: () => ReturnType<typeof useWorkspaceStore.getState>
  gitStore?: () => ReturnType<typeof useGitStore.getState>
  getCurrentEditorFile?: () => OpenFile | null
  notify?: {
    info: (message: string) => void
    error: (message: string) => void
  }
  dialogs?: {
    confirm: typeof confirmDialog
    prompt: typeof promptDialog
  }
  emitEvent?: typeof emitAppEvent
  scheduleTimer?: (fn: () => void, ms: number) => unknown
  onScrollToBottom?: () => void
  onStickToBottom?: () => void
  onFocusInput?: () => void
  onHideAttachMenu?: () => void
  onStoppingChange?: (stopping: boolean) => void
  onSessionModeChange?: (mode: SessionMode) => void
  onApplySessionPermission?: (next: SessionPermission) => Promise<boolean>
  onCompact?: () => Promise<void>
  onNewSession?: () => Promise<void>
  onModelChange?: (modelId: string) => Promise<void>
  onRefreshSessions?: () => Promise<void>
  onRefreshBranches?: (sessionId: string) => Promise<void>
  onRefreshContextUsage?: (sessionId: string) => Promise<void>
  onRefreshSessionSettings?: (sessionId: string) => Promise<void>
  onRefreshSessionStats?: (sessionId: string) => Promise<void>
  getQueuedSubmitHandler?: () =>
    | ((override?: string, options?: ChatSubmitOptions) => Promise<void>)
    | undefined
}

export interface ChatTurnController {
  handleSlashCommand: (inputValue: string) => Promise<boolean>
  sendSteer: (sessionId: string, key: string, item: PendingMessage) => Promise<boolean>
  submitTurn: (override?: string, options?: ChatSubmitOptions) => Promise<void>
  stopTurn: () => Promise<void>
  retryMessage: (message: ChatMessage) => Promise<void>
  editMessage: (message: ChatMessage) => Promise<void>
  switchBranch: (entryId: string) => Promise<void>
  respondApproval: (requestId: string, decision: ApprovalDecision) => Promise<void>
  approvePlan: (plan: StructuredPlan, targetMode: 'ask' | 'auto') => Promise<void>
  rejectPlan: (plan: StructuredPlan) => Promise<void>
  executePlan: (targetMode: 'ask' | 'auto') => Promise<void>
  requestWorktreeSwitch: (
    target: string,
    base?: string
  ) => Promise<{ success: boolean; scheduled?: boolean; error?: string }>
}

export function createChatTurnController(deps: ChatTurnControllerDeps): ChatTurnController {
  const { workspacePath } = deps
  const agentAPI = deps.agentAPI ?? piAgentAPI
  const chatStore = deps.chatStore ?? (() => useChatStore.getState())
  const sessionStore = deps.sessionStore ?? (() => useSessionStore.getState())
  const approvalStore = deps.approvalStore ?? (() => useApprovalStore.getState())
  const settingsStore = deps.settingsStore ?? (() => useSettingsStore.getState())
  const workspaceStore = deps.workspaceStore ?? (() => useWorkspaceStore.getState())
  const gitStore = deps.gitStore ?? (() => useGitStore.getState())
  const getCurrentEditorFile =
    deps.getCurrentEditorFile ?? (() => editorStoreFor(deps.getEditorRoot()).getState().currentFile)
  const notify = deps.notify ?? { info: toast.info, error: toast.error }
  const dialogs = deps.dialogs ?? { confirm: confirmDialog, prompt: promptDialog }
  const emitEvent = deps.emitEvent ?? emitAppEvent
  const scheduleTimer = deps.scheduleTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms))

  let stoppingInFlight = false
  /** 记录已在运行中排队的轮次边界工作树切换，供本轮结束后主动同步工作树视图 */
  const scheduledWorktreeSessions = new Set<string>()

  const isWorkspaceStillOpen = (): boolean => {
    const openWorkspaces = workspaceStore().openWorkspaces
    return openWorkspaces.length === 0 || openWorkspaces.includes(workspacePath)
  }

  const handleSlashCommand = async (inputValue: string): Promise<boolean> => {
    const parsed = parseSlashCommand(inputValue)
    if (!parsed) return false
    const { command, argument, kind } = parsed
    const activeSessionId = deps.getActiveSessionId()
    const activeKey = activeSessionId ? conversationKey(workspacePath, activeSessionId) : null

    switch (kind) {
      case 'help':
        notify.info(deps.translate('slashHelp'))
        return true
      case 'plan':
        deps.onSessionModeChange?.('plan')
        return true
      case 'act':
        deps.onSessionModeChange?.('ask')
        return true
      case 'compact':
        await deps.onCompact?.()
        return true
      case 'clear':
        if (await dialogs.confirm({ message: deps.translate('slashClearConfirm'), danger: true })) {
          await deps.onNewSession?.()
        }
        return true
      case 'model': {
        if (!argument) {
          const model =
            (activeKey ? chatStore().conversations[activeKey]?.sessionSettings?.modelId : null) ??
            '—'
          notify.info(deps.translate('slashCurrentModel', { model }))
          return true
        }
        const match = deps
          .getAvailableModels()
          .find((model) => model.toLowerCase() === argument.toLowerCase())
        if (!match) {
          notify.error(deps.translate('slashUnknownModel', { model: argument }))
          return true
        }
        await deps.onModelChange?.(match)
        return true
      }
      case 'custom': {
        // 提示模板 / 技能交给 Pi SDK 展开（仍走现有审批）
        let resources = deps.getPromptResources()
        if (
          resources.templates.length === 0 &&
          resources.skills.length === 0 &&
          activeSessionId
        ) {
          const fetched = await agentAPI.listPromptResources(workspacePath, activeSessionId)
          if (fetched.success) {
            resources = {
              templates: fetched.templates ?? [],
              skills: fetched.skills ?? [],
            }
            deps.setPromptResources(resources)
          }
        }
        const name = command.slice(1)
        if (
          resources.templates.some(
            (template) => template.name.toLowerCase() === name.toLowerCase()
          )
        ) {
          return false
        }
        if (command.startsWith('/skill:')) {
          const skillName = command.slice('/skill:'.length).toLowerCase()
          if (resources.skills.some((skill) => skill.name.toLowerCase() === skillName)) {
            return false
          }
        }
        notify.error(deps.translate('slashUnknownCommand', { command }))
        return true
      }
    }
  }

  const sendSteer = async (
    sessionId: string,
    key: string,
    item: PendingMessage
  ): Promise<boolean> => {
    if (chatStore().conversations[key]?.isCompacting) return false
    const steer = buildSteerPayload(item)
    const result = await agentAPI.steer(workspacePath, sessionId, steer.text, item.images)
    const chat = chatStore()
    if (result.success) {
      chat.removePending(key, item.id)
      chat.addMessage(key, {
        role: 'user',
        content: item.text,
        images: steer.images,
        ...(steer.context ? { context: steer.context } : {}),
      })
      // 插话会写入一条用户消息，属主动发送：无条件回到最新位置
      deps.onScrollToBottom?.()
      notify.info(deps.translate('steerSent'))
      return true
    }
    notify.error(deps.translate('steerFailed', { error: localizeError(result.error ?? '') }))
    return false
  }

  const submitTurn = async (override?: string, options?: ChatSubmitOptions): Promise<void> => {
    const sessionId = options?.targetSessionId ?? deps.getActiveSessionId()
    const key = sessionId ? conversationKey(workspacePath, sessionId) : null
    if (!sessionId || !key) return

    const chat = chatStore()
    const userMessage = (override ?? (chat.draftInputs[key] ?? '')).trim()
    const takeComposerAttachments = options?.consumeAttachments !== false
    // 输入框图片仍在预处理：此时提交会与正在写入的附件竞争，静默忽略（系统触发的发送不受影响）
    if (takeComposerAttachments && deps.getImageProcessingCount() > 0) return

    // 斜杠命令不进入对话
    if (!options?.skipUserMessage && userMessage.startsWith('/')) {
      chat.setDraftInput(key, '')
      if (await handleSlashCommand(userMessage)) return
    }

    // 附件快照：用户提交时由本轮独占，随后立即从输入框消费
    const composerAttachments = takeComposerAttachments
      ? (chat.conversations[key]?.attachments ?? [])
      : (options?.attachments ?? [])
    const quoteFile =
      takeComposerAttachments && chat.conversations[key]?.quoteCurrentFile
        ? getCurrentEditorFile()
        : null
    const promptImages = takeComposerAttachments
      ? composerAttachments
          .filter((attachment) => attachment.kind === 'image')
          .map((attachment) => ({
            data: attachment.data ?? '',
            mimeType: attachment.mimeType ?? 'image/png',
          }))
          .filter((image) => image.data.length > 0)
      : (options?.images ?? [])
    const hasFileAttachments = composerAttachments.some((attachment) => attachment.kind !== 'image')

    // 纯图片 / 纯附件消息（无文本）也允许发送
    if (!userMessage && promptImages.length === 0 && !hasFileAttachments) return

    if (promptImages.length > 0) {
      if (!deps.getImagesAllowed()) {
        notify.error(deps.translate('modelImageDisabled'))
        return
      }
      const totalChars = promptImages.reduce((total, image) => total + image.data.length, 0)
      if (totalChars > MAX_TOTAL_IMAGE_BASE64_CHARS) {
        notify.error(deps.translate('imageTotalTooLarge'))
        return
      }
    }

    if (takeComposerAttachments && composerAttachments.length > 0) {
      chat.consumeAttachments(
        key,
        composerAttachments.map((attachment) => attachment.id)
      )
    }

    // 运行中：按设置默认值排队到下一轮，或立即插入当前轮（压缩期间暂不插话，等压缩结束再续）
    const targetLoading = Boolean(chat.conversations[key]?.isLoading)
    if (targetLoading && !isForceSend(key)) {
      chat.setDraftInput(key, '')
      const pendingAttachments = composerAttachments.filter(
        (attachment) => attachment.kind !== 'image'
      )
      const item = chat.addPending(key, userMessage, promptImages, pendingAttachments)
      if (
        !chatStore().conversations[key]?.isCompacting &&
        settingsStore().runWhileBusy === 'steer'
      ) {
        void sendSteer(sessionId, key, item)
      }
      return
    }

    // 真正发出这一轮才复位开关：排队期间保留，下一轮仍带上当前文档
    const hadQuoteCurrentFile = Boolean(
      takeComposerAttachments && chat.conversations[key]?.quoteCurrentFile
    )
    if (hadQuoteCurrentFile) {
      chat.setQuoteCurrentFile(key, false)
    }
    clearForceSend(key)
    clearBudgetWarned(key)
    clearTurnStopped(key)
    sessionStore().markError(workspacePath, sessionId, null)
    sessionStore().markUnread(workspacePath, sessionId, false)
    chat.setDraftInput(key, '')

    const acceptedAttachments = filterContextAttachments(composerAttachments, {
      onSnippetTooLarge: (name) => notify.error(`${deps.translate('contextTooLarge')}: ${name}`),
      onTotalTooLarge: () => notify.error(deps.translate('contextTotalTooLarge')),
    })
    const payload = buildTurnPayload({
      userMessage,
      acceptedAttachments,
      quoteFile,
      promptImages,
      attachmentOnlyText: (count) => deps.translate('attachmentOnlyMessage', { count }),
    })

    let addedUserMessageId: string | null = null
    if (!options?.skipUserMessage) {
      addedUserMessageId = chat.addMessage(key, {
        role: 'user',
        content: payload.displayContent,
        images: payload.promptImages.length > 0 ? payload.promptImages : undefined,
        ...(payload.messageContext ? { context: payload.messageContext } : {}),
      })
    }
    deps.onHideAttachMenu?.()
    chat.setLoading(key, true)
    sessionStore().markStreaming(workspacePath, sessionId, true)
    deps.onScrollToBottom?.()

    const assistantId = chat.startStreamingMessage(key)
    let autoCompacting = false
    const traceBuffer = createTraceBuffer((events) => {
      chatStore().applyTraceEvents(key, assistantId, events)
      for (const event of events) {
        if (event.type === 'compaction_start') {
          autoCompacting = true
        } else if (event.type === 'compaction_end') {
          autoCompacting = false
          if (event.error) {
            notify.error(deps.translate('compactFailed', { error: localizeError(event.error) }))
          } else if (!event.aborted) {
            void agentAPI.getContextUsage(workspacePath, sessionId).then((result) => {
              if (result.success) {
                chatStore().setContextUsage(key, result.usage ?? null)
              }
            })
          }
        }
      }
    })
    let succeeded = false
    let abortedByCompaction = false

    try {
      const result = await agentAPI.chat(
        payload.prompt,
        { onTrace: traceBuffer.push },
        workspacePath,
        sessionId,
        payload.promptImages.length > 0 ? payload.promptImages : undefined
      )
      traceBuffer.flush()

      if (result.success && result.response) {
        succeeded = true
        chat.setError(key, null)
        sessionStore().markError(workspacePath, sessionId, null)
        chat.finishStreamingMessage(key, assistantId, result.response)
        if (result.usage) chat.setMessageUsage(key, assistantId, result.usage)
        if (result.edits && result.edits.length > 0) {
          chat.setMessageEdits(key, assistantId, result.edits)
          emitEvent('pi:refresh-files')
          notify.info(deps.translate('agentModifiedFiles', { count: result.edits.length }))
        }
        if (result.plan) {
          chatStore().appendPlanPart(key, assistantId, result.plan)
        }
      } else if (result.compactionFailed) {
        // 前置手动压缩失败：未发给模型的消息从对话流撤回并退回输入框，失败提醒由压缩流程弹出
        abortedByCompaction = true
        const latestStore = chatStore()
        if (addedUserMessageId) latestStore.removeMessage(key, addedUserMessageId)
        latestStore.removeMessage(key, assistantId)
        latestStore.setError(key, null)
        sessionStore().markError(workspacePath, sessionId, null)
        const currentDraft = latestStore.draftInputs[key] ?? ''
        const restoredDraft = userMessage
          ? currentDraft
            ? `${userMessage}\n${currentDraft}`
            : userMessage
          : currentDraft
        if (restoredDraft !== currentDraft) {
          latestStore.setDraftInput(key, restoredDraft)
        }
        if (takeComposerAttachments && composerAttachments.length > 0) {
          for (const attachment of composerAttachments) {
            latestStore.addAttachment(key, attachment)
          }
        }
        if (hadQuoteCurrentFile) {
          latestStore.setQuoteCurrentFile(key, true)
        }
      } else {
        const errorMessage = describeAgentFailure(result, deps.translate)
        if (isTurnStopped(key)) {
          chat.setError(key, null)
          chat.finishStreamingMessage(key, assistantId)
        } else {
          chat.setError(key, errorMessage)
          sessionStore().markError(workspacePath, sessionId, errorMessage)
          chat.finishStreamingMessage(key, assistantId)
        }
        // 失败/截断/中止轮次前已落盘的文件修改与用量不能丢弃
        if (result.usage) chat.setMessageUsage(key, assistantId, result.usage)
        if (result.edits && result.edits.length > 0) {
          chat.setMessageEdits(key, assistantId, result.edits)
          emitEvent('pi:refresh-files')
        }
      }

      if (!abortedByCompaction) {
        try {
          const synced = await agentAPI.sessionsOpen(workspacePath, sessionId)
          if (synced.success && Array.isArray(synced.history) && synced.history.length > 0) {
            chatStore().reconcileMessages(key, synced.history)
          }
        } catch {
          // 离线 / 测试替身未实现 sessionsOpen 时保持实时渲染结果
        }
        void deps.onRefreshBranches?.(sessionId)
      }
    } catch (err) {
      traceBuffer.flush()
      const errorMsg = localizeError(err instanceof Error ? err.message : String(err))
      if (isTurnStopped(key)) {
        chat.setError(key, null)
        chat.finishStreamingMessage(key, assistantId)
      } else {
        chat.setError(key, errorMsg)
        sessionStore().markError(workspacePath, sessionId, errorMsg)
        chat.finishStreamingMessage(key, assistantId)
      }
    } finally {
      traceBuffer.dispose()
      if (autoCompacting) {
        chatStore().setCompacting(key, false)
      }
      chatStore().setLoading(key, false)
      sessionStore().markStreaming(workspacePath, sessionId, false)
      chatStore().setRetryStatus(key, null)
      void deps.onRefreshContextUsage?.(sessionId)
      void deps.onRefreshSessionStats?.(sessionId)

      // 轮次边界工作树切换：若本轮内曾排队切换，收尾时主动刷新工作树绑定与列表
      if (scheduledWorktreeSessions.delete(sessionId) && isWorkspaceStillOpen()) {
        void gitStore().load(workspacePath, sessionId)
      }

      // 本轮结束：自动发送下一条待发送消息（优先走模块级存活句柄，避免拆窗后落进旧闭包）
      const queued = chatStore().conversations[key]?.pending[0]
      if (queued && !isTurnStopped(key) && !abortedByCompaction) {
        chatStore().removePending(key, queued.id)
        markForceSend(key)
        scheduleTimer(() => {
          if (!isWorkspaceStillOpen()) return
          const queuedOptions: ChatSubmitOptions = {
            targetSessionId: sessionId,
            images: queued.images,
            attachments: queued.attachments,
            consumeAttachments: false,
          }
          const registered = deps.getQueuedSubmitHandler
            ? deps.getQueuedSubmitHandler()
            : getChatSubmitHandler(workspacePath)
          if (registered) {
            if (deps.getQueuedSubmitHandler) {
              void (registered as (override?: string, options?: ChatSubmitOptions) => Promise<void>)(
                queued.text,
                queuedOptions
              )
            } else {
              void (registered as ReturnType<typeof getChatSubmitHandler>)?.(
                undefined,
                queued.text,
                queuedOptions
              )
            }
          } else {
            void submitTurn(queued.text, queuedOptions)
          }
        }, 0)
      }

      const activeNow = sessionStore().byWorkspace[workspacePath]?.active
      if (succeeded) {
        if (activeNow && activeNow !== sessionId) {
          sessionStore().markUnread(workspacePath, sessionId, true)
        } else {
          sessionStore().markUnread(workspacePath, sessionId, false)
          deps.onFocusInput?.()
        }
      } else {
        sessionStore().markUnread(workspacePath, sessionId, false)
        if (activeNow === sessionId) deps.onFocusInput?.()
      }

      if (isWorkspaceStillOpen()) {
        const currentMessages = chatStore().conversations[key]?.messages.length ?? 0
        sessionStore().updateSession(workspacePath, sessionId, {
          messageCount: currentMessages,
          updatedAt: Date.now(),
        })
        void deps.onRefreshSessions?.()
        scheduleTimer(() => {
          if (!isWorkspaceStillOpen()) return
          void deps.onRefreshSessions?.()
        }, 1500)
      }
    }
  }

  const stopTurn = async (): Promise<void> => {
    const activeSessionId = deps.getActiveSessionId()
    if (!activeSessionId || stoppingInFlight) return
    const key = conversationKey(workspacePath, activeSessionId)
    // 压缩过程不可终止
    if (chatStore().conversations[key]?.isCompacting) return
    stoppingInFlight = true
    deps.onStoppingChange?.(true)
    markTurnStopped(key)
    try {
      await agentAPI.abort(workspacePath, activeSessionId)
    } finally {
      stoppingInFlight = false
      deps.onStoppingChange?.(false)
    }
  }

  const retryMessage = async (message: ChatMessage): Promise<void> => {
    const activeSessionId = deps.getActiveSessionId()
    if (!activeSessionId) return
    const activeKey = conversationKey(workspacePath, activeSessionId)
    const conv = chatStore().conversations[activeKey]
    if (conv?.isLoading) return

    const existingMessages = conv?.messages ?? []
    const msgIndex = existingMessages.findIndex((item) => item.id === message.id)
    // 图片挂在配对的用户消息上而非 assistant 消息上，回退前先取回用户图片避免丢图
    let pairedUserImages = message.images
    for (let i = (msgIndex >= 0 ? msgIndex : existingMessages.length) - 1; i >= 0; i -= 1) {
      if (existingMessages[i].role === 'user') {
        pairedUserImages = existingMessages[i].images ?? pairedUserImages
        break
      }
    }
    const result = await agentAPI.rewindLastUser(workspacePath, activeSessionId)
    if (!result.success || !result.text) {
      notify.error(deps.translate('retryFailed', { error: localizeError(result.error ?? '') }))
      return
    }
    chatStore().removeMessage(activeKey, message.id)
    const restored = result.context ? contextToAttachments(result.context) : []
    await submitTurn(result.text, {
      skipUserMessage: true,
      images: pairedUserImages,
      ...(restored.length > 0 ? { attachments: restored } : {}),
      consumeAttachments: false,
    })
  }

  const editMessage = async (message: ChatMessage): Promise<void> => {
    const activeSessionId = deps.getActiveSessionId()
    if (!activeSessionId) return
    const activeKey = conversationKey(workspacePath, activeSessionId)
    if (chatStore().conversations[activeKey]?.isLoading) return

    const next = await dialogs.prompt({
      title: deps.translate('editMessage'),
      message: deps.translate('editMessagePrompt'),
      defaultValue: message.content,
      confirmLabel: deps.translate('send'),
    })
    if (!next || !next.trim()) return
    const result = await agentAPI.rewindLastUser(workspacePath, activeSessionId, next.trim())
    if (!result.success) {
      notify.error(deps.translate('retryFailed', { error: localizeError(result.error ?? '') }))
      return
    }
    chatStore().truncateLastTurn(activeKey)
    const restored = result.context ? contextToAttachments(result.context) : []
    await submitTurn(next.trim(), {
      images: message.images,
      ...(restored.length > 0 ? { attachments: restored } : {}),
      consumeAttachments: false,
    })
  }

  const switchBranch = async (entryId: string): Promise<void> => {
    const activeSessionId = deps.getActiveSessionId()
    if (!activeSessionId) return
    const activeKey = conversationKey(workspacePath, activeSessionId)
    if (chatStore().conversations[activeKey]?.isLoading) return

    const result = await agentAPI.switchBranch(workspacePath, activeSessionId, entryId)
    if (!result.success || !result.history) {
      notify.error(
        deps.translate('branchSwitchFailed', { error: localizeError(result.error ?? '') })
      )
      return
    }
    chatStore().setMessages(activeKey, result.history)
    await deps.onRefreshBranches?.(activeSessionId)
    deps.onStickToBottom?.()
  }

  const respondApproval = async (
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void> => {
    const clearNeedsActionIfDone = (dir: string, sid: string) => {
      const remaining = approvalStore().requests.some(
        (item) => item.workspaceDir === dir && item.sessionId === sid
      )
      if (!remaining) {
        sessionStore().markNeedsAction(dir, sid, null)
      }
    }

    const result = await agentAPI.respondApproval(requestId, decision)
    if (!result.success) {
      notify.error(
        deps.translate('approvalRespondFailed', { error: localizeError(result.error ?? '') })
      )
      // 请求可能已超时 / 被中止；无论如何都移除卡片，避免残留
      const stale = approvalStore().requests.find((item) => item.requestId === requestId)
      approvalStore().remove(requestId)
      if (stale) clearNeedsActionIfDone(stale.workspaceDir, stale.sessionId)
      return
    }
    const request = approvalStore().requests.find((item) => item.requestId === requestId)
    approvalStore().remove(requestId)
    if (request) {
      clearNeedsActionIfDone(request.workspaceDir, request.sessionId)
      // “始终允许”写入会话权限；重新读取以同步状态行里的授权提示
      if (decision.action === 'allow-always' && request.workspaceDir === workspacePath) {
        void deps.onRefreshSessionSettings?.(request.sessionId)
      }
    }
  }

  const rejectPlan = async (plan: StructuredPlan): Promise<void> => {
    const activeSessionId = deps.getActiveSessionId()
    if (!activeSessionId) return
    const activeKey = conversationKey(workspacePath, activeSessionId)
    if (chatStore().conversations[activeKey]?.isLoading) return

    const result = await agentAPI.rejectPlan(workspacePath, activeSessionId, plan.id)
    if (!result.success || !result.plan) {
      notify.error(
        deps.translate('planRejectFailed', { error: localizeError(result.error ?? '') })
      )
      return
    }
    chatStore().applyPlanUpdate(activeKey, result.plan)
    notify.info(deps.translate('planRejected'))
  }

  const approvePlan = async (
    plan: StructuredPlan,
    targetMode: 'ask' | 'auto'
  ): Promise<void> => {
    const activeSessionId = deps.getActiveSessionId()
    if (!activeSessionId) return
    const activeKey = conversationKey(workspacePath, activeSessionId)
    if (chatStore().conversations[activeKey]?.isLoading) return

    const result = await agentAPI.approvePlan(workspacePath, activeSessionId, plan.id, targetMode)
    if (!result.success || !result.plan) {
      notify.error(
        deps.translate('planApproveFailed', { error: localizeError(result.error ?? '') })
      )
      return
    }
    chatStore().applyPlanUpdate(activeKey, result.plan)
    const previous = chatStore().conversations[activeKey]?.sessionSettings ?? null
    if (result.permission) {
      chatStore().setSessionSettings(activeKey, { ...previous, permission: result.permission })
    }
    void submitTurn(buildPlanExecutionPrompt(result.plan, deps.translate), {
      consumeAttachments: false,
    })
  }

  const executePlan = async (targetMode: 'ask' | 'auto'): Promise<void> => {
    const activeSessionId = deps.getActiveSessionId()
    if (!activeSessionId) return
    const activeKey = conversationKey(workspacePath, activeSessionId)
    if (chatStore().conversations[activeKey]?.isLoading) return

    const latestProposedPlan = deps.getLatestProposedPlan()
    if (latestProposedPlan) {
      await approvePlan(latestProposedPlan.plan, targetMode)
      return
    }
    if (deps.onApplySessionPermission) {
      if (!(await deps.onApplySessionPermission({ mode: targetMode, grants: [] }))) return
    }
    void submitTurn(deps.translate('planExecuteFallback'), { consumeAttachments: false })
  }

  /**
   * 工作树轮次边界切换编排：
   * 空闲时立即生效；会话正在流式输出时由主进程挂到轮次边界生效，并在本轮收尾时同步工作树视图。
   */
  const requestWorktreeSwitch = async (
    target: string,
    base?: string
  ): Promise<{ success: boolean; scheduled?: boolean; error?: string }> => {
    const activeSessionId = deps.getActiveSessionId()
    if (!activeSessionId) {
      return { success: false, error: deps.translate('noActiveSession') }
    }
    const result = await gitStore().switchWorktree(workspacePath, activeSessionId, target, base)
    if (!result.success) {
      notify.error(localizeError(result.error ?? ''))
      return result
    }
    if (result.scheduled) {
      scheduledWorktreeSessions.add(activeSessionId)
    }
    return result
  }

  return {
    handleSlashCommand,
    sendSteer,
    submitTurn,
    stopTurn,
    retryMessage,
    editMessage,
    switchBranch,
    respondApproval,
    approvePlan,
    rejectPlan,
    executePlan,
    requestWorktreeSwitch,
  }
}
