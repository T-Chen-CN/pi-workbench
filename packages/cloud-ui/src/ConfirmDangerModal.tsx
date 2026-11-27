import React from 'react'
import { translate, type Language } from '@pi-workbench/i18n'
import { Button, Modal } from '@pi-workbench/ui'

export interface CloudConfirmDangerModalProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  busy?: boolean
  language?: Language
  onCancel: () => void
  onConfirm: () => Promise<void> | void
}

export const CloudConfirmDangerModal: React.FC<CloudConfirmDangerModalProps> = ({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  language = 'zh',
  onCancel,
  onConfirm,
}) => (
  <Modal
    open={open}
    onClose={() => {
      if (!busy) onCancel()
    }}
    title={title}
    size="sm"
    closeLabel={translate(language, 'close')}
    footer={
      <>
        <Button variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
          {translate(language, 'cancel')}
        </Button>
        <Button
          variant="danger"
          size="sm"
          loading={busy}
          disabled={busy}
          onClick={() => void onConfirm()}
        >
          {confirmLabel}
        </Button>
      </>
    }
  >
    <div className="px-5 py-4">
      <p className="m-0 whitespace-pre-wrap break-words type-body text-ink">{description}</p>
    </div>
  </Modal>
)
