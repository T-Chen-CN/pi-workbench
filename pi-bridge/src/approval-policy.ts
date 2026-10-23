/**
 * 工具审批策略（AF-01）
 *
 * 纯函数模块：把工具调用归类、解析权限策略、生成审批卡需要的摘要。
 * 审批的执行（挂起 / 放行）在 AgentManager 里，通过 Pi 的 tool_call 扩展钩子完成。
 */

export type ToolCategory = 'read' | 'write' | 'command' | 'other'

export type PermissionAction = 'allow' | 'ask' | 'deny'

export interface PermissionPolicy {
  read: PermissionAction
  write: PermissionAction
  command: PermissionAction
  other: PermissionAction
}

/**
 * 默认权限档位（AF-02）：全局只提供新会话的默认档，会话是权限的唯一权威。
 * 只读用 deny 而非 ask，让 Agent 立刻收到明确拒绝，无需等待无人响应的审批。
 */
export type PermissionLevel = 'readonly' | 'ask' | 'auto'

/**
 * 会话模式：权限档位 + 计划工作流。
 * 计划不是一种更高的权限，而是“只读探索并产出结构化计划”的工作方式；
 * 它作为会话内的意图可选，但不作为新会话的默认档。
 */
export type SessionMode = PermissionLevel | 'plan'

export const PERMISSION_LEVELS: PermissionLevel[] = ['readonly', 'ask', 'auto']

export const SESSION_MODES: SessionMode[] = ['readonly', 'plan', 'ask', 'auto']

export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = 'ask'

const READ_ONLY_POLICY: PermissionPolicy = {
  read: 'allow',
  write: 'deny',
  command: 'deny',
  other: 'deny',
}

export const PERMISSION_LEVEL_POLICIES: Record<PermissionLevel, PermissionPolicy> = {
  readonly: READ_ONLY_POLICY,
  ask: { read: 'allow', write: 'ask', command: 'ask', other: 'ask' },
  auto: { read: 'allow', write: 'allow', command: 'allow', other: 'allow' },
}

export const SESSION_MODE_POLICIES: Record<SessionMode, PermissionPolicy> = {
  readonly: READ_ONLY_POLICY,
  plan: READ_ONLY_POLICY,
  ask: PERMISSION_LEVEL_POLICIES.ask,
  auto: PERMISSION_LEVEL_POLICIES.auto,
}

/** 会话模式：模式 + 会话内额外允许的类别；只在 ask 模式下产生授权 */
export interface SessionPermission {
  mode: SessionMode
  grants: ToolCategory[]
}

/** 默认只自动批准读取；写文件、执行命令和未知工具都需要审批 */
export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  read: 'allow',
  write: 'ask',
  command: 'ask',
  other: 'ask',
}

export const TOOL_CATEGORIES: ToolCategory[] = ['read', 'write', 'command', 'other']

export function isPermissionAction(value: unknown): value is PermissionAction {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === 'readonly' || value === 'ask' || value === 'auto'
}

export function isSessionMode(value: unknown): value is SessionMode {
  return value === 'readonly' || value === 'plan' || value === 'ask' || value === 'auto'
}

/** 接受任意来源的设置片段，缺失或非法值回落到默认策略 */
export function normalizePermissionPolicy(input: unknown): PermissionPolicy {
  const source = (input ?? {}) as Record<string, unknown>
  const result = { ...DEFAULT_PERMISSION_POLICY }
  for (const category of TOOL_CATEGORIES) {
    const value = source[category]
    if (isPermissionAction(value)) result[category] = value
  }
  return result
}

/**
 * 归一化会话模式：接受新字段 mode 与旧字段 level（升级前写入的会话）。
 * 授权只保留 base 为 ask 的类别，非 ask 模式一律清空，避免模式与授权同时生效造成歧义。
 */
export function normalizeSessionPermission(input: unknown): SessionPermission {
  const source = (input ?? {}) as Record<string, unknown>
  const rawMode = isSessionMode(source.mode) ? source.mode : source.level
  const mode = isSessionMode(rawMode) ? rawMode : DEFAULT_PERMISSION_LEVEL
  if (mode !== 'ask' || !Array.isArray(source.grants)) return { mode, grants: [] }
  const grants: ToolCategory[] = []
  for (const category of TOOL_CATEGORIES) {
    if (source.grants.includes(category) && PERMISSION_LEVEL_POLICIES.ask[category] === 'ask') {
      grants.push(category)
    }
  }
  return { mode, grants }
}

/** 把会话模式合成为实际执行的策略 */
export function resolvePermissionPolicy(input: unknown): PermissionPolicy {
  const permission = normalizeSessionPermission(input)
  const policy = { ...SESSION_MODE_POLICIES[permission.mode] }
  for (const category of permission.grants) {
    if (policy[category] === 'ask') policy[category] = 'allow'
  }
  return policy
}

/**
 * 旧版四类自定义策略 → 最接近的档位。
 * 规则：取“任意类别都不宽于旧策略”的最宽松档位，迁移只会变严不会变松。
 * 供 settings.json 从旧 permissions 字段迁移到 permissionLevel 使用。
 */
export function derivePermissionLevelFromPolicy(input: unknown): PermissionLevel {
  const policy = normalizePermissionPolicy(input)
  const rank: Record<PermissionAction, number> = { deny: 0, ask: 1, allow: 2 }
  for (const level of ['auto', 'ask', 'readonly'] as PermissionLevel[]) {
    const preset = PERMISSION_LEVEL_POLICIES[level]
    if (TOOL_CATEGORIES.every((category) => rank[preset[category]] <= rank[policy[category]])) {
      return level
    }
  }
  return 'readonly'
}

export function categorizeTool(toolName: string): ToolCategory {
  switch (toolName) {
    // 计划工具只更新会话内的计划状态，不触碰文件或命令
    case 'read':
    case 'grep':
    case 'find':
    case 'ls':
    case 'submit_plan':
    case 'update_plan_step':
      return 'read'
    case 'write':
    case 'edit':
      return 'write'
    case 'bash':
    case 'powershell':
      return 'command'
    default:
      return 'other'
  }
}

export interface ApprovalDetails {
  /** 目标文件（write / edit / read 等） */
  path?: string
  /** 命令内容（bash / powershell，截断） */
  command?: string
  /** 写入内容预览（write，截断；不展示完整文件） */
  preview?: string
  /** edit 的修改处数 */
  editCount?: number
}

const DETAIL_TEXT_LIMIT = 400
const PREVIEW_LIMIT = 280

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}

/**
 * 生成审批卡展示用的参数摘要。
 * 刻意不包含完整 write 内容：审批只需要判断风险，完整内容留给 Diff 审阅。
 */
export function buildApprovalDetails(toolName: string, args: unknown): ApprovalDetails {
  const value = (args ?? {}) as Record<string, any>
  const details: ApprovalDetails = {}
  if (typeof value.path === 'string' && value.path) details.path = value.path
  if (typeof value.command === 'string' && value.command) {
    details.command = truncate(value.command, DETAIL_TEXT_LIMIT)
  }
  if (toolName === 'write' && typeof value.content === 'string') {
    details.preview = truncate(value.content, PREVIEW_LIMIT)
  }
  if (toolName === 'edit' && Array.isArray(value.edits)) {
    details.editCount = value.edits.length
  }
  return details
}

export interface ApprovalRequestPayload {
  requestId: string
  workspaceDir: string
  sessionId: string
  toolCallId: string
  toolName: string
  category: ToolCategory
  /** 一句话参数摘要（由工具参数生成） */
  summary: string
  details: ApprovalDetails
  createdAt: number
  /** 超时时间点；到点按拒绝处理，不能“超时即通过” */
  expiresAt: number
}

export type ApprovalDecision =
  | { action: 'allow-once' }
  | { action: 'allow-always' }
  | { action: 'deny'; reason?: string }

export function isAllowDecision(decision: ApprovalDecision): boolean {
  return decision.action === 'allow-once' || decision.action === 'allow-always'
}
