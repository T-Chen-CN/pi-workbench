/**
 * 未结算账本抽屉：这一轮「出去了就收不回来」的动作，到底做没做。
 *
 * 只列还需要人看一眼的（pending / unknown）。三条结论：做了 / 没做 / 不管。
 * 这里不做拦截，也不会重放——它只负责让"我不知道它成没成"这件事有地方落。
 */

import React, { useState } from 'react'
import { Check, HelpCircle, X } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import type { CloudPendingWrite, CloudWriteClass } from '../types/cloud'
import { Button, Caption, DataText, IconButton, Input, Label, Modal } from './ui'
import { formatRelativeTime } from '../utils/relativeTime'

/** 还没结算的才算"待处理" */
export function openWrites(entries: CloudPendingWrite[]): CloudPendingWrite[] {
  return entries.filter((entry) => entry.status === 'pending' || entry.status === 'unknown')
}

const CLASS_LABEL = {
  external: 'cloudLedgerClassExternal',
  system: 'cloudLedgerClassSystem',
  irreversible: 'cloudLedgerClassIrreversible',
} as const satisfies Record<CloudWriteClass, string>

const Row: React.FC<{
  entry: CloudPendingWrite
  busy: boolean
  onResolve: (verdict: 'done' | 'missing' | 'ignored') => void
}> = ({ entry, busy, onResolve }) => {
  const { t, language } = useI18nStore()
  const tone =
    entry.writeClass === 'irreversible'
      ? 'text-danger'
      : entry.writeClass === 'system'
        ? 'text-warning'
        : 'text-ink-muted'
  return (
    <div className="border-b border-rule-divide py-3 last:border-b-0">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <Label className={tone}>{t(CLASS_LABEL[entry.writeClass])}</Label>
        <DataText className="text-ink-muted">{entry.toolName}</DataText>
        <Caption className="text-ink-subtle">
          {formatRelativeTime(entry.startedAt, language)}
        </Caption>
      </div>
      <pre className="m-0 max-h-24 overflow-auto whitespace-pre-wrap break-all bg-raised px-2 py-1 type-caption text-ink">
        {entry.summary}
      </pre>
      <div className="mt-2 flex items-center gap-1.5">
        <Button size="sm" icon={Check} disabled={busy} onClick={() => onResolve('done')}>
          {t('cloudLedgerDidIt')}
        </Button>
        <Button size="sm" icon={X} disabled={busy} onClick={() => onResolve('missing')}>
          {t('cloudLedgerDidNot')}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onResolve('ignored')}>
          {t('cloudLedgerIgnore')}
        </Button>
      </div>
    </div>
  )
}

export const CloudLedgerDrawer: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  const { t } = useI18nStore()
  const entries = useCloudStore((state) => state.pendingWrites)
  const resolveLedger = useCloudStore((state) => state.resolveLedger)
  const noteLedger = useCloudStore((state) => state.noteLedger)
  const ledgerError = useCloudStore((state) => state.ledgerError)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const open_ = openWrites(entries)

  const handleResolve = async (id: string, verdict: 'done' | 'missing' | 'ignored') => {
    setBusy(true)
    await resolveLedger(id, verdict)
    setBusy(false)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('cloudLedgerTitle', { count: open_.length })}
      size="lg"
      footer={
        <span className="flex items-center gap-2">
          <Caption className="text-ink-subtle">{t('cloudLedgerHint')}</Caption>
          <Button size="sm" onClick={onClose}>
            {t('cloudCancel')}
          </Button>
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {open_.length === 0 && (
          <div className="py-4 type-caption text-ink-muted">{t('cloudLedgerEmpty')}</div>
        )}
        {open_.map((entry) => (
          <Row
            key={entry.id}
            entry={entry}
            busy={busy}
            onResolve={(verdict) => void handleResolve(entry.id, verdict)}
          />
        ))}
        {ledgerError && <div className="type-caption text-danger">{ledgerError}</div>}
        <div className="flex items-end gap-2 border-t border-rule-divide pt-3">
          <Input
            value={note}
            placeholder={t('cloudLedgerNotePlaceholder')}
            aria-label={t('cloudLedgerNote')}
            onChange={(event) => setNote(event.target.value)}
          />
          <IconButton
            icon={HelpCircle}
            label={t('cloudLedgerNote')}
            size="sm"
            disabled={!note.trim() || busy}
            onClick={() => {
              const text = note.trim()
              setNote('')
              void noteLedger(text)
            }}
          />
        </div>
      </div>
    </Modal>
  )
}
