import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Search, X } from 'lucide-react'
import { api } from '../api'
import { useI18nStore } from '../store/i18nStore'
import { useSelectionStore } from '../store/selectionStore'
import { useSessionStore } from '../store/sessionStore'
import { localizeError } from '../i18n/errors'
import { toast } from '../store/toastStore'
import { useUpdaterStore } from '../store/updaterStore'
import { useSettingsStore } from '../store/settingsStore'
import { matchShortcut } from '../utils/keybindings'
import { IconButton, Spinner } from './ui'
import type { PluginCommandInfo, PluginInfo } from '../types/electron'

interface CommandPaletteProps {
  workspacePath: string
}

interface CommandOutput {
  title: string
  text: string
  success: boolean
}

const ATTACH_SELECTION_COMMAND_ID = 'workbench.attach-selection'
const CHECK_UPDATES_COMMAND_ID = 'workbench.check-updates'

const BUILTIN_COMMANDS: Array<{
  id: string
  titleKey:
    | 'attachSelection'
    | 'newSession'
    | 'sessionList'
    | 'renameSession'
    | 'deleteSession'
    | 'closeSessionTab'
    | 'checkForUpdates'
  event?: string
}> = [
  { id: ATTACH_SELECTION_COMMAND_ID, titleKey: 'attachSelection' },
  { id: CHECK_UPDATES_COMMAND_ID, titleKey: 'checkForUpdates' },
  { id: 'workbench.session-new', titleKey: 'newSession', event: 'session-new' },
  { id: 'workbench.session-list', titleKey: 'sessionList', event: 'session-list' },
  { id: 'workbench.session-rename', titleKey: 'renameSession', event: 'session-rename' },
  { id: 'workbench.session-delete', titleKey: 'deleteSession', event: 'session-delete' },
  { id: 'workbench.session-close', titleKey: 'closeSessionTab', event: 'session-close' },
]

export const CommandPalette: React.FC<CommandPaletteProps> = ({ workspacePath }) => {
  const { t } = useI18nStore()
  const [open, setOpen] = useState(false)
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [args, setArgs] = useState('')
  const [selected, setSelected] = useState(0)
  const [output, setOutput] = useState<CommandOutput | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.pluginsList(workspacePath)
      if (result.success) {
        setPlugins(result.plugins)
      } else {
        setError(t('loadPluginsFailed', { error: localizeError(result.error) || t('unknownError') }))
      }
    } catch (err) {
      setError(localizeError(err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [workspacePath, t])

  // 全局快捷键与外部打开事件
  const paletteShortcut = useSettingsStore((state) => state.keybindings.commandPalette)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchShortcut(event, paletteShortcut)) {
        event.preventDefault()
        setOpen((value) => !value)
      } else if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    const onOpen = () => setOpen(true)

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('open-command-palette', onOpen)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('open-command-palette', onOpen)
    }
  }, [paletteShortcut])

  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [open, refresh])

  useEffect(() => {
    const unsubscribe = api.onPluginsChanged((payload) => {
      if (open && payload.workspaceDir === workspacePath) {
        void refresh()
      }
    })
    return unsubscribe
  }, [open, workspacePath, refresh])

  const commands = useMemo(() => {
    const builtins: PluginCommandInfo[] = BUILTIN_COMMANDS.map((command) => ({
      id: command.id,
      title: t(command.titleKey),
      pluginId: 'workbench',
      pluginName: 'Workbench',
    }))
    return [
      ...builtins,
      ...plugins.filter((plugin) => plugin.enabled && !plugin.error).flatMap((plugin) => plugin.commands),
    ]
  }, [plugins, t])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return commands
    return commands.filter((command) =>
      `${command.title} ${command.id} ${command.pluginName}`.toLowerCase().includes(needle)
    )
  }, [commands, query])

  useEffect(() => {
    setSelected(0)
  }, [query, open])

  const runCommand = async (command: PluginCommandInfo) => {
    const builtin = BUILTIN_COMMANDS.find((item) => item.id === command.id)
    if (builtin) {
      if (command.id === ATTACH_SELECTION_COMMAND_ID) {
        const selection = useSelectionStore.getState().selection
        if (!selection) {
          setOutput({ title: command.title, text: t('selectionEmpty'), success: false })
          toast.error(`${command.title}: ${t('selectionEmpty')}`)
          return
        }
        window.dispatchEvent(new CustomEvent('attach-selection'))
        setOutput({ title: command.title, text: t('selectionAttached'), success: true })
        toast.success(`${command.title}: ${t('selectionAttached')}`)
        return
      }

      if (command.id === CHECK_UPDATES_COMMAND_ID) {
        const result = await api.updateCheck()
        useUpdaterStore.getState().applyState(result.state)
        if (!result.success) {
          const message = localizeError(result.error) || t('unknownError')
          setOutput({ title: command.title, text: message, success: false })
          toast.error(t('updateFailed', { error: message }))
          return
        }
        const status =
          result.state.status === 'available'
            ? t('updateAvailable', { version: result.state.version ?? '' })
            : result.state.status === 'not-available'
              ? t('updateLatest')
              : t('checkingUpdates')
        setOutput({ title: command.title, text: status, success: true })
        toast.success(status)
        return
      }

      const active = useSessionStore.getState().byWorkspace[workspacePath]?.active
      if (!active) {
        setOutput({ title: command.title, text: t('noActiveSession'), success: false })
        toast.error(`${command.title}: ${t('noActiveSession')}`)
        return
      }
      if (builtin.event) {
        window.dispatchEvent(new CustomEvent(builtin.event))
        setOutput({ title: command.title, text: command.title, success: true })
      }
      return
    }

    setLoading(true)
    setOutput(null)
    try {
      const result = await api.pluginsInvoke(
        workspacePath,
        command.id,
        args.trim() ? args.trim() : undefined
      )
      const text = [result.output, result.message, result.error].filter(Boolean).join('\n')
      setOutput({
        title: command.title,
        text: text || (result.success ? t('commandSucceeded') : t('commandFailed')),
        success: result.success,
      })
      if (result.success) {
        toast.success(`${command.title}: ${t('commandSucceeded')}`)
      } else {
        toast.error(`${command.title}: ${result.error || t('commandFailed')}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setOutput({ title: command.title, text: message, success: false })
      toast.error(`${command.title}: ${localizeError(message)}`)
    } finally {
      setLoading(false)
    }
  }

  const setEnabled = async (plugin: PluginInfo) => {
    const result = await api.pluginsSetEnabled(workspacePath, plugin.id, !plugin.enabled)
    if (result.success) {
      setPlugins(result.plugins)
    } else if (result.error !== 'Cancelled') {
      toast.error(t('updatePluginFailed', { error: localizeError(result.error) || t('unknownError') }))
    }
  }

  const reload = async () => {
    const result = await api.pluginsReload(workspacePath)
    if (result.success) {
      setPlugins(result.plugins)
      toast.success(t('pluginsReloaded'))
    } else {
      toast.error(t('reloadPluginsFailed', { error: localizeError(result.error) || t('unknownError') }))
    }
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-20"
    >
      <div className="absolute inset-0 bg-overlay/50" onClick={() => setOpen(false)} />
      <div className="relative flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden border border-line bg-raised shadow-print">
        <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-rule-divide px-3">
          <h3 className="m-0 type-label text-ink-muted">
            {t('commandPalette')}
          </h3>
          <div className="flex items-center gap-1">
            <IconButton
              icon={RefreshCw}
              label={t('reloadPlugins')}
              size="sm"
              onClick={reload}
            />
            <IconButton icon={X} label={t('close')} size="sm" onClick={() => setOpen(false)} />
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2 border-b border-rule-divide px-3 transition-colors focus-within:border-accent">
          <Search size={15} className="text-ink-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelected((value) => Math.min(value + 1, Math.max(filtered.length - 1, 0)))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelected((value) => Math.max(value - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                const command = filtered[selected]
                if (command && !loading) void runCommand(command)
              }
            }}
            placeholder={t('pluginCommands')}
            className="h-10 w-full bg-transparent type-body text-ink placeholder:text-ink-muted focus:outline-none"
          />
          {loading && <Spinner size={14} className="text-ink-muted" />}
        </div>

        <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 border-b border-rule-divide px-3 py-1.5">
          <span className="type-label text-ink-muted">
            {t('plugins')}
          </span>
          {plugins.length === 0 && !loading && (
            <span className="type-caption text-ink-muted">{t('noPlugins')}</span>
          )}
          {plugins.map((plugin) => (
            <label
              key={plugin.id}
              className={`inline-flex cursor-pointer items-center gap-1.5 border px-2 py-0.5 type-caption ${
                plugin.error
                  ? 'border-danger/40 bg-danger/10 text-danger'
                  : 'border-rule-control bg-sunken text-ink-muted hover:text-ink'
              }`}
              title={plugin.error || plugin.description || plugin.id}
            >
              <input
                type="checkbox"
                className="h-3 w-3 accent-accent"
                checked={plugin.enabled}
                onChange={() => void setEnabled(plugin)}
              />
              {plugin.name}
            </label>
          ))}
        </div>

        <div className="flex-shrink-0 border-b border-rule-divide px-3 py-1.5 transition-colors focus-within:border-accent">
          <input
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            placeholder={t('commandArguments')}
            className="w-full bg-transparent type-caption text-ink-muted placeholder:text-ink-muted focus:outline-none"
          />
        </div>

        {error && (
          <div className="flex-shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-1.5 type-caption text-danger">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center type-caption text-ink-muted">
              {loading ? t('loading') : t('noPluginCommands')}
            </div>
          ) : (
            filtered.map((command, index) => (
              <button
                key={command.id}
                type="button"
                onClick={() => void runCommand(command)}
                onMouseEnter={() => setSelected(index)}
                className={`flex w-full items-start gap-3 border-b border-rule-divide border-l-2 px-3 py-2 text-left transition-colors ${
                  index === selected
                    ? 'border-l-accent bg-accent/[0.06]'
                    : 'border-l-transparent hover:bg-hover'
                }`}
              >
                <span className="mt-0.5 type-data text-ink-muted">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="type-value text-ink">{command.title}</span>
                  <span className="type-caption text-ink-muted">
                    {command.pluginName} · {command.id}
                    {command.description ? ` — ${command.description}` : ''}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>

        {output && (
          <div className="flex-shrink-0 border-t border-rule-divide">
            <div className="flex items-center justify-between px-3 py-1.5">
              <span
                className={`type-caption font-medium ${
                  output.success ? 'text-success' : 'text-danger'
                }`}
              >
                {t('commandOutput')}: {output.title}
              </span>
              <button
                type="button"
                onClick={() => setOutput(null)}
                className="type-caption text-ink-muted hover:text-ink"
              >
                {t('clear')}
              </button>
            </div>
            <pre className="m-0 max-h-40 overflow-auto px-3 pb-2 type-code text-ink-muted whitespace-pre-wrap">
              {output.text}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
