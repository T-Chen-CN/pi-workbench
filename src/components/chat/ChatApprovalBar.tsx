/**
 * 待审批权限卡片、结构化计划进度条与计划模式兜底审批栏（窄订阅 + React.memo）。
 * 仅订阅当前会话的审批队列与计划状态，避免审批到达触发聊天记录或输入区重渲染。
 */

import React, { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApprovalStore } from '../../store/approvalStore'
import { useChatStore } from '../../store/chatStore'
import { useI18nStore } from '../../store/i18nStore'
import { DEFAULT_SESSION_PERMISSION, EMPTY_MESSAGES } from '../../utils/chatPanelShared'
import type { ApprovalDecision, StructuredPlan } from '../../types/electron'
import type { ChatTranslate } from './chatTurnController'
import { ApprovalCard } from './ApprovalCard'
import { TurnTaskList } from './ChatMessageRow'
import { Button, Caption } from '../ui/ui'

export interface ChatApprovalBarProps {
  workspacePath: string
  activeSessionId: string
  activeKey: string | null
  onRespondApproval: (requestId: string, decision: ApprovalDecision) => void | Promise<void>
  onExecutePlan: (targetMode: 'ask' | 'auto') => void | Promise<void>
  t?: ChatTranslate
}

export const ChatApprovalBar: React.FC<ChatApprovalBarProps> = React.memo(function ChatApprovalBar({
  workspacePath,
  activeSessionId,
  activeKey,
  onRespondApproval,
  onExecutePlan,
  t: tProp,
}) {
  const storeT = useI18nStore((state) => state.t)
  const t = tProp ?? storeT

  const approvalRequests = useApprovalStore((state) => state.requests)
  const pendingApprovals = useMemo(
    () =>
      approvalRequests.filter(
        (request) =>
          request.workspaceDir === workspacePath && request.sessionId === activeSessionId
      ),
    [approvalRequests, workspacePath, activeSessionId]
  )

  const { messages, isLoading, sessionMode } = useChatStore(
    useShallow((state) => {
      const conv = activeKey ? state.conversations[activeKey] : undefined
      return {
        messages: conv?.messages ?? EMPTY_MESSAGES,
        isLoading: conv?.isLoading ?? false,
        sessionMode: conv?.sessionSettings?.permission?.mode ?? DEFAULT_SESSION_PERMISSION.mode,
      }
    })
  )

  const { activePlan, hasProposedPlan, hasAssistantMessage, lastAssistantMessage } = useMemo(() => {
    let foundActive: StructuredPlan | null = null
    let foundProposed = false
    let foundAssistant = false
    let lastAssistant = null

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const msg = messages[index]
      if (msg.role === 'assistant') {
        if (!lastAssistant) lastAssistant = msg
        foundAssistant = true
      }
      const parts = msg.parts ?? []
      for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
        const part = parts[partIndex]
        if (part.type !== 'plan') continue
        if (!foundActive && part.plan.status === 'approved') foundActive = part.plan
        if (!foundProposed && part.plan.status === 'proposed') foundProposed = true
      }
    }

    return {
      activePlan: foundActive,
      hasProposedPlan: foundProposed,
      hasAssistantMessage: foundAssistant,
      lastAssistantMessage: lastAssistant,
    }
  }, [messages])

  const showPlanFallbackBar =
    sessionMode === 'plan' && !isLoading && !hasProposedPlan && hasAssistantMessage
  const showTurnTaskList =
    !activePlan && Boolean(lastAssistantMessage?.parts?.some((part) => part.type === 'tool'))

  if (
    !activePlan &&
    !showTurnTaskList &&
    !showPlanFallbackBar &&
    pendingApprovals.length === 0
  ) {
    return null
  }

  return (
    <>
      {activePlan ? (
        <div className="mb-2 flex items-center justify-between gap-2 border border-rule-hairline bg-raised px-3 py-2">
          <Caption className="text-ink-muted">
            {t('planProgress', {
              done: activePlan.steps.filter((step) => step.status === 'done').length,
              total: activePlan.steps.length,
            })}
          </Caption>
          <span className="min-w-0 truncate type-caption text-ink">
            {(
              activePlan.steps.find((step) => step.status === 'in_progress') ??
              activePlan.steps.find((step) => step.status === 'pending')
            )?.title ?? ''}
          </span>
        </div>
      ) : (
        showTurnTaskList && (
          <div className="mb-2">
            <TurnTaskList parts={lastAssistantMessage?.parts ?? []} />
          </div>
        )
      )}

      {showPlanFallbackBar && (
        <div
          data-testid="plan-review-bar"
          className="mb-2 flex flex-col gap-2 border border-rule-hairline bg-raised px-3 py-2"
        >
          <span className="type-caption text-ink-muted">{t('planModeHint')}</span>
          <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => void onExecutePlan('auto')}>
              {t('planApproveAuto')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void onExecutePlan('ask')}>
              {t('planApproveAsk')}
            </Button>
          </div>
        </div>
      )}

      {pendingApprovals.length > 0 && (
        <div data-testid="approval-bar" className="mb-2 flex flex-col gap-2">
          {pendingApprovals.map((request) => (
            <ApprovalCard
              key={request.requestId}
              request={request}
              onRespond={onRespondApproval}
            />
          ))}
        </div>
      )}
    </>
  )
})
