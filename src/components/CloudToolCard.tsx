/** 云端时间线里的单个工具执行卡：默认收起，点开看参数与结果 */

import React, { useState } from 'react'
import { AlertCircle, Check, ChevronRight, Loader2, Wrench } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import type { CloudTracePart } from '../types/cloud'
import { Caption, DataText } from './ui'

type ToolPart = Extract<CloudTracePart, { type: 'tool' }>

export const CloudToolCard: React.FC<{ part: ToolPart }> = ({ part }) => {
  const { t } = useI18nStore()
  const [open, setOpen] = useState(false)
  const hasDetail = Boolean(part.argsSummary || part.resultPreview || part.status === 'error')
  const contentId = `cloud-tool-${part.id}`

  const statusText =
    part.status === 'running'
      ? t('cloudToolRunning')
      : part.status === 'error'
        ? t('cloudToolFailed')
        : t('cloudToolDone')

  const icon =
    part.status === 'running' ? (
      <Loader2 size={12} className="flex-shrink-0 animate-spin text-accent" />
    ) : part.status === 'error' ? (
      <AlertCircle size={12} className="flex-shrink-0 text-danger" />
    ) : (
      <Check size={12} className="flex-shrink-0 text-success" />
    )

  return (
    <div className="border border-rule-hairline bg-raised">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        aria-label={`${part.toolName} ${part.argsSummary} ${statusText}`}
        disabled={!hasDetail}
        onClick={() => hasDetail && setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left disabled:cursor-default"
      >
        <ChevronRight
          size={12}
          className={`flex-shrink-0 text-ink-subtle transition-transform ${
            open ? 'rotate-90' : ''
          } ${hasDetail ? '' : 'invisible'}`}
        />
        {icon}
        <Wrench size={11} className="flex-shrink-0 text-ink-subtle" />
        <DataText className="flex-shrink-0 text-ink">{part.toolName}</DataText>
        <span className="min-w-0 flex-1 truncate type-caption text-ink-muted">
          {part.argsSummary}
        </span>
        {typeof part.durationMs === 'number' && part.durationMs > 0 && (
          <Caption className="flex-shrink-0 text-ink-subtle">
            {`${(part.durationMs / 1000).toFixed(1)}s`}
          </Caption>
        )}
        <Caption
          className={`flex-shrink-0 ${
            part.status === 'error' ? 'text-danger' : 'text-ink-muted'
          }`}
        >
          {statusText}
        </Caption>
      </button>
      {open && (
        <div id={contentId} className="border-t border-rule-divide">
          {part.argsSummary && (
            <pre className="m-0 max-h-40 overflow-auto border-b border-rule-divide px-2 py-1.5 type-code text-ink-muted whitespace-pre-wrap break-all">
              {part.argsSummary}
            </pre>
          )}
          {part.resultPreview ? (
            <pre className="m-0 max-h-64 overflow-auto px-2 py-1.5 type-code text-ink-muted whitespace-pre-wrap break-all">
              {part.resultPreview}
            </pre>
          ) : (
            part.status === 'error' && (
              <div className="px-2 py-1.5">
                <Caption className="text-danger">{t('cloudToolFailedNoDetail')}</Caption>
              </div>
            )
          )}
          {typeof part.exitCode === 'number' && (
            <div className="border-t border-rule-divide px-2 py-1">
              <Caption className="text-ink-subtle">{`exit ${part.exitCode}`}</Caption>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
