/**
 * clarify 提问卡：Agent 在轮次中途停下来问一句。
 *
 * 三种状态：待答（按钮选项 + 自由回答）、已答（显示答案）、已结算但没我们的答案
 * （超时 / 别的客户端答的）——最后一种不能假装是我们答的。
 */

import React, { useState } from 'react'
import { HelpCircle, Loader2, Timer } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import type { CloudTracePart } from '../types/cloud'
import { Button, Caption, DataText, Input } from './ui'

type ClarifyPart = Extract<CloudTracePart, { type: 'clarify' }>

export const CloudClarifyCard: React.FC<{ part: ClarifyPart }> = ({ part }) => {
  const { t } = useI18nStore()
  const respond = useCloudStore((state) => state.respondClarify)
  const pending = useCloudStore((state) => state.clarifyPending === part.promptId)
  const error = useCloudStore((state) => state.clarifyError)
  const [answer, setAnswer] = useState('')

  const answered = Boolean(part.answer)
  const waiting = !part.settled && !answered
  const submit = (text: string) => {
    const value = text.trim()
    if (!value || pending) return
    setAnswer('')
    void respond(part.promptId, value)
  }

  return (
    <div className="border border-rule-hairline bg-raised px-2 py-2">
      <div className="flex items-start gap-1.5">
        <HelpCircle size={12} className="mt-0.5 flex-shrink-0 text-accent" />
        <DataText className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">
          {part.question}
        </DataText>
        {waiting && pending && <Loader2 size={12} className="animate-spin text-ink-subtle" />}
      </div>

      {part.choices.length > 0 && waiting && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {part.choices.map((choice) => (
            <Button
              key={choice}
              size="sm"
              disabled={pending}
              onClick={() => submit(choice)}
            >
              {choice}
            </Button>
          ))}
        </div>
      )}

      {waiting && (
        <div className="mt-2 flex items-center gap-1.5">
          {/* 选项之外永远可以自己写：clarify 的答案是自由文本 */}
          <Input
            value={answer}
            placeholder={t('cloudClarifyPlaceholder')}
            aria-label={t('cloudClarifyAnswer')}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit(answer)
              }
            }}
          />
          <Button size="sm" disabled={pending || !answer.trim()} onClick={() => submit(answer)}>
            {t('cloudClarifySubmit')}
          </Button>
        </div>
      )}

      {answered && (
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <Caption className="text-ink-subtle">{t('cloudClarifyAnswered')}</Caption>
          <DataText className="min-w-0 break-words text-ink">{part.answer}</DataText>
        </div>
      )}

      {!answered && part.settled && (
        <div className="mt-1.5 type-caption text-ink-subtle">{t('cloudClarifySettledElsewhere')}</div>
      )}

      {typeof part.timeoutSeconds === 'number' && part.timeoutSeconds > 0 && waiting && (
        <div className="mt-1.5 flex items-center gap-1">
          <Timer size={10} className="flex-shrink-0 text-ink-subtle" />
          <Caption className="text-ink-subtle">
            {t('cloudClarifyTimeout', { seconds: part.timeoutSeconds })}
          </Caption>
        </div>
      )}

      {error && !pending && <div className="mt-1.5 type-caption text-danger">{error}</div>}
    </div>
  )
}
