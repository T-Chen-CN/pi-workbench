import React, { useEffect, useState } from 'react'
import { useDialogStore } from '../store/dialogStore'
import { useI18nStore } from '../store/i18nStore'
import { Button, Input, Modal } from './ui'

/**
 * 全局确认/输入/提示对话框，替代 window.confirm / window.prompt / window.alert。
 * 每个宿主窗口各挂一份，只渲染属于自己窗口的那一个。
 */
export const DialogHost: React.FC<{ host?: string }> = ({ host = 'main' }) => {
  const current = useDialogStore((state) => (state.currentHost === host ? state.current : null))
  const close = useDialogStore((state) => state.close)
  const { t } = useI18nStore()
  const [value, setValue] = useState('')

  useEffect(() => {
    if (current?.kind === 'prompt') {
      setValue(current.options.defaultValue ?? '')
    }
  }, [current])

  if (!current) return null

  const { kind, options } = current
  const isAlert = kind === 'alert'
  const isConfirm = kind === 'confirm'
  const danger = kind === 'confirm' && Boolean(options.danger)

  const cancel = () => close(isConfirm ? false : null)
  const confirm = () => close(isConfirm ? true : value)

  return (
    <Modal
      open
      onClose={cancel}
      title={options.title ?? t('confirm')}
      size="sm"
      closeLabel={t('close')}
      footer={
        isAlert ? (
          <Button variant="primary" onClick={cancel} autoFocus>
            {options.confirmLabel ?? t('dialogGotIt')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={cancel} autoFocus={isConfirm}>
              {options.cancelLabel ?? t('cancel')}
            </Button>
            <Button variant={danger ? 'danger' : 'primary'} onClick={confirm}>
              {options.confirmLabel ?? t('confirm')}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {options.message && (
          <p className="m-0 type-reading text-ink-muted">
            {options.message}
          </p>
        )}
        {kind === 'prompt' && (
          <Input
            autoFocus
            value={value}
            placeholder={options.placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                confirm()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancel()
              }
            }}
          />
        )}
      </div>
    </Modal>
  )
}
