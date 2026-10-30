/**
 * 工作区级 Agent 注册表。
 *
 * 每个打开的工作区持有独立的 AgentManager 实例；配置未变化时复用，
 * 配置变化或工作区关闭时释放。
 */
import { withTimeout } from './async-utils.js'

/**
 * 单个 Agent 释放的上界。退出时一个卡死的会话（等待 sidecar 落盘、
 * 未响应的 abort）不能拖住整个应用 —— 超时只记警告，进程继续退出。
 */
const AGENT_DISPOSE_TIMEOUT_MS = 2_000
export interface AgentChatOutcome {
  success: boolean
  response?: string
  error?: string
  edits?: unknown[]
}

/** 结构化计划（R-04）；与 pi-bridge 的 StructuredPlan 对应 */
export interface StructuredPlanPayload {
  id: string
  summary: string
  status: 'proposed' | 'approved' | 'rejected'
  createdAt: number
  updatedAt: number
  steps: Array<{
    id: string
    title: string
    files: string[]
    risk?: string
    status: 'pending' | 'in_progress' | 'done' | 'skipped'
  }>
}

/** 会话模式（AF-02）；与 pi-bridge 的 SessionPermission 对应 */
export interface SessionPermissionPayload {
  mode: 'readonly' | 'plan' | 'ask' | 'auto'
  grants: Array<'read' | 'write' | 'command' | 'other'>
}

export interface RegisteredAgent {
  initialize: (config: unknown) => Promise<{ success: boolean; error?: string }>
  chat: {
    (
      message: string,
      options?: {
        onTextDelta?: (delta: string) => void
        onTrace?: (event: { type: string; [key: string]: unknown }) => void
      }
    ): Promise<AgentChatOutcome>
    (
      sessionId: string,
      message: string,
      options?: {
        onTextDelta?: (delta: string) => void
        onTrace?: (event: { type: string; [key: string]: unknown }) => void
      }
    ): Promise<AgentChatOutcome>
  }
  dispose: () => Promise<void> | void
  /** 运行中切换会话工作树；空闲时立即重建，运行中排队到轮次边界 */
  requestSessionRoot?: (
    sessionId: string,
    root: string
  ) => Promise<{ success: boolean; scheduled?: boolean; error?: string }>
  /** 中止请求（可选，Agent 不支持时忽略） */
  abort?: (sessionId?: string) => Promise<void>
  isInitialized: () => boolean
  getSessionMessages?: (sessionId?: string) => unknown
  getMessageHistory?: (sessionId?: string) => unknown
  listSessions?: () => Promise<unknown[]>
  openSession?: (sessionId?: string) => Promise<unknown>
  createSession?: (root?: string) => Promise<unknown>
  closeSession?: (sessionId: string) => Promise<void>
  renameSession?: (sessionId: string, name: string) => Promise<unknown>
  deleteSession?: (sessionId: string) => Promise<{ success: boolean; error?: string }>
  /** 运行中插话（steer）：携带图片时允许空文本 */
  steer?: (
    sessionId: string,
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ) => Promise<{ success: boolean; error?: string }>
  /** 上下文占用 */
  getContextUsage?: (sessionId: string) => Promise<{
    success: boolean
    usage?: { tokens: number | null; contextWindow: number; percent: number | null }
    error?: string
  }>
  /** 手动压缩上下文 */
  compactContext?: (sessionId: string) => Promise<{
    success: boolean
    tokensBefore?: number
    estimatedTokensAfter?: number
    error?: string
  }>
  /** 回退到最后一条用户消息（重试 / 编辑重发） */
  rewindToLastUser?: (
    sessionId: string,
    newText?: string
  ) => Promise<{ success: boolean; text?: string; error?: string }>
  /** 回复分支列表与切换（R-03） */
  listBranches?: (sessionId: string) => Promise<{
    success: boolean
    groups?: Array<{
      userTimestamp: number
      activeIndex: number
      branches: Array<{ entryId: string; preview: string }>
    }>
    error?: string
  }>
  switchBranch?: (
    sessionId: string,
    entryId: string
  ) => Promise<{ success: boolean; history?: unknown; error?: string }>
  /** 工具结果全量查看（R-20） */
  getToolResultMeta?: (
    sessionId: string,
    toolCallId: string
  ) => Promise<{
    success: boolean
    meta?: {
      toolName: string
      kind: 'text' | 'image'
      chars: number
      bytes: number
      lines: number
      imageCount: number
    }
    error?: string
  }>
  readToolResultChunk?: (
    sessionId: string,
    toolCallId: string,
    offset?: number,
    limit?: number
  ) => Promise<{
    success: boolean
    text?: string
    offset?: number
    nextOffset?: number
    chars?: number
    done?: boolean
    error?: string
  }>
  getToolResultImage?: (
    sessionId: string,
    toolCallId: string,
    index?: number
  ) => Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }>
  getToolResultText?: (
    sessionId: string,
    toolCallId: string
  ) => Promise<{ success: boolean; text?: string; toolName?: string; error?: string }>
  /** 会话导出（R-10） */
  exportSessionMarkdown?: (
    sessionId: string,
    language?: 'zh' | 'en'
  ) => Promise<{ success: boolean; title?: string; content?: string; error?: string }>
  exportSessionHtml?: (
    sessionId: string,
    language?: 'zh' | 'en'
  ) => Promise<{ success: boolean; title?: string; content?: string; error?: string }>
  getSessionJsonlPath?: (
    sessionId: string
  ) => Promise<{ success: boolean; title?: string; path?: string; error?: string }>
  /** 运行中的会话 ID；配置变更前的活跃检查 */
  hasRunningSessions?: () => string[]
  /** 模型能力提示（R-06） */
  getModelCapabilities?: () => Promise<{
    success: boolean
    models?: Array<{
      id: string
      available: boolean
      contextWindow: number
      maxTokens: number | null
      reasoning: boolean | null
      vision: boolean
      thinkingLevels: string[]
    }>
    selected?: string
    error?: string
  }>
  /** 提示模板与技能（R-13） */
  listPromptResources?: (sessionId: string) => Promise<{
    success: boolean
    templates?: Array<{
      name: string
      description: string
      argumentHint?: string
      scope: 'user' | 'project' | 'temporary'
    }>
    skills?: Array<{
      name: string
      description: string
      scope: 'user' | 'project' | 'temporary'
      disableModelInvocation: boolean
    }>
    error?: string
  }>
  /** 结构化计划（R-04） */
  getPlan?: (sessionId: string) => Promise<{
    success: boolean
    plan?: StructuredPlanPayload | null
    error?: string
  }>
  approvePlan?: (
    sessionId: string,
    planId: string,
    targetMode: 'ask' | 'auto'
  ) => Promise<{
    success: boolean
    plan?: StructuredPlanPayload
    permission?: SessionPermissionPayload
    error?: string
  }>
  rejectPlan?: (sessionId: string, planId: string) => Promise<{
    success: boolean
    plan?: StructuredPlanPayload
    error?: string
  }>
  /** 会话模型、思考级别与权限 */
  getSessionSettings?: (sessionId: string) => Promise<{
    success: boolean
    modelId?: string
    thinkingLevel?: string
    permission?: SessionPermissionPayload
    error?: string
  }>
  setSessionModel?: (sessionId: string, modelId: string) => Promise<{ success: boolean; error?: string }>
  setSessionThinking?: (
    sessionId: string,
    level: string
  ) => Promise<{ success: boolean; error?: string }>
  /** 修改会话模式（模式 + 额外授权） */
  setSessionPermission?: (
    sessionId: string,
    permission: unknown
  ) => Promise<{ success: boolean; permission?: SessionPermissionPayload; error?: string }>
  /** 会话累计用量与成本 */
  getSessionStats?: (sessionId: string) => Promise<{
    success: boolean
    stats?: {
      tokens: number
      input: number
      output: number
      cost: number
      toolCalls: number
      messages: number
    }
    error?: string
  }>
  getCurrentSessionId?: () => string | null
}

interface Entry {
  agent: RegisteredAgent
  configKey: string
}

/** 带超时与异常隔离的单个 Agent 释放 */
async function disposeAgent(agent: RegisteredAgent, label: string): Promise<void> {
  try {
    await withTimeout(
      Promise.resolve().then(() => agent.dispose()),
      AGENT_DISPOSE_TIMEOUT_MS,
      `${label} dispose`
    )
  } catch (error) {
    console.warn(`[Agent Registry] Failed to dispose ${label}:`, error)
  }
}

export class AgentRegistry {
  private entries = new Map<string, Entry>()

  /** 该工作区是否已有同配置且已初始化的 Agent */
  shouldReuse(workspaceDir: string, configKey: string): boolean {
    const entry = this.entries.get(workspaceDir)
    return Boolean(entry && entry.configKey === configKey && entry.agent.isInitialized())
  }

  get(workspaceDir: string): RegisteredAgent | null {
    return this.entries.get(workspaceDir)?.agent ?? null
  }

  /** 登记新 Agent；若该工作区已有旧实例则先释放 */
  async set(workspaceDir: string, agent: RegisteredAgent, configKey: string): Promise<void> {
    const existing = this.entries.get(workspaceDir)
    if (existing) {
      await disposeAgent(existing.agent, 'previous agent')
    }
    this.entries.set(workspaceDir, { agent, configKey })
  }

  async dispose(workspaceDir: string): Promise<void> {
    const entry = this.entries.get(workspaceDir)
    if (!entry) return
    this.entries.delete(workspaceDir)
    await disposeAgent(entry.agent, 'agent')
  }

  /**
   * 并行释放全部 Agent：串行会让一个卡住的会话把退出时间放大成 N × 超时。
   * 每个 Agent 都有独立超时，失败只记警告。
   */
  async disposeAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(entries.map((entry) => disposeAgent(entry.agent, 'agent')))
  }

  /** 已登记的工作区数量（测试与诊断用） */
  size(): number {
    return this.entries.size
  }

  /** 存在运行中会话的工作区与会话 ID；配置保存前用于避免打断正在跑的轮次 */
  listRunning(): Array<{ workspaceDir: string; sessionIds: string[] }> {
    const running: Array<{ workspaceDir: string; sessionIds: string[] }> = []
    for (const [workspaceDir, entry] of this.entries) {
      const sessionIds = entry.agent.hasRunningSessions?.() ?? []
      if (sessionIds.length > 0) running.push({ workspaceDir, sessionIds })
    }
    return running
  }
}
