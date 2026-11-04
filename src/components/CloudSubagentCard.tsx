/**
 * 子代理卡片：一次 `delegate_task` 派出去的子任务，跑完给一份可观测回执。
 *
 * 默认收起一行（状态 + 目标 + 耗时），点开看 token / 费用 / 碰过的文件 / 输出尾巴。
 * 历史消息里没有子代理事件，所以重开会话看不到这些卡片——时间线上会单独说明。
 */

import React, { useState } from 'react'
import { AlertCircle, Check, ChevronRight, GitBranch, Loader2, Timer } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import type { CloudTracePart } from '../types/cloud'
import { Caption, DataText, Label } from './ui'

type SubagentPart = Extract<CloudTracePart, { type: 'subagent' }>

const Metric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-col gap-0.5">
    <Caption className="text-ink-subtle">{label}</Caption>
    <DataText className="text-ink">{value}</DataText>
  </div>
)

export const CloudSubagentCard: React.FC<{ part: SubagentPart }> = ({ part }) => {
  const { t } = useI18nStore()
  const [open, setOpen] = useState(false)

  const running = part.status === 'running'
  const failed = part.status === 'failed' || part.status === 'timeout'
  const statusText = running
    ? t('cloudSubagentRunning')
    : part.status === 'timeout'
      ? t('cloudSubagentTimeout')
      : part.status === 'failed'
        ? t('cloudSubagentFailed')
        : t('cloudSubagentDone')

  const icon = running ? (
    <Loader2 size={12} className="flex-shrink-0 animate-spin text-accent" />
  ) : failed ? (
    <AlertCircle size={12} className="flex-shrink-0 text-danger" />
  ) : (
    <Check size={12} className="flex-shrink-0 text-success" />
  )

  const metrics: Array<{ label: string; value: string }> = []
  if (typeof part.toolCount === 'number') {
    metrics.push({ label: t('cloudSubagentTools'), value: String(part.toolCount) })
  }
  const tokens = (part.inputTokens ?? 0) + (part.outputTokens ?? 0)
  if (tokens > 0) {
    metrics.push({ label: t('cloudSubagentTokens'), value: String(tokens) })
  }
  if (typeof part.costUsd === 'number') {
    metrics.push({ label: t('cloudSubagentCost'), value: `$${part.costUsd.toFixed(4)}` })
  }
  if (typeof part.filesRead === 'number') {
    metrics.push({ label: t('cloudSubagentRead'), value: String(part.filesRead) })
  }
  if (typeof part.filesWritten === 'number') {
    metrics.push({ label: t('cloudSubagentWritten'), value: String(part.filesWritten) })
  }

  const detail = Boolean(part.summary || part.outputTail || part.failureReason || metrics.length > 0)

  return (
    <div className="border border-rule-hairline bg-raised">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${part.goal} ${statusText}`}
        disabled={!detail}
        onClick={() => detail && setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left disabled:cursor-default"
      >
        <ChevronRight
          size={12}
          className={`flex-shrink-0 text-ink-subtle transition-transform ${open ? 'rotate-90' : ''} ${
            detail ? '' : 'invisible'
          }`}
        />
        {icon}
        <GitBranch size={11} className="flex-shrink-0 text-ink-subtle" />
        <span className="min-w-0 flex-1 truncate type-caption text-ink">
          {part.goal || t('cloudSubagentUntitled')}
        </span>
        {typeof part.taskCount === 'number' && part.taskCount > 1 && (
          <Caption className="flex-shrink-0 text-ink-subtle">
            {`${(part.taskIndex ?? 0) + 1}/${part.taskCount}`}
          </Caption>
        )}
        <Label className={running ? 'text-accent' : failed ? 'text-danger' : 'text-success'}>
          {statusText}
        </Label>
        {typeof part.durationMs === 'number' && part.durationMs > 0 && (
          <Caption className="flex-shrink-0 text-ink-subtle">
            <span className="inline-flex items-center gap-0.5">
              <Timer size={10} />
              {`${(part.durationMs / 1000).toFixed(1)}s`}
            </span>
          </Caption>
        )}
      </button>

      {open && (
        <div className="border-t border-rule-divide px-2 py-2">
          {part.failureReason && (
            <div className="mb-1.5 type-caption text-danger">{part.failureReason}</div>
          )}
          {metrics.length > 0 && (
            <div className="mb-2 grid grid-cols-3 gap-2">
              {metrics.map((metric) => (
                <Metric key={metric.label} label={metric.label} value={metric.value} />
              ))}
            </div>
          )}
          {part.summary && (
            <div className="mb-2">
              <Caption className="text-ink-subtle">{t('cloudSubagentSummary')}</Caption>
              <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words bg-surface px-2 py-1 type-caption text-ink">
                {part.summary}
              </pre>
            </div>
          )}
          {part.outputTail && (
            <div>
              <Caption className="text-ink-subtle">{t('cloudSubagentOutput')}</Caption>
              <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all bg-surface px-2 py-1 type-caption text-ink-muted">
                {part.outputTail}
              </pre>
            </div>
          )}
          {part.childSessionId && (
            <Caption className="mt-1 block text-ink-subtle">
              {t('cloudSubagentSession', { id: part.childSessionId })}
            </Caption>
          )}
        </div>
      )}
    </div>
  )
}
