/**
 * 交接文件导入的预览框。
 *
 * 两段式：主进程 `pick` 只回脱敏预览，这里确认后才 `apply`（只传一次性 nonce）。
 * 密钥永远只有掩码；控制台口令只能「复制」，明文不进渲染层。
 *
 * 解析失败时没有预览，但错误也要看得见 —— 所以这个框在有 error 时同样打开。
 */

import React from 'react'
import { AlertCircle, Check, Copy, FileWarning, Upload } from 'lucide-react'
import type { TranslationKey } from '../i18n/translations'
import { useCloudStore } from '../store/cloudStore'
import { confirmDialog } from '../store/dialogStore'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
import type { CloudHandoffChecks } from '../types/cloud'
import { Button, Caption, DataText, Label, Modal } from './ui'

const MetaRow: React.FC<{ label: string; value: string }> = ({ label, value }) =>
  value ? (
    <div className="flex items-baseline justify-between gap-3">
      <Caption className="flex-shrink-0 text-ink-muted">{label}</Caption>
      <DataText className="min-w-0 truncate text-ink">{value}</DataText>
    </div>
  ) : null

type CheckState = 'ok' | 'fail' | 'unknown'

const CHECK_TONE: Record<CheckState, string> = {
  ok: 'text-success',
  fail: 'text-danger',
  unknown: 'text-ink-subtle',
}

function checkRows(checks: CloudHandoffChecks, t: (key: TranslationKey) => string) {
  const rows: Array<{ label: string; state: CheckState; detail: string }> = [
    {
      label: t('cloudImportCheckDns'),
      state: checks.dnsOk === null ? 'unknown' : checks.dnsOk ? 'ok' : 'fail',
      detail: '',
    },
    {
      label: t('cloudImportCheckGateway'),
      state:
        checks.gatewayHttp === null
          ? 'unknown'
          : checks.gatewayHttp === 200
            ? 'ok'
            : 'fail',
      detail: checks.gatewayHttp === null ? '' : `HTTP ${checks.gatewayHttp}`,
    },
    {
      label: t('cloudImportCheckUpstream'),
      state:
        checks.upstreamOk === null ? 'unknown' : checks.upstreamOk ? 'ok' : 'fail',
      detail: '',
    },
    {
      label: t('cloudImportCheckAdminKey'),
      state:
        checks.adminKeyConfigured === null
          ? 'unknown'
          : checks.adminKeyConfigured
            ? 'ok'
            : 'fail',
      detail: '',
    },
    {
      label: t('cloudImportCheckDashboard'),
      state:
        checks.dashboardHttp === null
          ? 'unknown'
          : checks.dashboardHttp >= 200 && checks.dashboardHttp < 400
            ? 'ok'
            : 'fail',
      detail: checks.dashboardHttp === null ? '' : `HTTP ${checks.dashboardHttp}`,
    },
    {
      label: t('cloudImportCheckTls'),
      state: checks.tlsNotAfter ? 'ok' : 'unknown',
      detail: checks.tlsNotAfter ?? '',
    },
  ]
  return rows
}

export const CloudHandoffDialog: React.FC<{ active: boolean }> = ({ active }) => {
  const { t } = useI18nStore()
  const preview = useCloudStore((state) => state.handoffPreview)
  const busy = useCloudStore((state) => state.handoffBusy)
  const error = useCloudStore((state) => state.handoffError)
  const applyHandoff = useCloudStore((state) => state.applyHandoff)
  const copyHandoffSecret = useCloudStore((state) => state.copyHandoffSecret)
  const clearHandoffPreview = useCloudStore((state) => state.clearHandoffPreview)

  // 页面被切走时连同弹窗一起藏起来（状态留着，切回来还能继续）
  if (!active || (!preview && !error)) return null

  /** 原因码 → 文案；没有对应词条时回落到原文（主进程已给中文） */
  const translateCode = (code: string): string => {
    const key = `cloudHandoffErr_${code}` as TranslationKey
    const text = t(key)
    return text === key ? code : text
  }

  const handleApply = async () => {
    if (!preview) return
    if (preview.willOverwrite) {
      const ok = await confirmDialog({
        title: t('cloudImportConfirm'),
        message: t('cloudImportOverwriteConfirm'),
        confirmLabel: t('cloudImportConfirm'),
        cancelLabel: t('cloudImportCancel'),
        danger: true,
      })
      if (!ok) return
    }
    const applied = await applyHandoff()
    if (!applied) return
    const file = preview.fileName
    toast.success(t('cloudImportSuccess'))
    toast.info(t('cloudImportDeleteHint', { file }), 10_000)
  }

  const handleCopy = async () => {
    const ok = await copyHandoffSecret()
    if (ok) toast.success(t('cloudImportCopied'))
    else toast.error(t('cloudImportCopyFailed', { error: '—' }))
  }

  const checks = preview ? checkRows(preview.checks, t) : []
  const severe = Boolean(preview?.warnings.some((warning) => warning.code === 'gateway_not_ok'))

  return (
    <Modal
      open
      onClose={clearHandoffPreview}
      title={t('cloudImportTitle')}
      size="sm"
      closeLabel={t('close')}
      footer={
        <>
          <Button size="sm" onClick={clearHandoffPreview} disabled={busy === 'apply'}>
            {preview ? t('cloudImportCancel') : t('close')}
          </Button>
          {preview && (
            <Button
              size="sm"
              variant="primary"
              icon={Upload}
              loading={busy === 'apply'}
              onClick={() => void handleApply()}
            >
              {t('cloudImportConfirm')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        {preview && (
          <>
            {severe && (
              <div className="flex items-start gap-2 border border-danger/30 bg-danger/10 px-2.5 py-2">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0 text-danger" />
                <div className="type-caption text-danger">
                  {t('cloudHandoffWarn_gateway_not_ok', {
                    detail: String(preview.checks.gatewayHttp ?? '—'),
                  })}
                </div>
              </div>
            )}

            {preview.willOverwrite && (
              <div className="flex items-start gap-2 border border-warning/30 bg-warning/10 px-2.5 py-2">
                <FileWarning size={13} className="mt-0.5 flex-shrink-0 text-warning" />
                <div className="type-caption text-ink-muted">{t('cloudImportOverwrite')}</div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <MetaRow label={t('cloudImportSource')} value={preview.fileName} />
              <MetaRow label={t('cloudImportProfile')} value={preview.profile} />
              <MetaRow label={t('cloudImportVersion')} value={preview.hermesVersion} />
              <MetaRow label={t('cloudImportGeneratedAt')} value={preview.generatedAt} />
            </div>

            <div className="flex flex-col gap-1.5 border-t border-rule-divide pt-3">
              <MetaRow label={t('cloudGatewayUrl')} value={preview.gatewayUrl} />
              <div className="flex items-baseline justify-between gap-3">
                <Caption className="flex-shrink-0 text-ink-muted">
                  {t('cloudGatewayAdminKey')}
                </Caption>
                <DataText className="min-w-0 truncate text-ink">
                  {preview.hasAdminKey ? preview.adminKeyMask : t('cloudImportNoAdminKey')}
                </DataText>
              </div>
              <MetaRow label={t('cloudImportDashboardUrl')} value={preview.dashboardUrl} />
              <div className="flex items-baseline justify-between gap-3">
                <Caption className="flex-shrink-0 text-ink-muted">
                  {t('cloudImportDashboardAccount')}
                </Caption>
                <span className="flex min-w-0 items-center gap-2">
                  <DataText className="min-w-0 truncate text-ink">
                    {preview.dashboardUser || '—'}
                  </DataText>
                  {preview.hasDashboardPassword && (
                    <Button size="sm" icon={Copy} onClick={() => void handleCopy()}>
                      {t('cloudImportCopyPassword')}
                    </Button>
                  )}
                </span>
              </div>
              <Caption className="text-ink-subtle">
                {preview.hasAdminKey
                  ? t('cloudImportAdminKeyStored')
                  : t('cloudImportAdminKeyManual')}
              </Caption>
            </div>

            <div className="flex flex-col gap-1.5 border-t border-rule-divide pt-3">
              <Label className="text-ink-muted">{t('cloudImportChecks')}</Label>
              {checks.map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-3">
                  <Caption className="flex items-center gap-1.5 text-ink-muted">
                    {row.state === 'ok' ? (
                      <Check size={11} className="text-success" />
                    ) : row.state === 'fail' ? (
                      <AlertCircle size={11} className="text-danger" />
                    ) : null}
                    {row.label}
                  </Caption>
                  <DataText className={CHECK_TONE[row.state]}>
                    {row.state === 'unknown'
                      ? t('cloudImportCheckUnknown')
                      : row.detail || t('cloudImportCheckOk')}
                  </DataText>
                </div>
              ))}
            </div>

            {(preview.warnings.length > 0 || preview.ignored.length > 0) && (
              <div className="flex flex-col gap-1 border-t border-rule-divide pt-3">
                <Label className="text-ink-muted">{t('cloudImportWarnings')}</Label>
                {preview.warnings.map((warning) => {
                  const key = `cloudHandoffWarn_${warning.code}` as TranslationKey
                  const text = t(key, { detail: warning.detail ?? '' })
                  return (
                    <Caption
                      key={`${warning.code}:${warning.detail ?? ''}`}
                      className="text-ink-subtle"
                    >
                      {text === key ? warning.code : text}
                    </Caption>
                  )
                })}
                {preview.ignored.length > 0 && (
                  <Caption className="text-ink-subtle">
                    {t('cloudImportIgnored', { count: preview.ignored.length })}
                  </Caption>
                )}
              </div>
            )}
          </>
        )}

        {error && (
          <div className="border border-danger/30 bg-danger/10 px-2.5 py-2">
            <Label className="text-danger">{t('cloudImportFailed')}</Label>
            <p className="m-0 mt-1 whitespace-pre-wrap break-words type-data text-danger">
              {translateCode(error)}
            </p>
          </div>
        )}
      </div>
    </Modal>
  )
}
