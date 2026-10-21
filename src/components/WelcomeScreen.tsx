import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Folder,
  FolderOpen,
  RefreshCw,
  Settings as SettingsIcon,
} from 'lucide-react'
import { api } from '../api'
import {
  Card,
  CardHeader,
  ListRow,
  QuickAction,
  SearchField,
  SectionHeader,
  Stat,
  StatGrid,
  StatusText,
  type StatusTone,
} from './patterns'
import { Caption, DataText, Eyebrow, Label, Value } from './ui'
import { useI18nStore } from '../store/i18nStore'
import type { ApiConfig, FleetTask, FleetTaskStatus } from '../types/electron'

interface WelcomeScreenProps {
  recentWorkspaces: string[]
  onOpenProject: () => void
  onOpenWorkspace: (path: string) => void
  onOpenSettings: () => void
  onRefreshRecent: () => void
}

const FLEET_STATUS_KEYS: Record<
  FleetTaskStatus,
  'fleetQueued' | 'fleetRunning' | 'fleetSucceeded' | 'fleetFailed' | 'fleetCancelled'
> = {
  queued: 'fleetQueued',
  running: 'fleetRunning',
  succeeded: 'fleetSucceeded',
  failed: 'fleetFailed',
  cancelled: 'fleetCancelled',
}

const FLEET_STATUS_TONES: Record<FleetTaskStatus, StatusTone> = {
  queued: 'muted',
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'warning',
}

const workspaceName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  recentWorkspaces,
  onOpenProject,
  onOpenWorkspace,
  onOpenSettings,
  onRefreshRecent,
}) => {
  const { t, language } = useI18nStore()
  const [query, setQuery] = useState('')
  const [apiConfig, setApiConfig] = useState<ApiConfig | null>(null)
  const [fleetTasks, setFleetTasks] = useState<FleetTask[]>([])

  useEffect(() => {
    let cancelled = false

    const loadConfig = async () => {
      try {
        const result = await api.apiConfigGet()
        if (!cancelled && result.success) setApiConfig(result.config ?? null)
      } catch (error) {
        console.error('[WelcomeScreen] Failed to load API config:', error)
        if (!cancelled) setApiConfig(null)
      }
    }

    void loadConfig()
    const handleConfigSaved = () => void loadConfig()
    window.addEventListener('api-config-saved', handleConfigSaved)

    return () => {
      cancelled = true
      window.removeEventListener('api-config-saved', handleConfigSaved)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadFleet = async () => {
      if (recentWorkspaces.length === 0) {
        if (!cancelled) setFleetTasks([])
        return
      }

      try {
        const results = await Promise.all(
          recentWorkspaces.slice(0, 6).map((path) => api.fleetList(path))
        )
        if (cancelled) return
        const tasks = results.flatMap((result) => (result.success ? result.tasks : []))
        tasks.sort((a, b) => b.updatedAt - a.updatedAt)
        setFleetTasks(tasks)
      } catch (error) {
        console.error('[WelcomeScreen] Failed to load Fleet tasks:', error)
        if (!cancelled) setFleetTasks([])
      }
    }

    void loadFleet()
    const timer = window.setInterval(() => void loadFleet(), 5000)
    const unsubscribe = api.onFleetTaskUpdated(() => void loadFleet())

    return () => {
      cancelled = true
      window.clearInterval(timer)
      unsubscribe()
    }
  }, [recentWorkspaces])

  const filteredWorkspaces = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return recentWorkspaces
    return recentWorkspaces.filter(
      (path) =>
        workspaceName(path).toLowerCase().includes(needle) ||
        path.toLowerCase().includes(needle)
    )
  }, [recentWorkspaces, query])

  const latestWorkspace = recentWorkspaces[0]
  const latestName = latestWorkspace ? workspaceName(latestWorkspace) : ''
  const apiReady = Boolean(
    apiConfig?.apiUrl && apiConfig.apiKey && apiConfig.selectedModel
  )
  const model = apiConfig?.selectedModel?.trim() || t('welcomeModelUnset')
  const runningTasks = fleetTasks.filter(
    (task) => task.status === 'queued' || task.status === 'running'
  ).length

  const steps = [
    { label: t('welcomeStepApi'), done: apiReady, action: onOpenSettings },
    {
      label: t('welcomeStepProject'),
      done: recentWorkspaces.length > 0,
      action: onOpenProject,
    },
  ]
  const completedSteps = steps.filter((step) => step.done).length
  const isChinese = language === 'zh'

  return (
    <main className="paper-noise relative flex min-h-0 flex-1 overflow-hidden">
      <div className="relative mx-auto flex min-h-0 w-full max-w-[1360px] flex-1 flex-col px-10 pb-[18px] pt-[26px]">
        <div className="grid min-h-0 flex-1 grid-cols-[1.14fr_0.86fr] gap-[38px]">
          <section className="flex min-h-0 min-w-0 flex-col">
            {isChinese ? (
              <Eyebrow className="m-0 text-accent">{t('welcomeEyebrow')}</Eyebrow>
            ) : (
              <p className="m-0 type-eyebrow-cjk text-accent">{t('welcomeEyebrow')}</p>
            )}

            <h1 className="mb-2 mt-[11px] type-display text-ink">
              <span className="block">{t('welcomeHeadlineA')}</span>
              <span className="block">
                {t('welcomeHeadlineB')}
                <span className="text-accent">{t('welcomeHeadlineAccent')}</span>
              </span>
            </h1>

            <p className="m-0 max-w-[560px] type-reading text-ink-muted">
              {t('welcomeLede')}
            </p>

            <div className="mt-[23px] flex min-h-0 flex-1 flex-col">
              <SectionHeader
                title={t('welcomeRecent')}
                count={t('welcomeProjectCount', { count: filteredWorkspaces.length })}
                action={
                  <SearchField
                    value={query}
                    onChange={setQuery}
                    placeholder={t('welcomeSearch')}
                    ariaLabel={t('welcomeSearch')}
                    className="w-[200px]"
                  />
                }
              />

              <div
                data-testid="welcome-recent-list"
                className="min-h-0 flex-1 overflow-y-auto pr-1.5"
              >
                {recentWorkspaces.length === 0 ? (
                  <button
                    type="button"
                    onClick={onOpenProject}
                    className="w-full border-b border-line py-4 text-left type-value text-ink-muted transition-colors hover:text-ink"
                  >
                    {t('welcomeNoRecent')}
                  </button>
                ) : filteredWorkspaces.length === 0 ? (
                  <p className="m-0 py-4 type-value text-ink-muted">
                    {t('welcomeNoMatch')}
                  </p>
                ) : (
                  filteredWorkspaces.map((path, index) => (
                    <ListRow
                      key={path}
                      icon={Folder}
                      title={workspaceName(path)}
                      subtitle={path}
                      titleAttr={path}
                      titleVariant="project"
                      onClick={() => onOpenWorkspace(path)}
                      trailing={
                        <>
                          {index === 0 && !query.trim() && (
                            <Label className="flex-shrink-0 text-accent">
                              {t('welcomeRecentLatest')}
                            </Label>
                          )}
                          <ArrowUpRight
                            size={12}
                            className="flex-shrink-0 text-ink-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                            aria-hidden="true"
                          />
                        </>
                      }
                    />
                  ))
                )}
              </div>

              <div className="flex flex-none items-center gap-5 border-t border-line pt-2.5">
                <QuickAction
                  icon={FolderOpen}
                  label={t('welcomeQuickOpen')}
                  onClick={onOpenProject}
                />
                <QuickAction
                  icon={RefreshCw}
                  label={t('welcomeQuickRefresh')}
                  onClick={onRefreshRecent}
                />
                <QuickAction
                  icon={SettingsIcon}
                  label={t('welcomeQuickSettings')}
                  onClick={onOpenSettings}
                />
              </div>
            </div>
          </section>

          <aside className="flex min-h-0 min-w-0 flex-col gap-3">
            <Card>
              <CardHeader
                title={t('welcomeAgentLabel')}
                status={
                  <StatusText tone={apiReady ? 'success' : 'warning'} dot>
                    {apiReady ? t('welcomeAgentLive') : t('welcomeApiMissing')}
                  </StatusText>
                }
              />
              <StatGrid className="pt-3">
                <Stat label={t('welcomeModel')} value={model} />
                <Stat
                  label={t('welcomeApi')}
                  value={
                    apiReady ? t('welcomeApiConfigured') : t('welcomeApiNotConfigured')
                  }
                />
                <Stat
                  label={t('welcomeProjects')}
                  value={String(recentWorkspaces.length)}
                />
                <Stat label={t('welcomeBackend')} value={t('welcomeLocal')} />
              </StatGrid>
            </Card>

            <Card>
              <CardHeader title={t('welcomeContinue')} />

              {latestWorkspace ? (
                <div className="pt-3">
                  <p className="m-0 truncate type-project text-ink">{latestName}</p>
                  <DataText className="m-0 mt-1 block truncate text-ink-muted">
                    {latestWorkspace}
                  </DataText>
                  <button
                    type="button"
                    onClick={() => onOpenWorkspace(latestWorkspace)}
                    className="mt-3 inline-flex h-7 items-center gap-1.5 border border-line px-2.5 type-label text-ink-muted transition-colors hover:border-accent hover:text-accent"
                  >
                    {t('welcomeOpenWorkspace')}
                    <ArrowRight size={11} aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onOpenProject}
                  className="w-full pt-3 text-left type-value text-ink-muted transition-colors hover:text-ink"
                >
                  {t('welcomeNoRecent')}
                </button>
              )}
            </Card>

            <Card>
              <CardHeader
                title={t('welcomeFleet')}
                status={
                  runningTasks > 0 ? (
                    <Caption className="text-ink-muted">
                      {t('welcomeFleetRunning', { count: runningTasks })}
                    </Caption>
                  ) : undefined
                }
              />

              {fleetTasks.length === 0 ? (
                <p className="m-0 pt-2.5 type-value text-ink-muted">
                  {t('welcomeFleetEmpty')}
                </p>
              ) : (
                <div className="pt-1">
                  {fleetTasks.slice(0, 2).map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      title={task.prompt}
                      onClick={() => onOpenWorkspace(task.workspace)}
                      className="flex w-full items-center gap-2.5 border-b border-line py-1.5 text-left last:border-b-0"
                    >
                      <StatusText
                        tone={FLEET_STATUS_TONES[task.status]}
                        className="w-[64px] flex-shrink-0"
                      >
                        {t(FLEET_STATUS_KEYS[task.status])}
                      </StatusText>
                      <Value className="min-w-0 flex-1 truncate text-ink">
                        {task.name}
                      </Value>
                    </button>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <CardHeader
                title={t('welcomeGettingStarted')}
                status={
                  <Caption className="text-ink-muted">
                    {completedSteps} / {steps.length}
                  </Caption>
                }
              />

              <div className="pt-2">
                {steps.map((step, index) => (
                  <button
                    key={step.label}
                    type="button"
                    disabled={step.done}
                    onClick={step.action}
                    className="flex w-full items-center gap-2 py-1.5 text-left disabled:cursor-default"
                  >
                    <span
                      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center border type-caption ${
                        step.done
                          ? 'border-accent text-accent'
                          : 'border-line text-ink-muted'
                      }`}
                    >
                      {step.done ? <Check size={10} strokeWidth={2.5} aria-hidden="true" /> : index + 1}
                    </span>
                    <span
                      className={`type-value ${
                        step.done ? 'text-ink' : 'text-ink-muted'
                      }`}
                    >
                      {step.label}
                    </span>
                  </button>
                ))}
              </div>
            </Card>

            <div className="mt-auto self-end border-[1.5px] border-accent px-3 py-1.5 text-center type-stamp text-accent [transform:rotate(-2deg)]">
              {t('welcomeStampTitle')}
              <span className="mt-0.5 block type-stamp-sub">
                {t('welcomeStampSubtitle')}
              </span>
            </div>
          </aside>
        </div>
      </div>
    </main>
  )
}
