import React, { useEffect, useState } from 'react'
import {
  ExternalLink,
  GitPullRequest,
  Globe,
  Info,
  KeyRound,
  Keyboard,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react'
import { useI18nStore } from '../../store/i18nStore'
import { useThemeStore, type ThemeMode } from '../../store/themeStore'
import {
  isPermissionLevel,
  useSettingsStore,
  clampAutoSaveDelay,
  MIN_AUTO_SAVE_DELAY,
  MAX_AUTO_SAVE_DELAY,
  type NotificationPrefs,
  type RunWhileBusy,
} from '../../store/settingsStore'
import { useUpdaterStore } from '../../store/updaterStore'
import { api } from '../../api'
import { persistAppSettings } from '../../utils/persistSettings'
import { toast } from '../../store/toastStore'
import { localizeError } from '../../i18n/errors'
import type { AppInfo, PermissionLevel } from '../../types/electron'
import { Button, Field, Input, Select } from '../ui/ui'
import { GithubSettings } from './GithubSettings'
import { WebSearchSettings } from './WebSearchSettings'
import { KeyCap, LegendRow, Meter } from '../ui/patterns'
import { ProviderSettings } from './ProviderSettings'
import {
  SESSION_MODE_DESCRIPTION_KEY,
  SESSION_MODE_ICON,
  SESSION_MODE_ICON_CLASS,
  SESSION_MODE_LABEL_KEY,
  SESSION_MODE_ORDER,
} from '../../utils/sessionModePresentation'
import {
  DEFAULT_KEYBINDINGS,
  eventToShortcut,
  findConflict,
  formatShortcut,
  isMacPlatform,
  shortcutTokens,
  type ShortcutId,
} from '../../utils/keybindings'

export type SettingsSection =
  | 'general'
  | 'api'
  | 'websearch'
  | 'github'
  | 'permissions'
  | 'shortcuts'
  | 'about'

const ShortcutKeys: React.FC<{ keys: string[] }> = ({ keys }) => (
  <span className="flex flex-shrink-0 items-center gap-1 type-key text-ink-muted">
    {keys.map((key, index) => (
      <React.Fragment key={`${key}-${index}`}>
        {index > 0 && <span className="text-ink-muted">+</span>}
        <KeyCap>{key}</KeyCap>
      </React.Fragment>
    ))}
  </span>
)

interface SettingsProps {
  onClose?: () => void
  initialSection?: SettingsSection
}

export const Settings: React.FC<SettingsProps> = ({ initialSection = 'general' }) => {
  const { language, setLanguage, t } = useI18nStore()
  const { mode, setMode } = useThemeStore()
  const {
    autoSave,
    autoSaveDelay,
    permissionLevel,
    notifications,
    budgetUsd,
    runWhileBusy,
    keybindings,
    closeToTray,
    autoInstallWorktreeDeps,
    useSystemProxy,
    setAutoSave,
    setAutoSaveDelay,
    setPermissionLevel,
    setNotificationPrefs,
    setBudgetUsd,
    setRunWhileBusy,
    setCloseToTray,
    setAutoInstallWorktreeDeps,
    setUseSystemProxy,
    setKeybinding,
    resetKeybindings,
  } = useSettingsStore()
  const [capturingShortcut, setCapturingShortcut] = useState<ShortcutId | null>(null)
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [budgetDraft, setBudgetDraft] = useState(() => String(budgetUsd))
  const isMac = isMacPlatform()
  const mod = isMac ? '⌘' : 'Ctrl'
  const shift = isMac ? '⇧' : 'Shift'
  const alt = isMac ? '⌥' : 'Alt'

  useEffect(() => {
    setBudgetDraft(String(budgetUsd))
  }, [budgetUsd])

  const update = useUpdaterStore((store) => store.state)
  const applyUpdateState = useUpdaterStore((store) => store.applyState)
  const requestInstallPrompt = useUpdaterStore((store) => store.requestPrompt)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    api
      .appGetInfo()
      .then((result) => {
        if (result.success) setAppInfo(result.info)
      })
      .catch((error) => console.error('[Settings] Failed to load app info:', error))
  }, [])

  const handleCheckUpdate = async () => {
    try {
      const result = await api.updateCheck()
      applyUpdateState(result.state)
      if (!result.success) {
        toast.error(
          t('updateFailed', { error: localizeError(result.error) || t('unknownError') })
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('updateFailed', { error: localizeError(message) || t('unknownError') }))
    }
  }

  const handleDownloadUpdate = async () => {
    const result = await api.updateDownload()
    if (!result.success) {
      toast.error(
        t('updateFailed', { error: localizeError(result.error) || t('unknownError') })
      )
    }
  }

  const handleOpenDownload = async () => {
    const result = await api.updateOpenDownload()
    if (!result.success) {
      toast.error(
        t('updateFailed', { error: localizeError(result.error) || t('unknownError') })
      )
    }
  }

  const updateStatusText = (() => {
    switch (update.status) {
      case 'unsupported':
        return t('updateUnsupported')
      case 'checking':
        return t('checkingUpdates')
      case 'available':
        return t('updateAvailable', { version: update.version ?? '' })
      case 'downloading':
        return t('updateDownloading', { percent: update.percent ?? 0 })
      case 'downloaded':
        return t('updateDownloaded')
      case 'not-available':
        return t('updateLatest')
      case 'error':
        return t('updateFailed', { error: localizeError(update.message) || t('unknownError') })
      default:
        return ''
    }
  })()

  const handleLanguageChange = (next: 'zh' | 'en') => {
    setLanguage(next)
    void persistAppSettings({ language: next })
  }

  const handleThemeChange = (next: ThemeMode) => {
    setMode(next)
    void persistAppSettings({ theme: next })
  }

  const handleAutoSaveChange = (enabled: boolean) => {
    setAutoSave(enabled)
    void persistAppSettings({ autoSave: enabled })
  }

  const handleAutoSaveDelayChange = (delayMs: number) => {
    const next = clampAutoSaveDelay(delayMs)
    setAutoSaveDelay(next)
    void persistAppSettings({ autoSaveDelay: next })
  }

  const handlePermissionLevelChange = (level: string) => {
    if (!isPermissionLevel(level)) return
    setPermissionLevel(level)
    void persistAppSettings({ permissionLevel: level })
  }

  const handleNotificationChange = (patch: Partial<NotificationPrefs>) => {
    const next = { ...notifications, ...patch }
    setNotificationPrefs(patch)
    void persistAppSettings({ notifications: next })
  }

  const commitBudgetDraft = (raw: string) => {
    const trimmed = raw.trim()
    const parsed = trimmed === '' ? 0 : Number(trimmed)
    const next = Number.isFinite(parsed) ? Math.max(0, parsed) : budgetUsd
    setBudgetDraft(String(next))
    if (next === budgetUsd) return
    setBudgetUsd(next)
    void persistAppSettings({ budgetUsd: next })
  }

  const handleRunWhileBusyChange = (value: string) => {
    const next: RunWhileBusy = value === 'steer' ? 'steer' : 'queue'
    setRunWhileBusy(next)
    void persistAppSettings({ runWhileBusy: next })
  }

  const handleCloseToTrayChange = (enabled: boolean) => {
    setCloseToTray(enabled)
    void persistAppSettings({ closeToTray: enabled })
  }

  const handleAutoInstallDepsChange = (enabled: boolean) => {
    setAutoInstallWorktreeDeps(enabled)
    void persistAppSettings({ autoInstallWorktreeDeps: enabled })
  }

  const handleUseSystemProxyChange = (enabled: boolean) => {
    setUseSystemProxy(enabled)
    void persistAppSettings({ useSystemProxy: enabled })
  }

  const shortcutName = (id: ShortcutId) =>
    id === 'commandPalette' ? t('shortcutCommandPalette') : t('shortcutSettings')

  // 捕获新的快捷键；Esc 取消，冲突时提示且不写入
  useEffect(() => {
    if (!capturingShortcut) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setCapturingShortcut(null)
        return
      }
      const combo = eventToShortcut(event)
      if (!combo) return
      const conflict = findConflict(keybindings, combo, capturingShortcut)
      if (conflict) {
        toast.error(t('shortcutConflict', { name: shortcutName(conflict) }))
        return
      }
      const next = { ...keybindings, [capturingShortcut]: combo }
      setKeybinding(capturingShortcut, combo)
      void persistAppSettings({ keybindings: next })
      setCapturingShortcut(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturingShortcut, keybindings])

  const handleResetShortcuts = () => {
    resetKeybindings()
    void persistAppSettings({ keybindings: DEFAULT_KEYBINDINGS })
  }

  const navItems: Array<{ id: SettingsSection; label: string; icon: typeof Info }> = [
    { id: 'general', label: t('general'), icon: SlidersHorizontal },
    { id: 'api', label: t('providerConfiguration'), icon: KeyRound },
    { id: 'websearch', label: t('webSearch'), icon: Globe },
    { id: 'github', label: t('githubIntegration'), icon: GitPullRequest },
    { id: 'permissions', label: t('permissions'), icon: ShieldCheck },
    { id: 'shortcuts', label: t('shortcuts'), icon: Keyboard },
    { id: 'about', label: t('about'), icon: Info },
  ]

  const shortcutGroups: Array<{
    title: string
    items: Array<{ label: string; keys: string[]; note?: string }>
  }> = [
    {
      title: t('shortcutGroupGeneral'),
      items: [
        {
          label: t('shortcutCommandPalette'),
          keys: shortcutTokens(keybindings.commandPalette, isMac),
          note: t('shortcutCommandPaletteNote'),
        },
        { label: t('shortcutSettings'), keys: shortcutTokens(keybindings.settings, isMac) },
        { label: t('shortcutReload'), keys: [mod, 'R'] },
        {
          label: t('shortcutDevTools'),
          keys: isMac ? [mod, alt, 'I'] : ['Ctrl', 'Shift', 'I'],
        },
        { label: t('shortcutCloseWindow'), keys: [mod, 'W'] },
      ],
    },
    {
      title: t('shortcutGroupEditor'),
      items: [
        { label: t('shortcutSave'), keys: [mod, 'S'] },
        { label: t('shortcutUndo'), keys: [mod, 'Z'] },
        { label: t('shortcutRedo'), keys: [mod, shift, 'Z'] },
        { label: t('shortcutFind'), keys: [mod, 'F'] },
      ],
    },
    {
      title: t('shortcutGroupChat'),
      items: [
        { label: t('shortcutSend'), keys: ['Enter'] },
        { label: t('shortcutNewline'), keys: [shift, 'Enter'] },
      ],
    },
    {
      title: t('shortcutGroupOverlays'),
      items: [{ label: t('shortcutCloseOverlay'), keys: ['Esc'] }],
    },
  ]

  return (
    <div className="flex min-h-[420px]">
      {/* Section nav */}
      <nav className="w-40 flex-shrink-0 border-r border-rule-divide bg-surface p-2">
        <div className="flex flex-col gap-0.5">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              className={`flex items-center gap-2 border-l-2 px-2.5 py-1.5 text-left type-label transition-colors ${
                section === id
                  ? 'border-accent bg-accent/[0.06] text-ink'
                  : 'border-transparent text-ink-muted hover:bg-hover hover:text-ink'
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        {section === 'general' && (
          <div className="flex max-w-sm flex-col gap-5">
            <Field label={t('language')} htmlFor="settings-language">
              <Select
                id="settings-language"
                value={language}
                onChange={(e) => handleLanguageChange(e.target.value as 'zh' | 'en')}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </Select>
            </Field>

            <Field label={t('theme')} htmlFor="settings-theme">
              <Select
                id="settings-theme"
                value={mode}
                onChange={(e) => handleThemeChange(e.target.value as ThemeMode)}
              >
                <option value="system">{t('themeSystem')}</option>
                <option value="dark">{t('themeDark')}</option>
                <option value="light">{t('themeLight')}</option>
              </Select>
            </Field>

            <Field label={t('autoSave')} hint={t('autoSaveHint')}>
              <label className="flex h-8 items-center gap-2 type-value text-ink">
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-[rgb(var(--accent))]"
                  checked={autoSave}
                  onChange={(event) => handleAutoSaveChange(event.target.checked)}
                />
                {autoSave ? t('autoSaveEnabled') : t('autoSaveDisabled')}
              </label>
            </Field>

            <Field label={t('autoSaveDelay')} htmlFor="settings-autosave-delay">
              <Select
                id="settings-autosave-delay"
                value={String(autoSaveDelay)}
                disabled={!autoSave}
                onChange={(event) => handleAutoSaveDelayChange(Number(event.target.value))}
              >
                {[MIN_AUTO_SAVE_DELAY, 1000, 2000, 3000, 5000, MAX_AUTO_SAVE_DELAY].map((delay) => (
                  <option key={delay} value={delay}>
                    {delay >= 1000 ? `${delay / 1000} s` : `${delay} ms`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('runWhileBusy')} hint={t('runWhileBusyHint')} htmlFor="settings-run-while-busy">
              <Select
                id="settings-run-while-busy"
                value={runWhileBusy}
                onChange={(event) => handleRunWhileBusyChange(event.target.value)}
              >
                <option value="queue">{t('runWhileBusyQueue')}</option>
                <option value="steer">{t('runWhileBusySteer')}</option>
              </Select>
            </Field>

            <Field label={t('budgetUsd')} hint={t('budgetUsdHint')} htmlFor="settings-budget-usd">
              <Input
                id="settings-budget-usd"
                type="number"
                min={0}
                step={0.5}
                value={budgetDraft}
                onChange={(event) => setBudgetDraft(event.target.value)}
                onBlur={() => commitBudgetDraft(budgetDraft)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.nativeEvent.isComposing &&
                    event.keyCode !== 229
                  ) {
                    commitBudgetDraft(budgetDraft)
                    event.currentTarget.blur()
                  }
                }}
              />
            </Field>

            <Field label={t('notifications')} hint={t('notificationsHint')}>
              <div className="flex flex-col gap-2 type-value text-ink">
                {([
                  { key: 'enabled' as const, label: t('notificationsEnabled') },
                  { key: 'approval' as const, label: t('notifyOnApproval') },
                  { key: 'complete' as const, label: t('notifyOnComplete') },
                  { key: 'error' as const, label: t('notifyOnError') },
                ]).map(({ key, label }) => {
                  const disabled = key !== 'enabled' && !notifications.enabled
                  return (
                    <label
                      key={key}
                      className={`flex items-center gap-2 ${disabled ? 'opacity-40' : ''}`}
                    >
                      <input
                        type="checkbox"
                        className="h-3 w-3 accent-[rgb(var(--accent))]"
                        checked={notifications[key]}
                        disabled={disabled}
                        onChange={(event) =>
                          handleNotificationChange({
                            [key]: event.target.checked,
                          } as Partial<NotificationPrefs>)
                        }
                      />
                      {label}
                    </label>
                  )
                })}
              </div>
            </Field>

            <Field label={t('closeToTray')} hint={t('closeToTrayHint')}>
              <label className="flex h-8 items-center gap-2 type-value text-ink">
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-[rgb(var(--accent))]"
                  checked={closeToTray}
                  onChange={(event) => handleCloseToTrayChange(event.target.checked)}
                />
                {closeToTray ? t('closeToTrayOn') : t('closeToTrayOff')}
              </label>
            </Field>

            <Field label={t('autoInstallWorktreeDeps')} hint={t('autoInstallWorktreeDepsHint')}>
              <label className="flex h-8 items-center gap-2 type-value text-ink">
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-[rgb(var(--accent))]"
                  checked={autoInstallWorktreeDeps}
                  onChange={(event) => handleAutoInstallDepsChange(event.target.checked)}
                />
                {autoInstallWorktreeDeps
                  ? t('autoInstallWorktreeDepsOn')
                  : t('autoInstallWorktreeDepsOff')}
              </label>
            </Field>

            <Field
              label={t('useSystemProxy')}
              hint={t('useSystemProxyHint')}
              htmlFor="use-system-proxy"
            >
              <label className="flex h-8 items-center gap-2 type-value text-ink">
                <input
                  id="use-system-proxy"
                  type="checkbox"
                  className="h-3 w-3 accent-[rgb(var(--accent))]"
                  checked={useSystemProxy}
                  onChange={(event) => handleUseSystemProxyChange(event.target.checked)}
                />
                {useSystemProxy ? t('useSystemProxyOn') : t('useSystemProxyOff')}
              </label>
            </Field>
          </div>
        )}

        {section === 'github' && <GithubSettings />}

        {section === 'websearch' && <WebSearchSettings />}

        {section === 'api' && <ProviderSettings />}

        {section === 'permissions' && (
          <div className="flex max-w-xl flex-col gap-5">
            <p className="m-0 type-reading text-ink-muted">{t('permissionsHint')}</p>
            <Field label={t('permissionLevelLabel')} htmlFor="permission-level">
              <Select
                id="permission-level"
                value={permissionLevel}
                onChange={(event) => handlePermissionLevelChange(event.target.value)}
              >
                {(['readonly', 'ask', 'auto'] as PermissionLevel[]).map((level) => (
                  <option key={level} value={level}>
                    {t(
                      level === 'readonly'
                        ? 'permissionLevelReadonly'
                        : level === 'ask'
                          ? 'permissionLevelAsk'
                          : 'permissionLevelAuto'
                    )}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex flex-col">
              <h4 className="m-0 mb-1.5 type-label text-ink-muted">{t('modeLegendTitle')}</h4>
              <div className="border-t border-rule-divide">
                {SESSION_MODE_ORDER.map((mode) => {
                  const ModeIcon = SESSION_MODE_ICON[mode]
                  return (
                    <LegendRow
                      key={mode}
                      icon={ModeIcon}
                      iconClassName={SESSION_MODE_ICON_CLASS[mode]}
                      title={t(SESSION_MODE_LABEL_KEY[mode])}
                      description={t(SESSION_MODE_DESCRIPTION_KEY[mode])}
                      meta={mode === 'plan' ? t('modeSessionOnly') : t('modeDefaultAllowed')}
                    />
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {section === 'shortcuts' && (
          <div className="flex max-w-xl flex-col gap-5">
            <p className="m-0 type-reading text-ink-muted">
              {t('shortcutHint')}
            </p>

            <section>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <h4 className="m-0 type-label text-ink-muted">{t('shortcutCustomGroup')}</h4>
                <button
                  type="button"
                  onClick={handleResetShortcuts}
                  className="type-caption text-ink-muted transition-colors hover:text-ink"
                >
                  {t('shortcutResetAll')}
                </button>
              </div>
              <div className="border-t border-rule-divide">
                {(['commandPalette', 'settings'] as ShortcutId[]).map((id) => (
                  <div
                    key={id}
                    className="flex items-center justify-between gap-4 border-b border-rule-divide py-2"
                  >
                    <span className="type-value text-ink">{shortcutName(id)}</span>
                    <div className="flex items-center gap-2">
                      {capturingShortcut === id ? (
                        <span className="type-caption text-warning">{t('shortcutCapture')}</span>
                      ) : (
                        <KeyCap>{formatShortcut(keybindings[id])}</KeyCap>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setCapturingShortcut(capturingShortcut === id ? null : id)
                        }
                      >
                        {capturingShortcut === id ? t('cancel') : t('shortcutCustomize')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {shortcutGroups.map((group) => (
              <section key={group.title}>
                <h4 className="m-0 mb-1.5 type-label text-ink-muted">
                  {group.title}
                </h4>
                <div className="border-t border-rule-divide">
                  {group.items.map((item) => (
                    <div
                      key={`${group.title}-${item.label}`}
                      className="flex items-start justify-between gap-4 border-b border-rule-divide py-2"
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="type-value text-ink">{item.label}</span>
                        {item.note && (
                          <span className="type-caption text-ink-muted">{item.note}</span>
                        )}
                      </div>
                      <ShortcutKeys keys={item.keys} />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {section === 'about' && (
          <div className="flex max-w-lg flex-col gap-3 type-caption text-ink-muted">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center border border-rule-control bg-raised type-subtitle text-accent">
                Pi
              </div>
              <div>
                <p className="m-0 type-value font-medium text-ink">Pi Workbench</p>
                <p className="m-0 text-ink-muted">
                  {t('aboutVersion', {
                    version: appInfo?.version ?? update.currentVersion ?? '',
                  })}
                </p>
              </div>
            </div>
            <dl className="m-0 mt-2 grid grid-cols-[120px_1fr] gap-x-3 gap-y-2">
              <dt className="text-ink-muted">{t('aboutRuntime')}</dt>
              <dd className="m-0 text-ink">
                Electron {appInfo?.electron ?? '—'} · Chromium {appInfo?.chrome ?? '—'} · Node{' '}
                {appInfo?.node ?? '—'}
              </dd>
              <dt className="text-ink-muted">{t('aboutFramework')}</dt>
              <dd className="m-0 text-ink">{t('infoFramework')}</dd>
              <dt className="text-ink-muted">{t('aboutArchitecture')}</dt>
              <dd className="m-0 text-ink">{t('infoArchitecture')}</dd>
              <dt className="text-ink-muted">{t('aboutApiSupport')}</dt>
              <dd className="m-0 text-ink">{t('infoApiSupport')}</dd>
            </dl>

            <div className="mt-4 border-t border-rule-divide pt-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="m-0 type-caption text-ink-muted">{t('updates')}</p>
                <span className="type-data text-ink-muted">
                  v{update.currentVersion || appInfo?.version || '—'}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-3">
                {update.status !== 'unsupported' &&
                  update.status !== 'downloading' &&
                  update.status !== 'downloaded' && (
                    <Button
                      size="sm"
                      icon={RefreshCw}
                      loading={update.status === 'checking'}
                      onClick={() => void handleCheckUpdate()}
                    >
                      {update.status === 'checking' ? t('checkingUpdates') : t('checkForUpdates')}
                    </Button>
                  )}
                {update.status === 'available' && update.canAutoInstall && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void handleDownloadUpdate()}
                  >
                    {t('downloadUpdate')}
                  </Button>
                )}
                {update.status === 'available' && !update.canAutoInstall && (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={ExternalLink}
                    onClick={() => void handleOpenDownload()}
                  >
                    {t('updateOpenDownload')}
                  </Button>
                )}
                {update.status === 'downloaded' && (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={RefreshCw}
                    onClick={requestInstallPrompt}
                  >
                    {t('restartToInstall')}
                  </Button>
                )}
                {updateStatusText && (
                  <span
                    className={
                      update.status === 'error'
                        ? 'type-caption text-danger'
                        : 'type-caption text-ink-muted'
                    }
                  >
                    {updateStatusText}
                  </span>
                )}
              </div>

              {update.status === 'downloading' && (
                <div className="mt-2 flex max-w-[280px] items-center gap-2">
                  <Meter
                    value={update.percent ?? 0}
                    label={t('updates')}
                    className="flex-1"
                  />
                  <span className="type-caption text-ink-muted">{update.percent ?? 0}%</span>
                </div>
              )}

              {update.status === 'available' && !update.canAutoInstall && (
                <p className="m-0 mt-2 type-caption text-ink-muted">{t('updateMacManualHint')}</p>
              )}

              {update.releaseNotes &&
                (update.status === 'available' || update.status === 'downloaded') && (
                  <div className="mt-3 flex flex-col gap-1.5">
                    <span className="type-label text-ink-muted">{t('updateNotes')}</span>
                    <div className="max-h-40 overflow-y-auto whitespace-pre-wrap border border-rule-hairline bg-sunken p-2.5 type-caption text-ink-muted">
                      {update.releaseNotes}
                    </div>
                  </div>
                )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
