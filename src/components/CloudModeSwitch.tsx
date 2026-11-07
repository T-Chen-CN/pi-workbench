/**
 * 审批档位控件：直接读写服务端原生 `approvals.mode`。
 *
 * 只有三档，因为 Hermes 的粒度只到这里（没有按工具 / 按命令的中间档）：
 * - `manual` 询问我 —— 命中危险模式就停下来问；
 * - `smart`  自动判断 —— 模型自己决定问不问（判断不可复现，**没有审计**，因此标注不推荐）；
 * - `off`    完全不问 —— 与 `/yolo` 等价，必须二次确认才切。
 *
 * 显示值永远来自服务端读回（写后复核），本地不记忆「我以为现在是哪档」。
 */

import React, { useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, ShieldOff } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import type { CloudApprovalMode } from '../types/cloud'
import { Button, Caption, Modal, Spinner } from './ui'

const TIERS: Array<{
  mode: CloudApprovalMode
  labelKey: 'cloudModeManual' | 'cloudModeSmart' | 'cloudModeOff'
  hintKey:
    | 'cloudModeManualHint'
    | 'cloudModeSmartHint'
    | 'cloudModeOffHint'
  icon: typeof ShieldCheck
}> = [
  { mode: 'manual', labelKey: 'cloudModeManual', hintKey: 'cloudModeManualHint', icon: ShieldCheck },
  { mode: 'smart', labelKey: 'cloudModeSmart', hintKey: 'cloudModeSmartHint', icon: ShieldAlert },
  { mode: 'off', labelKey: 'cloudModeOff', hintKey: 'cloudModeOffHint', icon: ShieldOff },
]

export const CloudModeSwitch: React.FC<{ disabled?: boolean }> = ({ disabled = false }) => {
  const { t } = useI18nStore()
  const policy = useCloudStore((state) => state.policy)
  const loading = useCloudStore((state) => state.policyLoading)
  const pending = useCloudStore((state) => state.policyPending)
  const error = useCloudStore((state) => state.policyError)
  const loadPolicy = useCloudStore((state) => state.loadPolicy)
  const setMode = useCloudStore((state) => state.setMode)
  const [confirmOff, setConfirmOff] = useState(false)

  // 只在「已连接」时才读档位：配对之前读只会拿到一条「这台设备还没有配对」，
  // 而那条错误不会自己消失（组件不重新挂载），配对成功后卡片就一直挂着红字。
  // 所以等 connected 由 false 变 true 再读——顺带覆盖「断开后重连」。
  useEffect(() => {
    if (disabled) return
    void loadPolicy()
  }, [disabled, loadPolicy])

  const current = policy?.mode ?? null
  const choose = (mode: CloudApprovalMode) => {
    if (disabled || pending || mode === current) return
    // 放松闸门要二次确认；收紧是一键
    if (mode === 'off') {
      setConfirmOff(true)
      return
    }
    void setMode(mode)
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Caption className="flex-shrink-0 text-ink-subtle">{t('cloudModeLabel')}</Caption>
      <div
        role="group"
        aria-label={t('cloudModeLabel')}
        className="flex items-center overflow-hidden border border-rule-control"
      >
        {TIERS.map((tier) => {
          const active = current === tier.mode
          const Icon = tier.icon
          return (
            <button
              key={tier.mode}
              type="button"
              aria-pressed={active}
              title={t(tier.hintKey)}
              disabled={disabled || loading || pending !== null}
              onClick={() => choose(tier.mode)}
              className={`flex h-6 items-center gap-1 border-l border-rule-hairline px-1.5 type-caption transition-colors first:border-l-0 disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                  ? tier.mode === 'off'
                    ? 'bg-danger/10 text-danger'
                    : 'bg-accent/10 text-accent'
                  : 'text-ink-muted hover:bg-hover hover:text-ink'
              }`}
            >
              {pending === tier.mode ? (
                <Spinner size={10} />
              ) : (
                <Icon size={10} className="flex-shrink-0" />
              )}
              {t(tier.labelKey)}
            </button>
          )
        })}
      </div>
      {loading && <Spinner size={10} />}
      {/* 未知档位：服务端给了我们没见过的值（例如被别的运维改过），不猜、不覆盖；
          有错误时只说错误（“重启 dev”比“档位未知”可行动） */}
      {!loading && current === null && !error && (
        <Caption className="text-ink-subtle">{t('cloudModeUnknown')}</Caption>
      )}
      {policy && current === 'off' && (
        <Caption className="flex-shrink-0 text-danger">{t('cloudModeOffWarn')}</Caption>
      )}
      {/* 未连接时不显示读写错误：那句“去连接页配对”在已配对的世界里是纯噪音 */}
      {!disabled && error && (
        <Caption className="min-w-0 truncate text-danger" title={error}>
          {error}
        </Caption>
      )}

      <Modal
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title={t('cloudModeOffConfirmTitle')}
        size="sm"
        closeLabel={t('cloudCancel')}
        footer={
          <>
            <Button size="sm" onClick={() => setConfirmOff(false)}>
              {t('cloudCancel')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={ShieldOff}
              onClick={() => {
                setConfirmOff(false)
                void setMode('off')
              }}
            >
              {t('cloudModeOffConfirmAction')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 px-5 py-4">
          <p className="m-0 type-value text-ink">{t('cloudModeOffConfirmBody')}</p>
          <Caption className="text-ink-muted">{t('cloudModeOffConfirmDetail')}</Caption>
        </div>
      </Modal>
    </div>
  )
}
