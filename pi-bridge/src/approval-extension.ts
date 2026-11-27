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
  /** 判断动态工具（如 MCP 工具）是否为只读 */
  isReadOnlyTool?: (name: string) => boolean
}

export function createApprovalExtension(
  context: ApprovalExtensionContext,
  sessionId: string,
  getPermission: () => SessionPermission,
  onAlwaysAllow: (category: ToolCategory) => void | Promise<void>
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event: any, ctx?: { signal?: AbortSignal }) => {
      try {
        const signal = ctx?.signal
        if (signal?.aborted) {
          return { block: true, reason: 'Tool call was aborted.' }
        }
        const toolName = String(event?.toolName ?? '')
        const args = event?.input ?? event?.args ?? {}
        const category = categorizeTool(toolName, { isReadOnlyTool: context.isReadOnlyTool })
        const permission = normalizeSessionPermission(getPermission())

        if (
          (category === 'write' || category === 'command') &&
          context.isSwitchPending?.()
        ) {
          return {
            block: true,
            reason:
              'A worktree switch is scheduled for the end of this turn. Do not modify files or run commands until the switch takes effect.',
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

        const decision = await raceApprovalWithAbort(context.requestApproval(request), signal)
        if (!decision || typeof decision.action !== 'string') {
          return { block: true, reason: 'Tool approval failed closed (missing decision).' }
        }
        context.logger.info(`[Agent Manager] Tool approval for ${toolName}: ${decision.action}`)

        if (decision.action === 'allow-once') return undefined
        if (decision.action === 'allow-always') {
          try {
            await onAlwaysAllow(category)
          } catch (error) {
            context.logger.warn('[Agent Manager] Failed to persist always-allow grant:', error)
          }
          return undefined
        }

        const reason = decision.reason?.trim()
        return {
          block: true,
          reason: reason
            ? `The user denied this tool call: ${reason}`
            : 'The user denied this tool call.',
        }
      } catch (error) {
        context.logger.warn('[Agent Manager] Tool approval hook error (fail-closed):', error)
        return {
          block: true,
          reason: `Tool approval failed closed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    })
  }
}

/** 审批挂起期间若会话被 abort，必须立即解除阻塞并 fail-closed 拒绝，否则会卡死 abort/shutdown */
function raceApprovalWithAbort(
  pending: Promise<ApprovalDecision>,
  signal?: AbortSignal
): Promise<ApprovalDecision> {
  if (!signal) return pending
  if (signal.aborted) {
    return Promise.resolve({ action: 'deny', reason: 'Tool call was aborted.' })
  }
  return new Promise<ApprovalDecision>((resolve, reject) => {
    const onAbort = () => {
      resolve({ action: 'deny', reason: 'Tool call was aborted.' })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
