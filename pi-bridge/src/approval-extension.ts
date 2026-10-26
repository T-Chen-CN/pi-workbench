/** 工具审批扩展：按会话模式放行、拒绝或挂起等待用户 */

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import {
  buildApprovalDetails,
  categorizeTool,
  normalizeSessionPermission,
  resolvePermissionPolicy,
  type ApprovalDecision,
  type ApprovalRequestPayload,
  type SessionPermission,
  type ToolCategory,
} from './approval-policy.js'
import { summarizeToolArgs } from './text-utils.js'

const APPROVAL_TIMEOUT_MS = 120_000

export interface ApprovalExtensionContext {
  workspaceDir: string
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
  requestApproval: (request: ApprovalRequestPayload) => Promise<ApprovalDecision>
  /** 轮次边界等待切换工作树时，禁止继续写文件 */
  isSwitchPending?: () => boolean
}

export function createApprovalExtension(
  context: ApprovalExtensionContext,
  sessionId: string,
  getPermission: () => SessionPermission,
  onAlwaysAllow: (category: ToolCategory) => void | Promise<void>
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event: any) => {
      const toolName = String(event?.toolName ?? '')
      const args = event?.input ?? event?.args ?? {}
      const category = categorizeTool(toolName)
      const permission = normalizeSessionPermission(getPermission())

      if ((toolName === 'write' || toolName === 'edit') && context.isSwitchPending?.()) {
        return {
          block: true,
          reason:
            'A worktree switch is scheduled for the end of this turn. Do not modify files until the switch takes effect.',
        }
      }

      // Plan 模式只允许只读工具；即使工具集被意外放宽也要拦住
      if (permission.mode === 'plan' && category !== 'read') {
        return {
          block: true,
          reason:
            'Plan mode is read-only. Switch to Ask or Auto mode before modifying files or running commands.',
        }
      }

      const policy = resolvePermissionPolicy(permission)
      const action = policy[category]

      if (action === 'allow') return undefined
      if (action === 'deny') {
        context.logger.info(`[Agent Manager] Blocked tool ${toolName} by policy (${category})`)
        return {
          block: true,
          reason: `Tool "${toolName}" is blocked by the current permission policy.`,
        }
      }

      const request: ApprovalRequestPayload = {
        requestId: `approval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        workspaceDir: context.workspaceDir,
        sessionId,
        toolCallId: String(event?.toolCallId ?? ''),
        toolName,
        category,
        summary: summarizeToolArgs(toolName, args),
        details: buildApprovalDetails(toolName, args),
        createdAt: Date.now(),
        expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
      }

      const decision = await context.requestApproval(request)
      context.logger.info(`[Agent Manager] Tool approval for ${toolName}: ${decision.action}`)

      if (decision.action === 'allow-once') return undefined
      if (decision.action === 'allow-always') {
        await onAlwaysAllow(category)
        return undefined
      }

      const reason = decision.reason?.trim()
      return {
        block: true,
        reason: reason
          ? `The user denied this tool call: ${reason}`
          : 'The user denied this tool call.',
      }
    })
  }
}
