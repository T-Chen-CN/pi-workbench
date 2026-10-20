import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react'
import { api } from '../api'
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

const FLEET_STATUS_TONES: Record<FleetTaskStatus, string> = {
  queued: 'text-ink-subtle',
  running: 'text-accent',
  succeeded: 'text-success',
  failed: 'text-danger',
  cancelled: 'text-warning',
}

const workspaceName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="min-w-0">
    <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-ink-subtle">{label}</div>
    <div className="mt-1 truncate font-mono text-[10.5px] text-ink" title={value}>
      {value}
    </div>
  </div>
)

const QuickAction: React.FC<{ icon: LucideIcon; label: string; onClick: () => void }> = ({
  icon: Icon,
  label,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex items-center gap-1.5 border-b border-line pb-0.5 font-mono text-[9.5px] text-ink-muted transition-colors hover:border-ink hover:text-ink"
  >
    <Icon size={11} />
    {label}
  </button>
)

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
            <p
              className={
                isChinese
                  ? 'm-0 font-mono text-[9.5px] uppercase tracking-[0.16em] text-accent'
                  : 'm-0 font-reading text-[11px] tracking-[0.12em] text-accent'
              }
            >
              {t('welcomeEyebrow')}
            </p>

            <h1 className="mb-2 mt-[11px] font-display text-[37px] font-normal leading-[1.18] tracking-[-0.01em] text-ink">
              <span className="block">{t('welcomeHeadlineA')}</span>
              <span className="block">
                {t('welcomeHeadlineB')}
                <span className="text-accent">{t('welcomeHeadlineAccent')}</span>
              </span>
            </h1>

            <p className="m-0 max-w-[520px] font-reading text-[13.5px] leading-[1.75] text-ink-muted">
              {t('welcomeLede')}
            </p>

            <div className="mt-[23px] flex min-h-0 flex-1 flex-col">
              <div className="flex flex-none items-baseline justify-between gap-4 border-b border-line pb-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-subtle">
                  {t('welcomeRecent')}
                  <span className="ml-2.5 font-mono text-[9px] normal-case tracking-normal text-ink-subtle">
                    {t('welcomeProjectCount', { count: filteredWorkspaces.length })}
                  </span>
                </span>

                <div className="flex h-6 w-[180px] flex-shrink-0 items-center gap-1.5 border border-line bg-panel px-2">
                  <Search size={11} className="flex-shrink-0 text-ink-subtle" aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('welcomeSearch')}
                    aria-label={t('welcomeSearch')}
                    className="min-w-0 flex-1 bg-transparent font-mono text-[9px] text-ink placeholder:text-ink-subtle focus:outline-none"
                  />
                </div>
              </div>

              <div
                data-testid="welcome-recent-list"
                className="min-h-0 flex-1 overflow-y-auto pr-1.5"
              >
                {recentWorkspaces.length === 0 ? (
                  <button
                    type="button"
                    onClick={onOpenProject}
                    className="w-full border-b border-line py-4 text-left font-mono text-[10.5px] text-ink-subtle transition-colors hover:text-ink"
                  >
                    {t('welcomeNoRecent')}
                  </button>
                ) : filteredWorkspaces.length === 0 ? (
                  <p className="m-0 py-4 font-mono text-[10.5px] text-ink-subtle">
                    {t('welcomeNoMatch')}
                  </p>
                ) : (
                  filteredWorkspaces.map((path, index) => (
                    <button
                      key={path}
                      type="button"
                      onClick={() => onOpenWorkspace(path)}
                      className="group flex w-full items-center gap-3 border-b border-line py-2.5 text-left transition-colors hover:bg-hover"
                    >
                      <Folder
                        size={14}
                        className="flex-shrink-0 text-ink-subtle"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-display text-[17px] leading-[1.2] text-ink transition-colors group-hover:text-accent">
                          {workspaceName(path)}
                        </span>
                        <span className="block truncate font-mono text-[9px] text-ink-subtle">
                          {path}
                        </span>
                      </span>
                      {index === 0 && !query.trim() && (
                        <span className="flex-shrink-0 font-mono text-[8px] uppercase tracking-[0.08em] text-accent">
                          {t('welcomeRecentLatest')}
                        </span>
                      )}
                      <ArrowUpRight
                        size={12}
                        className="flex-shrink-0 text-ink-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                        aria-hidden="true"
                      />
                    </button>
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
            <div className="border border-line bg-panel p-3.5">
              <div className="flex items-center justify-between border-b border-line pb-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-muted">
                  {t('welcomeAgentLabel')}
                </span>
                <span
                  className={`flex items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-[0.08em] ${
                    apiReady ? 'text-success' : 'text-warning'
                  }`}
                >
                  <span
                    className={`h-1 w-1 rounded-full ${
                      apiReady ? 'bg-success' : 'bg-warning'
                    }`}
                  />
                  {apiReady ? t('welcomeAgentLive') : t('welcomeApiMissing')}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-3 pt-3">
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
              </div>
            </div>

            <div className="border border-line bg-panel p-3.5">
              <div className="flex items-center justify-between gap-3 border-b border-line pb-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-muted">
                  {t('welcomeContinue')}
                </span>
              </div>

              {latestWorkspace ? (
                <div className="pt-3">
                  <p className="m-0 truncate font-display text-[18px] leading-[1.25] text-ink">
                    {latestName}
                  </p>
                  <p className="m-0 mt-1 truncate font-mono text-[9px] text-ink-subtle">
                    {latestWorkspace}
                  </p>
                  <button
                    type="button"
                    onClick={() => onOpenWorkspace(latestWorkspace)}
                    className="mt-3 inline-flex h-7 items-center gap-1.5 border border-line px-2.5 font-mono text-[9px] text-ink-muted transition-colors hover:border-accent hover:text-accent"
                  >
                    {t('welcomeOpenWorkspace')}
                    <ArrowRight size={11} aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onOpenProject}
                  className="w-full pt-3 text-left font-mono text-[10.5px] text-ink-subtle transition-colors hover:text-ink"
                >
                  {t('welcomeNoRecent')}
                </button>
              )}
            </div>

            <div className="border border-line bg-panel p-3.5">
              <div className="flex items-center justify-between border-b border-line pb-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-muted">
                  {t('welcomeFleet')}
                </span>
                {runningTasks > 0 && (
                  <span className="font-mono text-[8.5px] text-ink-subtle">
                    {t('welcomeFleetRunning', { count: runningTasks })}
                  </span>
                )}
              </div>

              {fleetTasks.length === 0 ? (
                <p className="m-0 pt-2.5 font-mono text-[9.5px] text-ink-subtle">
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
                      <span
                        className={`w-[54px] flex-shrink-0 font-mono text-[8px] uppercase tracking-[0.06em] ${FLEET_STATUS_TONES[task.status]}`}
                      >
                        ● {t(FLEET_STATUS_KEYS[task.status])}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[10.5px] text-ink">
                        {task.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="border border-line bg-panel p-3.5">
              <div className="flex items-center justify-between border-b border-line pb-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-muted">
                  {t('welcomeGettingStarted')}
                </span>
                <span className="font-mono text-[8.5px] text-ink-subtle">
                  {completedSteps} / {steps.length}
                </span>
              </div>

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
                      className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center border font-mono text-[8px] ${
                        step.done
                          ? 'border-accent text-accent'
                          : 'border-line-strong text-ink-subtle'
                      }`}
                    >
                      {step.done ? <Check size={10} strokeWidth={2.5} aria-hidden="true" /> : index + 1}
                    </span>
                    <span
                      className={`text-[10.5px] ${
                        step.done ? 'text-ink' : 'text-ink-muted'
                      }`}
                    >
                      {step.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-auto self-end border-[1.5px] border-accent px-3 py-1.5 text-center font-mono text-[9px] tracking-[0.16em] text-accent [transform:rotate(-2deg)]">
              {t('welcomeStampTitle')}
              <span className="mt-0.5 block text-[7px] tracking-[0.22em]">
                {t('welcomeStampSubtitle')}
              </span>
            </div>
          </aside>
        </div>
      </div>
    </main>
  )
}
