import React, { useCallback, useEffect, useState } from 'react'
import {
  ExternalLink,
  Info,
  KeyRound,
  Keyboard,
  RefreshCw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useThemeStore, type ThemeMode } from '../store/themeStore'
import {
  TOOL_CATEGORIES,
  isPermissionAction,
  useSettingsStore,
  clampAutoSaveDelay,
  MIN_AUTO_SAVE_DELAY,
  MAX_AUTO_SAVE_DELAY,
  type NotificationPrefs,
} from '../store/settingsStore'
import { useUpdaterStore } from '../store/updaterStore'
import { api } from '../api'
import { toast } from '../store/toastStore'
import { localizeError } from '../i18n/errors'
import type { ApiConfig, AppInfo } from '../types/electron'
import { isMacPlatform } from '../utils/shortcuts'
import { Button, Field, Input, Select } from './ui'
import { KeyCap, Meter } from './patterns'
import type { PermissionAction, ToolCategory } from '../types/electron'
import type { TranslationKey } from '../i18n/translations'
import {
  DEFAULT_KEYBINDINGS,
  eventToShortcut,
  findConflict,
  formatShortcut,
  type ShortcutId,
} from '../utils/keybindings'

const PERMISSION_LABEL_KEYS: Record<ToolCategory, TranslationKey> = {
  read: 'permissionRead',
  write: 'permissionWrite',
  command: 'permissionCommand',
  other: 'permissionOther',
}

export type SettingsSection = 'general' | 'api' | 'permissions' | 'shortcuts' | 'about'

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
    permissions,
    notifications,
    budgetUsd,
    keybindings,
    setAutoSave,
    setAutoSaveDelay,
    setPermission,
    setNotificationPrefs,
    setBudgetUsd,
    setKeybinding,
    resetKeybindings,
  } = useSettingsStore()
  const [capturingShortcut, setCapturingShortcut] = useState<ShortcutId | null>(null)
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const isMac = isMacPlatform()
  const mod = isMac ? '⌘' : 'Ctrl'
  const shift = isMac ? '⇧' : 'Shift'
  const alt = isMac ? '⌥' : 'Alt'

  const [apiConfig, setApiConfig] = useState<ApiConfig>({
    provider: 'custom',
    apiUrl: '',
    apiKey: '',
    availableModels: [],
    selectedModel: '',
  })

  const [isSaving, setIsSaving] = useState(false)
  const [isFetchingModels, setIsFetchingModels] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')

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

  const persistSettings = async (patch: Record<string, unknown>) => {
    try {
      const current = await api.getSettings()
      const settings = current.success && current.settings ? current.settings : {}
      await api.saveSettings({ ...settings, ...patch })
    } catch (error) {
      console.error('Failed to persist settings:', error)
    }
  }

  const handleLanguageChange = (next: 'zh' | 'en') => {
    setLanguage(next)
    void persistSettings({ language: next })
  }

  const handleThemeChange = (next: ThemeMode) => {
    setMode(next)
    void persistSettings({ theme: next })
  }

  const handleAutoSaveChange = (enabled: boolean) => {
    setAutoSave(enabled)
    void persistSettings({ autoSave: enabled })
  }

  const handleAutoSaveDelayChange = (delayMs: number) => {
    const next = clampAutoSaveDelay(delayMs)
    setAutoSaveDelay(next)
    void persistSettings({ autoSaveDelay: next })
  }

  const handlePermissionChange = (category: ToolCategory, action: string) => {
    if (!isPermissionAction(action)) return
    const next = { ...permissions, [category]: action as PermissionAction }
    setPermission(category, action)
    void persistSettings({ permissions: next })
  }

  const handleNotificationChange = (patch: Partial<NotificationPrefs>) => {
    const next = { ...notifications, ...patch }
    setNotificationPrefs(patch)
    void persistSettings({ notifications: next })
  }

  const handleBudgetChange = (value: number) => {
    const next = Number.isFinite(value) ? Math.max(0, value) : 0
    setBudgetUsd(next)
    void persistSettings({ budgetUsd: next })
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
      void persistSettings({ keybindings: next })
      setCapturingShortcut(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturingShortcut, keybindings])

  const handleResetShortcuts = () => {
    resetKeybindings()
    void persistSettings({ keybindings: DEFAULT_KEYBINDINGS })
  }

  const loadApiConfig = useCallback(async () => {
    try {
      const result = await api.apiConfigGet()
      if (result.success && result.config) {
        // 只支持 OpenAI 兼容渠道，旧配置一律按兼容模式处理
        setApiConfig({ ...result.config, provider: 'custom' })
      }
    } catch (error) {
      console.error('[Settings] Failed to load API config:', error)
      toast.error(t('loadApiConfigFailed'))
    }
  }, [t])

  useEffect(() => {
    void loadApiConfig()
  }, [loadApiConfig])

  const handleFetchModels = async () => {
    if (!apiConfig.apiUrl.trim()) {
      toast.error(t('enterApiUrlFirst'))
      return
    }
    if (!apiConfig.apiKey) {
      toast.error(t('enterApiKeyFirst'))
      return
    }

    setIsFetchingModels(true)
    try {
      const result = await api.apiConfigFetchModels(apiConfig.apiUrl, apiConfig.apiKey, 'custom')

      if (result.success && result.models && result.models.length > 0) {
        setApiConfig((prev) => ({
          ...prev,
          availableModels: result.models!,
          selectedModel: result.models!.includes(prev.selectedModel)
            ? prev.selectedModel
            : result.models![0],
        }))
        toast.success(t('fetchedModels', { count: result.models.length }))
      } else if (result.success) {
        toast.warning(t('emptyModelList'))
      } else {
        toast.error(
          t('fetchModelsFailed', { error: localizeError(result.error) || t('unknownError') })
        )
      }
    } catch (error) {
      console.error('[Settings] Fetch models error:', error)
      toast.error(t('fetchModelsFailed', { error: localizeError(String(error)) }))
    } finally {
      setIsFetchingModels(false)
    }
  }

  const handleSaveConfig = async () => {
    if (!apiConfig.apiKey) {
      toast.error(t('apiKeyRequired'))
      return
    }
    if (!apiConfig.selectedModel) {
      toast.error(t('selectModelFirst'))
      return
    }

    setIsSaving(true)
    setSaveStatus('idle')

    try {
      const result = await api.apiConfigSave(apiConfig)
      if (result.success) {
        setSaveStatus('success')
        toast.success(t('apiConfigSaved'))
        // 通知 ChatPanel 用新配置重新初始化 Agent
        window.dispatchEvent(new CustomEvent('api-config-saved'))
        setTimeout(() => setSaveStatus('idle'), 2000)
      } else {
        setSaveStatus('error')
        toast.error(t('saveConfigFailed', { error: localizeError(result.error) || t('unknownError') }))
      }
    } catch (error) {
      console.error('[Settings] Save config error:', error)
      setSaveStatus('error')
      toast.error(t('saveConfigFailed', { error: localizeError(String(error)) }))
    } finally {
      setIsSaving(false)
    }
  }

  const navItems: Array<{ id: SettingsSection; label: string; icon: typeof Info }> = [
    { id: 'general', label: t('general'), icon: SlidersHorizontal },
    { id: 'api', label: t('apiConfiguration'), icon: KeyRound },
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
          keys: [mod, shift, 'P'],
          note: t('shortcutCommandPaletteNote'),
        },
        { label: t('shortcutSettings'), keys: [mod, ','] },
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
            <Field label={t('language')}>
              <Select
                value={language}
                onChange={(e) => handleLanguageChange(e.target.value as 'zh' | 'en')}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </Select>
            </Field>

            <Field label={t('theme')}>
              <Select
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

            <Field label={t('autoSaveDelay')}>
              <Select
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
            <Field label={t('budgetUsd')} hint={t('budgetUsdHint')}>
              <Input
                type="number"
                min={0}
                step={0.5}
                value={String(budgetUsd)}
                onChange={(event) => handleBudgetChange(Number(event.target.value))}
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
          </div>
        )}

        {section === 'api' && (
          <div className="flex max-w-lg flex-col gap-4">
            <p className="m-0 type-reading text-ink-muted">
              {t('apiConfigurationDesc')}
            </p>

            <Field label={t('apiUrl')}>
              <Input
                type="text"
                value={apiConfig.apiUrl}
                onChange={(e) => setApiConfig((prev) => ({ ...prev, apiUrl: e.target.value }))}
                placeholder="https://your-api-endpoint/v1"
                className="type-code"
              />
            </Field>

            <Field label={t('apiKey')} hint={t('apiKeyHint')}>
              <Input
                type="password"
                value={apiConfig.apiKey}
                onChange={(e) => setApiConfig((prev) => ({ ...prev, apiKey: e.target.value }))}
                placeholder="sk-..."
                className="type-code"
              />
            </Field>

            <div>
              <Button
                variant="secondary"
                size="sm"
                icon={RefreshCw}
                loading={isFetchingModels}
                onClick={() => void handleFetchModels()}
              >
                {isFetchingModels ? t('fetching') : t('fetchModels')}
              </Button>
            </div>

            <Field
              label={t('model')}
              hint={t('modelsAvailable', { count: apiConfig.availableModels.length })}
            >
              <Select
                value={apiConfig.selectedModel}
                onChange={(e) =>
                  setApiConfig((prev) => ({ ...prev, selectedModel: e.target.value }))
                }
                disabled={apiConfig.availableModels.length === 0}
              >
                {apiConfig.availableModels.length === 0 ? (
                  <option value="">{t('noModelsAvailable')}</option>
                ) : (
                  apiConfig.availableModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))
                )}
              </Select>
            </Field>

            <div className="mt-1 flex items-center gap-3">
              <Button
                variant="primary"
                size="sm"
                icon={Save}
                loading={isSaving}
                onClick={() => void handleSaveConfig()}
              >
                {isSaving ? t('saving') : t('saveConfiguration')}
              </Button>
              {saveStatus === 'success' && (
                <span className="type-caption text-success">{t('savedSuccessfully')}</span>
              )}
              {saveStatus === 'error' && (
                <span className="type-caption text-danger">{t('saveFailedShort')}</span>
              )}
            </div>
          </div>
        )}

        {section === 'permissions' && (
          <div className="flex max-w-xl flex-col gap-5">
            <p className="m-0 type-reading text-ink-muted">{t('permissionsHint')}</p>
            {TOOL_CATEGORIES.map((category) => (
              <Field
                key={category}
                label={t(PERMISSION_LABEL_KEYS[category])}
                htmlFor={`permission-${category}`}
              >
                <Select
                  id={`permission-${category}`}
                  value={permissions[category]}
                  onChange={(event) => handlePermissionChange(category, event.target.value)}
                >
                  <option value="allow">{t('permissionAllow')}</option>
                  <option value="ask">{t('permissionAsk')}</option>
                  <option value="deny">{t('permissionDeny')}</option>
                </Select>
              </Field>
            ))}
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
