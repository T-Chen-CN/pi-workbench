import React, { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { api } from '../api'
import { localizeError } from '../i18n/errors'
import { confirmDialog } from '../store/dialogStore'
import { useI18nStore } from '../store/i18nStore'
import { useSessionStore } from '../store/sessionStore'
import { toast } from '../store/toastStore'
import { shouldShowUpdatePrompt, useUpdaterStore } from '../store/updaterStore'
import { Button, Modal } from './ui'

/**
 * 更新已下载后的安装弹窗。
 * 用户选择“稍后”后本次运行不再提示，下次启动会重新检查并再次弹出。
 */
export const UpdateDialog: React.FC = () => {
  const { t } = useI18nStore()
  const open = useUpdaterStore(shouldShowUpdatePrompt)
  const state = useUpdaterStore((store) => store.state)
  const deferPrompt = useUpdaterStore((store) => store.deferPrompt)
  const [installing, setInstalling] = useState(false)

  const handleLater = () => {
    if (installing) return
    deferPrompt(state.version)
  }

  const handleInstall = async () => {
    if (installing) return
    setInstalling(true)
    try {
      // Agent 流式输出或终端仍在运行时，先让用户确认
      const streaming = Object.keys(useSessionStore.getState().streaming).length > 0
      const work = await api.appHasActiveWork().catch(() => null)
      const busy = streaming || Boolean(work?.terminal)
      if (busy) {
        const confirmed = await confirmDialog({
          message: t('updateBusyConfirm'),
          danger: true,
        })
        if (!confirmed) {
          setInstalling(false)
          return
        }
      }

      const result = await api.updateInstall()
      if (!result.success) {
        toast.error(
          t('updateInstallFailed', {
            error: localizeError(result.error) || t('unknownError'),
          })
        )
        setInstalling(false)
      }
      // 成功时应用会退出并启动安装器，保持 loading 直到进程结束
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('updateInstallFailed', { error: localizeError(message) || t('unknownError') }))
      setInstalling(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleLater}
      title={t('updateReadyTitle')}
      size="sm"
      closeLabel={t('close')}
      footer={
        <>
          <Button size="sm" onClick={handleLater} disabled={installing}>
            {t('updateLater')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={RotateCcw}
            loading={installing}
            onClick={() => void handleInstall()}
          >
            {t('restartToInstall')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-5">
        <p className="m-0 type-reading text-ink">
          {installing
            ? t('updateInstalling')
            : t('updateReadyBody', { version: state.version ?? '' })}
        </p>
        {state.releaseNotes && (
          <div className="flex flex-col gap-1.5">
            <span className="type-label text-ink-muted">{t('updateNotes')}</span>
            <div className="max-h-48 overflow-y-auto whitespace-pre-wrap border border-rule-hairline bg-sunken p-2.5 type-caption text-ink-muted">
              {state.releaseNotes}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
