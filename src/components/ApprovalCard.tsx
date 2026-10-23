import React, { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import type { TranslationKey } from '../i18n/translations'
import type { ApprovalDecision, ApprovalRequestPayload, ToolCategory } from '../types/electron'
import { Button, DataText, Textarea } from './ui'

interface ApprovalCardProps {
  request: ApprovalRequestPayload
  /** 用户作出选择；由调用方负责发送响应并从队列移除 */
  onRespond: (requestId: string, decision: ApprovalDecision) => Promise<void> | void
  disabled?: boolean
}

const CATEGORY_LABEL_KEYS: Record<ToolCategory, TranslationKey> = {
  read: 'approvalCategoryRead',
  write: 'approvalCategoryWrite',
  command: 'approvalCategoryCommand',
  other: 'approvalCategoryOther',
}

/**
 * 工具审批卡（AF-01）：展示工具名、参数摘要与影响范围，
 * 提供允许一次 / 本会话允许 / 始终允许 / 拒绝四条路径。
 */
export const ApprovalCard: React.FC<ApprovalCardProps> = ({ request, onRespond, disabled }) => {
  const t = useI18nStore((state) => state.t)
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const respond = async (decision: ApprovalDecision) => {
    if (busy || disabled) return
    setBusy(true)
    try {
      await onRespond(request.requestId, decision)
    } finally {
      setBusy(false)
    }
  }

  const { details } = request
  return (
    <div className="border border-rule-hairline bg-raised" data-testid="approval-card">
      <div className="flex items-start gap-2 border-b border-rule-divide px-3 py-2">
        <ShieldAlert size={13} className="mt-0.5 flex-shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="type-label text-ink">{t('approvalTitle')}</div>
          <div
            className="mt-0.5 truncate type-value text-ink"
            title={`${request.toolName} · ${request.summary}`}
          >
            {t('approvalToolCall', { tool: request.toolName, summary: request.summary })}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 type-caption text-ink-muted">
            <span>{t(CATEGORY_LABEL_KEYS[request.category])}</span>
            {details.path && <DataText className="truncate">{details.path}</DataText>}
            {typeof details.editCount === 'number' && (
              <DataText>{details.editCount}</DataText>
            )}
          </div>
        </div>
      </div>

      {(details.command || details.preview) && (
        <div className="border-b border-rule-divide px-3 py-2">
          {details.command && (
            <pre className="m-0 max-h-24 overflow-auto whitespace-pre-wrap break-all border border-rule-divide bg-sunken p-2 type-data text-ink">
              {details.command}
            </pre>
          )}
          {details.preview && (
            <div className="flex flex-col gap-1">
              <span className="type-label text-ink-muted">{t('approvalPreview')}</span>
              <pre className="m-0 max-h-32 overflow-auto whitespace-pre-wrap break-all border border-rule-divide bg-sunken p-2 type-data text-ink">
                {details.preview}
              </pre>
            </div>
          )}
        </div>
      )}

      {denying ? (
        <div className="flex flex-col gap-2 px-3 py-2">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('approvalDenyReason')}
            rows={2}
            className="min-h-[48px]"
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setDenying(false)}>
              {t('approvalCancel')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              onClick={() => void respond({ action: 'deny', reason: reason.trim() || undefined })}
            >
              {t('approvalDenyConfirm')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={disabled}
            onClick={() => void respond({ action: 'allow-once' })}
          >
            {t('approvalAllowOnce')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || busy}
            onClick={() => void respond({ action: 'allow-session' })}
          >
            {t('approvalAllowSession')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || busy}
            onClick={() => void respond({ action: 'allow-always' })}
          >
            {t('approvalAllowAlways')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            className="ml-auto"
            disabled={disabled || busy}
            onClick={() => setDenying(true)}
          >
            {t('approvalDeny')}
          </Button>
        </div>
      )}
    </div>
  )
}
