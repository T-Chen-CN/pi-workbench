/**
 * 自检面板：连接页里的折叠区块。
 *
 * 四块只读事实 —— 版本与健康检查 / 工具集 / 技能 / 模型。
 * 每块独立成败：某个接口在服务器上 500 时，其它三块照常显示，而且 500 本身
 * 就是最有价值的那条信息。
 */

import React, { useState } from 'react'
import { AlertCircle, Check, ChevronRight, RefreshCw } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useCloudStore } from '../store/cloudStore'
import { Caption, DataText, Label, Spinner } from './ui'
import { Card } from './patterns'

const Section: React.FC<{
  title: string
  ok?: boolean
  error?: string
  count?: number
  children?: React.ReactNode
}> = ({ title, ok, error, count, children }) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-center gap-1.5">
      {ok === undefined ? null : ok ? (
        <Check size={11} className="flex-shrink-0 text-success" />
      ) : (
        <AlertCircle size={11} className="flex-shrink-0 text-danger" />
      )}
      <Label className="text-ink-muted">{title}</Label>
      {typeof count === 'number' && (
        <Caption className="text-ink-subtle">{String(count)}</Caption>
      )}
    </div>
    {error && <div className="type-caption text-danger">{error}</div>}
    {children}
  </div>
)

const Row: React.FC<{ name: string; value: string; tone?: string }> = ({ name, value, tone }) => (
  <div className="flex items-baseline justify-between gap-3">
    <Caption className="min-w-0 truncate text-ink-muted">{name}</Caption>
    <DataText className={`flex-shrink-0 ${tone ?? 'text-ink'}`}>{value}</DataText>
  </div>
)

export const CloudDiagnosticsPanel: React.FC<{ connected: boolean }> = ({ connected }) => {
  const { t } = useI18nStore()
  const diagnostics = useCloudStore((state) => state.diagnostics)
  const loading = useCloudStore((state) => state.diagnosticsLoading)
  const error = useCloudStore((state) => state.diagnosticsError)
  const loadDiagnostics = useCloudStore((state) => state.loadDiagnostics)
  const [open, setOpen] = useState(false)

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && connected && !diagnostics && !loading) void loadDiagnostics()
  }

  const refresh = () => {
    if (connected && !loading) void loadDiagnostics()
  }

  return (
    <Card>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            size={12}
            className={`flex-shrink-0 text-ink-subtle transition-transform ${
              open ? 'rotate-90' : ''
            }`}
          />
          <span className="type-label text-ink">{t('cloudDiagnostics')}</span>
          {diagnostics && (
            <Caption className="text-ink-subtle">
              {diagnostics.version ? `v${diagnostics.version}` : t('cloudDiagnosticsFetched')}
            </Caption>
          )}
        </button>
        {open && (
          <button
            type="button"
            aria-label={t('cloudDiagnosticsRefresh')}
            disabled={!connected || loading}
            onClick={refresh}
            className="flex-shrink-0 text-ink-subtle hover:text-ink disabled:opacity-40"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-3">
          {!connected && (
            <Caption className="text-ink-subtle">{t('cloudDiagnosticsNeedsConnection')}</Caption>
          )}
          {connected && loading && !diagnostics && (
            <div className="flex items-center gap-2">
              <Spinner size={12} />
              <Caption className="text-ink-subtle">{t('cloudDiagnosticsLoading')}</Caption>
            </div>
          )}
          {error && <div className="type-caption text-danger">{error}</div>}

          {diagnostics && (
            <>
              <Section
                title={t('cloudDiagnosticsHealth')}
                ok={diagnostics.readiness.ok}
                error={diagnostics.readiness.error}
              >
                <div className="flex flex-col gap-1">
                  {diagnostics.gatewayState && (
                    <Row name={t('cloudDiagnosticsGateway')} value={diagnostics.gatewayState} />
                  )}
                  {diagnostics.platform && (
                    <Row name={t('cloudDiagnosticsPlatform')} value={diagnostics.platform} />
                  )}
                  {diagnostics.readiness.checks.map((check) => (
                    <Row
                      key={check.name}
                      name={check.detail ? `${check.name} · ${check.detail}` : check.name}
                      value={check.status}
                      tone={check.status === 'ok' ? 'text-ink' : 'text-danger'}
                    />
                  ))}
                </div>
              </Section>

              <Section
                title={t('cloudDiagnosticsToolsets')}
                ok={diagnostics.toolsets.ok}
                error={diagnostics.toolsets.error}
                count={diagnostics.toolsets.ok ? diagnostics.toolsets.items.length : undefined}
              >
                <div className="flex flex-col gap-1">
                  {diagnostics.toolsets.items.map((toolset) => {
                    // enabled = 开关；configured = 依赖有没有装好，两件事分开看
                    const trouble = !toolset.enabled || !toolset.configured
                    return (
                      <Row
                        key={toolset.name}
                        name={
                          toolset.enabled
                            ? toolset.name
                            : `${toolset.name} · ${t('cloudDiagnosticsDisabled')}`
                        }
                        value={
                          toolset.configured
                            ? String(toolset.tools.length)
                            : t('cloudDiagnosticsNotConfigured')
                        }
                        tone={trouble ? 'text-warning' : 'text-ink'}
                      />
                    )
                  })}
                </div>
              </Section>

              <Section
                title={t('cloudDiagnosticsSkills')}
                ok={diagnostics.skills.ok}
                error={diagnostics.skills.error}
                count={diagnostics.skills.ok ? diagnostics.skills.names.length : undefined}
              >
                {diagnostics.skills.ok && diagnostics.skills.names.length > 0 && (
                  <Caption className="text-ink-muted">
                    {diagnostics.skills.names.slice(0, 12).join(' · ')}
                  </Caption>
                )}
              </Section>

              <Section
                title={t('cloudDiagnosticsModels')}
                ok={diagnostics.models.ok}
                error={diagnostics.models.error}
                count={diagnostics.models.ok ? diagnostics.models.items.length : undefined}
              >
                {diagnostics.models.ok && (
                  <Caption className="text-ink-muted">
                    {diagnostics.models.items.join(' · ')}
                  </Caption>
                )}
              </Section>
            </>
          )}
        </div>
      )}
    </Card>
  )
}
