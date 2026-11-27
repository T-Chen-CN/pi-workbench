import React, { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { translate, type Language } from '@pi-workbench/i18n'
import { Button, Caption, Card, CardHeader, DataText, StatusText } from '@pi-workbench/ui'
import { CloudConfirmDangerModal } from './ConfirmDangerModal'
import { formatCloudTime } from './format'
import type { CloudDeviceRow } from './types'

export interface CloudPairCode {
  code: string
  expiresAt: number
}

export interface CloudDeviceListProps {
  devices: CloudDeviceRow[]
  language?: Language
  showCount?: boolean
  /** 展示设备 ID、各工作区清单（含非 git 标记）；桌面端紧凑侧栏可关闭只显示工作区数 */
  showDetails?: boolean
  pairCode?: CloudPairCode | null
  onGeneratePairCode?: () => Promise<void> | void
  onRemoveDevice?: (deviceId: string) => Promise<void> | void
  emptyLabel?: string
  onlineTone?: 'accent' | 'success'
}

/**
 * 桌面端 CloudView 与云端 Web 共用的已配对设备清单与一次性配对码生成卡片。
 */
export const CloudDeviceList: React.FC<CloudDeviceListProps> = ({
  devices,
  language = 'zh',
  showCount = false,
  showDetails = true,
  pairCode = null,
  onGeneratePairCode,
  onRemoveDevice,
  emptyLabel,
  onlineTone = 'success',
}) => {
  const [generating, setGenerating] = useState(false)
  const [copiedCode, setCopiedCode] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<CloudDeviceRow | null>(null)
  const [removing, setRemoving] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setCopiedCode(false)
  }, [pairCode?.code])

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    },
    []
  )

  const handleCopyPairCode = async () => {
    if (!pairCode?.code || !navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(pairCode.code)
      setCopiedCode(true)
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopiedCode(false), 1800)
    } catch {
      // 忽略无剪贴板权限时的失败
    }
  }

  return (
    <Card density="compact">
      <CardHeader
        title={translate(language, 'cloudDevices')}
        status={showCount ? <Caption className="text-ink-muted">{devices.length}</Caption> : undefined}
      />
      {devices.length === 0 ? (
        <Caption className="mt-2 block text-ink-muted">
          {emptyLabel ?? translate(language, 'cloudWebNoDevices')}
        </Caption>
      ) : (
        <ul className="m-0 mt-2 flex list-none flex-col gap-2.5 p-0">
          {devices.map((device) => (
            <li
              key={device.id}
              className={
                showDetails
                  ? 'flex flex-col gap-1 border-b border-rule-divide pb-2 last:border-b-0 last:pb-0'
                  : 'flex flex-col gap-0.5'
              }
            >
              <div className="flex items-center justify-between gap-2">
                <StatusText tone={device.online ? onlineTone : 'muted'} dot>
                  {device.name}
                </StatusText>
                <DataText className="flex-shrink-0 text-ink-muted">{device.platform}</DataText>
              </div>
              {showDetails ? (
                <>
                  <DataText className="truncate text-ink-muted">{device.id}</DataText>
                  {(device.workspaces || []).length > 0 && (
                    <div className="flex flex-col gap-0.5">
                      {device.workspaces.map((ws) => (
                        <DataText key={ws.path} className="truncate text-ink-muted">
                          {ws.name}
                          {ws.isGit ? '' : translate(language, 'cloudWebNonGitWorkspace')}
                        </DataText>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <Caption className="text-ink-muted">
                  {translate(language, 'cloudWorkspaceCount', { count: device.workspaces.length })}
                </Caption>
              )}
              {onRemoveDevice && (
                <div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger hover:bg-danger/10 hover:text-danger"
                    onClick={() => setPendingRemove(device)}
                  >
                    {translate(language, 'cloudWebRemoveDevice')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {onGeneratePairCode && (
        <div className="mt-3 flex flex-col gap-2 border-t border-rule-divide pt-3">
          <div>
            <Button
              variant="primary"
              size="sm"
              disabled={generating}
              onClick={async () => {
                setGenerating(true)
                try {
                  await onGeneratePairCode()
                } finally {
                  setGenerating(false)
                }
              }}
            >
              {translate(language, 'cloudWebGeneratePairCode')}
            </Button>
          </div>
          {pairCode ? (
            <div className="flex flex-col gap-1 border border-rule-hairline bg-sunken px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="type-title text-accent">{pairCode.code}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleCopyPairCode()}
                  aria-label={translate(language, 'cloudWebCopyPairCode')}
                >
                  {copiedCode ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                  {copiedCode ? translate(language, 'copied') : translate(language, 'copyCode')}
                </Button>
              </div>
              <Caption className="text-ink-muted">
                {translate(language, 'cloudWebPairCodeExpires', {
                  time: formatCloudTime(pairCode.expiresAt, true),
                })}
              </Caption>
              <Caption className="text-ink-muted">
                {translate(language, 'cloudWebPairCodeUsageHint')}
              </Caption>
            </div>
          ) : (
            <Caption className="text-ink-muted">
              {translate(language, 'cloudWebPairCodeEmptyHint')}
            </Caption>
          )}
        </div>
      )}

      {onRemoveDevice && (
        <CloudConfirmDangerModal
          open={Boolean(pendingRemove)}
          language={language}
          title={translate(language, 'cloudWebRemoveDeviceTitle')}
          description={
            pendingRemove
              ? translate(language, 'cloudWebRemoveDeviceConfirm', {
                  name: pendingRemove.name,
                  id: pendingRemove.id,
                })
              : ''
          }
          confirmLabel={translate(language, 'cloudWebRemoveDeviceConfirmAction')}
          busy={removing}
          onCancel={() => setPendingRemove(null)}
          onConfirm={async () => {
            if (!pendingRemove || removing) return
            setRemoving(true)
            try {
              await onRemoveDevice(pendingRemove.id)
              setPendingRemove(null)
            } finally {
              setRemoving(false)
            }
          }}
        />
      )}
    </Card>
  )
}
