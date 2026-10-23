/**
 * 工作区级 Agent 注册表。
 *
 * 每个打开的工作区持有独立的 AgentManager 实例；配置未变化时复用，
 * 配置变化或工作区关闭时释放。
 */
export interface AgentChatOutcome {
  success: boolean
  response?: string
  error?: string
  edits?: unknown[]
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
  /** 中止请求（可选，Agent 不支持时忽略） */
  abort?: (sessionId?: string) => Promise<void>
  isInitialized: () => boolean
  getSessionMessages?: (sessionId?: string) => unknown
  getMessageHistory?: (sessionId?: string) => unknown
  listSessions?: () => Promise<unknown[]>
  openSession?: (sessionId?: string) => Promise<unknown>
  createSession?: () => Promise<unknown>
  closeSession?: (sessionId: string) => Promise<void>
  renameSession?: (sessionId: string, name: string) => Promise<unknown>
  deleteSession?: (sessionId: string) => Promise<unknown>
  /** 切换会话模式（Plan 只读 / Act 可写） */
  setSessionMode?: (
    sessionId: string,
    mode: 'plan' | 'act'
  ) => Promise<{ success: boolean; error?: string }>
  /** 运行中插话（steer） */
  steer?: (sessionId: string, message: string) => Promise<{ success: boolean; error?: string }>
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
  /** 检查点列表与回退 */
  listCheckpoints?: (sessionId?: string) => Promise<{
    success: boolean
    checkpoints?: Array<{ id: string; sessionId: string; createdAt: number; fileCount: number }>
    error?: string
  }>
  restoreCheckpoint?: (
    sessionId: string,
    checkpointId: string,
    options: { files?: boolean; conversation?: boolean }
  ) => Promise<{ success: boolean; restoredFiles?: number; error?: string }>
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
  /** 会话模型与思考级别 */
  getSessionSettings?: (sessionId: string) => Promise<{
    success: boolean
    modelId?: string
    thinkingLevel?: string
    error?: string
  }>
  setSessionModel?: (sessionId: string, modelId: string) => Promise<{ success: boolean; error?: string }>
  setSessionThinking?: (
    sessionId: string,
    level: string
  ) => Promise<{ success: boolean; error?: string }>
  /** 历史工具调用的文件 Diff（会话 sidecar） */
  getToolEdit?: (
    sessionId: string,
    toolCallId: string
  ) => Promise<{
    success: boolean
    edit?: { path: string; oldContent: string; newContent: string }
    error?: string
  }>
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
      try {
        await existing.agent.dispose()
      } catch (error) {
        console.warn('[Agent Registry] Failed to dispose previous agent:', error)
      }
    }
    this.entries.set(workspaceDir, { agent, configKey })
  }

  async dispose(workspaceDir: string): Promise<void> {
    const entry = this.entries.get(workspaceDir)
    if (!entry) return
    this.entries.delete(workspaceDir)
    await entry.agent.dispose()
  }

  async disposeAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) {
      try {
        await entry.agent.dispose()
      } catch (error) {
        console.warn('[Agent Registry] Failed to dispose agent:', error)
      }
    }
  }

  /** 已登记的工作区数量（测试与诊断用） */
  size(): number {
    return this.entries.size
  }
}
