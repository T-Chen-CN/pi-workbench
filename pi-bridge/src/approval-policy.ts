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

export function categorizeTool(toolName: string): ToolCategory {
  switch (toolName) {
    case 'read':
    case 'grep':
    case 'find':
    case 'ls':
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
  | { action: 'allow-session' }
  | { action: 'allow-always' }
  | { action: 'deny'; reason?: string }

export function isAllowDecision(decision: ApprovalDecision): boolean {
  return (
    decision.action === 'allow-once' ||
    decision.action === 'allow-session' ||
    decision.action === 'allow-always'
  )
}
