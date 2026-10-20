import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Search, X } from 'lucide-react'
import { api } from '../api'
import { useI18nStore } from '../store/i18nStore'
import { localizeError } from '../i18n/errors'
import { toast } from '../store/toastStore'
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') {
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
  }, [])

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

  const commands = useMemo(
    () => plugins.filter((plugin) => plugin.enabled && !plugin.error).flatMap((plugin) => plugin.commands),
    [plugins]
  )

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
    } else {
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
      <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
      <div className="relative flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden border border-line bg-panel shadow-print">
        <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-line px-3">
          <h3 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
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

        <div className="flex flex-shrink-0 items-center gap-2 border-b border-line px-3">
          <Search size={15} className="text-ink-subtle" />
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
            className="h-10 w-full bg-transparent font-mono text-[13px] text-ink placeholder:text-ink-subtle focus:outline-none"
          />
          {loading && <Spinner size={14} className="text-ink-subtle" />}
        </div>

        <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-subtle">
            {t('plugins')}
          </span>
          {plugins.length === 0 && !loading && (
            <span className="font-mono text-[10px] text-ink-subtle">{t('noPlugins')}</span>
          )}
          {plugins.map((plugin) => (
            <label
              key={plugin.id}
              className={`inline-flex cursor-pointer items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] ${
                plugin.error
                  ? 'border-danger/40 bg-danger/10 text-danger'
                  : 'border-line bg-sunken text-ink-muted hover:text-ink'
              }`}
              title={plugin.error || plugin.description || plugin.id}
            >
              <input
                type="checkbox"
                className="h-3 w-3 accent-[rgb(var(--accent))]"
                checked={plugin.enabled}
                onChange={() => void setEnabled(plugin)}
              />
              {plugin.name}
            </label>
          ))}
        </div>

        <div className="flex-shrink-0 border-b border-line px-3 py-1.5">
          <input
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            placeholder={t('commandArguments')}
            className="w-full bg-transparent text-[11px] text-ink-muted placeholder:text-ink-subtle focus:outline-none"
          />
        </div>

        {error && (
          <div className="flex-shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-xs text-danger">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-ink-subtle">
              {loading ? t('loading') : t('noPluginCommands')}
            </div>
          ) : (
            filtered.map((command, index) => (
              <button
                key={command.id}
                type="button"
                onClick={() => void runCommand(command)}
                onMouseEnter={() => setSelected(index)}
                className={`flex w-full items-start gap-3 border-b border-b-line/50 border-l-2 px-3 py-2 text-left transition-colors ${
                  index === selected
                    ? 'border-l-accent bg-accent/[0.06]'
                    : 'border-l-transparent hover:bg-hover'
                }`}
              >
                <span className="mt-0.5 font-mono text-[9px] text-ink-subtle">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs text-ink">{command.title}</span>
                  <span className="font-mono text-[9.5px] text-ink-subtle">
                    {command.pluginName} · {command.id}
                    {command.description ? ` — ${command.description}` : ''}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>

        {output && (
          <div className="flex-shrink-0 border-t border-line">
            <div className="flex items-center justify-between px-3 py-1.5">
              <span
                className={`text-[11px] font-medium ${
                  output.success ? 'text-success' : 'text-danger'
                }`}
              >
                {t('commandOutput')}: {output.title}
              </span>
              <button
                type="button"
                onClick={() => setOutput(null)}
                className="text-[11px] text-ink-subtle hover:text-ink"
              >
                {t('clear')}
              </button>
            </div>
            <pre className="m-0 max-h-40 overflow-auto px-3 pb-2 font-mono text-[11px] text-ink-muted whitespace-pre-wrap">
              {output.text}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
