import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useI18nStore } from '../store/i18nStore'
import { toast } from '../store/toastStore'
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
        setError(result.error || 'Failed to load plugins')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workspacePath])

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
      toast.error(`${command.title}: ${message}`)
    } finally {
      setLoading(false)
    }
  }

  const setEnabled = async (plugin: PluginInfo) => {
    const result = await api.pluginsSetEnabled(workspacePath, plugin.id, !plugin.enabled)
    if (result.success) {
      setPlugins(result.plugins)
    } else {
      toast.error(result.error || 'Failed to update plugin')
    }
  }

  const reload = async () => {
    const result = await api.pluginsReload(workspacePath)
    if (result.success) {
      setPlugins(result.plugins)
      toast.success(t('pluginsReloaded'))
    } else {
      toast.error(result.error || 'Failed to reload plugins')
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24">
      <div className="fixed inset-0 bg-black/50" onClick={() => setOpen(false)} />
      <div className="relative w-11/12 max-w-2xl bg-white dark:bg-[#252526] border border-gray-300 dark:border-gray-700 rounded-lg shadow-xl flex flex-col max-h-[70vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('commandPalette')}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={reload}
              className="px-2 py-1 text-xs rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600"
            >
              {t('reloadPlugins')}
            </button>
            <button
              onClick={() => setOpen(false)}
              title={t('close')}
              className="bg-none border-none cursor-pointer text-lg text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700">
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
            className="w-full bg-transparent text-sm text-gray-900 dark:text-gray-100 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700">
          <span className="text-xs uppercase tracking-wide text-gray-500">{t('plugins')}</span>
          {plugins.length === 0 && !loading && (
            <span className="text-xs text-gray-500">{t('noPlugins')}</span>
          )}
          {plugins.map((plugin) => (
            <label
              key={plugin.id}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer ${
                plugin.error
                  ? 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200'
              }`}
              title={plugin.error || plugin.description || plugin.id}
            >
              <input
                type="checkbox"
                checked={plugin.enabled}
                onChange={() => void setEnabled(plugin)}
              />
              {plugin.name}
            </label>
          ))}
        </div>

        <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700">
          <input
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            placeholder={t('commandArguments')}
            className="w-full bg-transparent text-xs text-gray-700 dark:text-gray-300 focus:outline-none"
          />
        </div>

        {error && (
          <div className="px-4 py-2 text-sm text-red-600 dark:text-red-400 border-b border-red-200 dark:border-red-700/50">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-sm text-center text-gray-500">
              {loading ? t('loading') : t('noPluginCommands')}
            </div>
          ) : (
            filtered.map((command, index) => (
              <button
                key={command.id}
                onClick={() => void runCommand(command)}
                onMouseEnter={() => setSelected(index)}
                className={`w-full text-left px-4 py-2 border-b border-gray-100 dark:border-gray-700/50 bg-none cursor-pointer ${
                  index === selected
                    ? 'bg-blue-50 dark:bg-blue-900/20'
                    : 'hover:bg-gray-50 dark:hover:bg-[#2d2d30]'
                }`}
              >
                <div className="text-sm text-gray-900 dark:text-gray-100">{command.title}</div>
                <div className="text-xs text-gray-500">
                  {command.pluginName} · {command.id}
                  {command.description ? ` — ${command.description}` : ''}
                </div>
              </button>
            ))
          )}
        </div>

        {output && (
          <div className="border-t border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between px-4 py-2">
              <span
                className={`text-xs font-medium ${
                  output.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                }`}
              >
                {t('commandOutput')}: {output.title}
              </span>
              <button
                onClick={() => setOutput(null)}
                className="bg-none border-none cursor-pointer text-xs text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
              >
                {t('clear')}
              </button>
            </div>
            <pre className="max-h-40 overflow-auto px-4 pb-3 text-xs font-mono whitespace-pre-wrap text-gray-800 dark:text-gray-200">
              {output.text}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
