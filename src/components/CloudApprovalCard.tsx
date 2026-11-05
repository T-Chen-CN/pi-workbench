/**
 * 审批卡：服务端在动手前停下来问一句「这条命令能不能跑」。
 *
 * 四个状态：
 * - 待决（可点三个按钮，带倒计时）
 * - 已决（显示我们点了什么）
 * - 已结算但没我们的决定（超时 / 别的客户端批的）——不能假装是我们批的
 * - 已过期（倒计时归零 / 这一轮已结束）：按钮全部禁用
 *
 * 为什么没有「永久允许」：那会写进服务端白名单（S-08 禁止），映射层就已经剔掉，
 * 这里拿到的 `choices` 里不存在 `always`。
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Loader2, ShieldAlert, Timer } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import type { CloudApprovalChoice, CloudTracePart } from '../types/cloud'
import { Button, Caption, DataText } from './ui'

type ApprovalPart = Extract<CloudTracePart, { type: 'approval' }>

const CHOICE_LABEL = {
  once: 'cloudApprovalOnce',
  session: 'cloudApprovalSession',
  deny: 'cloudApprovalDeny',
} as const satisfies Record<CloudApprovalChoice, string>

/** 倒计时：每秒重算剩余秒数；归零时本地置灰（服务端那一侧由它自己超时） */
function useCountdown(part: ApprovalPart, active: boolean): number | null {
  const expire = useCloudStore((state) => state.expireApproval)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || typeof part.expiresAt !== 'number') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, part.expiresAt])

  return useMemo(() => {
    if (typeof part.expiresAt !== 'number') return null
    const remaining = Math.max(0, Math.ceil((part.expiresAt - now) / 1000))
    if (remaining === 0 && active) expire(part.requestId)
    return remaining
  }, [part.expiresAt, part.requestId, now, active, expire])
}

export const CloudApprovalCard: React.FC<{ part: ApprovalPart }> = ({ part }) => {
  const { t } = useI18nStore()
  const respond = useCloudStore((state) => state.respondApproval)
  const pending = useCloudStore((state) => state.approvalPending === part.requestId)
  const error = useCloudStore((state) => state.approvalError)
  const [expanded, setExpanded] = useState(false)

  const expired = part.expiredAt !== undefined || part.settled === true
  const waiting = !part.decision && !expired
  const remaining = useCountdown(part, waiting)
  const overTime = remaining !== null && remaining <= 0

  const command = part.command.trim()
  const long = command.length > 160 || command.includes('\n')

  return (
    <div className="border border-rule-hairline bg-raised px-2 py-2">
      <div className="flex items-start gap-1.5">
        <ShieldAlert size={12} className="mt-0.5 flex-shrink-0 text-warning" />
        <Caption className="min-w-0 flex-1 text-ink-muted">
          {waiting ? t('cloudApprovalTitle') : t('cloudApprovalSettledTitle')}
        </Caption>
        {waiting && pending && <Loader2 size={12} className="animate-spin text-ink-subtle" />}
        {waiting && remaining !== null && (
          <span className="flex flex-shrink-0 items-center gap-1">
            <Timer size={10} className="text-ink-subtle" />
            <Caption className={overTime ? 'text-danger' : 'text-ink-subtle'}>
              {overTime ? t('cloudApprovalExpired') : t('cloudApprovalTimeout', { seconds: remaining })}
            </Caption>
          </span>
        )}
      </div>

      {command && (
        <div className="mt-1.5 border border-rule-hairline bg-surface px-2 py-1.5">
          <DataText
            className={`block whitespace-pre-wrap break-all text-ink ${
              expanded ? '' : 'max-h-24 overflow-hidden'
            }`}
          >
            {command}
          </DataText>
          {long && (
            <button
              type="button"
              className="mt-1 type-caption text-accent hover:underline"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? t('cloudApprovalCollapse') : t('cloudApprovalExpand')}
            </button>
          )}
        </div>
      )}

      {part.patternKeys.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <Caption className="text-ink-subtle">{t('cloudApprovalMatched')}</Caption>
          {part.patternKeys.map((key) => (
            <Caption
              key={key}
              className="border border-rule-hairline px-1 text-ink-muted"
            >
              {key}
            </Caption>
          ))}
        </div>
      )}

      {waiting && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {/* 默认拒绝：三个按钮都是显式动作，回车不会触发任何一项 */}
          {part.choices.map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant={choice === 'once' ? 'primary' : choice === 'deny' ? 'danger' : 'secondary'}
              disabled={pending || overTime}
              onClick={() => void respond(part.requestId, choice)}
            >
              {t(CHOICE_LABEL[choice])}
            </Button>
          ))}
          {overTime && (
            <Caption className="text-ink-subtle">{t('cloudApprovalTooLate')}</Caption>
          )}
        </div>
      )}

      {part.decision && (
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <Caption className="text-ink-subtle">{t('cloudApprovalYouChose')}</Caption>
          <DataText
            className={part.decision === 'deny' ? 'text-danger' : 'text-ink'}
          >
            {t(CHOICE_LABEL[part.decision])}
          </DataText>
        </div>
      )}

      {!part.decision && expired && (
        <div className="mt-1.5 type-caption text-ink-subtle">
          {part.settled ? t('cloudApprovalSettledElsewhere') : t('cloudApprovalExpiredBody')}
        </div>
      )}

      {error && !pending && <div className="mt-1.5 type-caption text-danger">{error}</div>}
    </div>
  )
}
