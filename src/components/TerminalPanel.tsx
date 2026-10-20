import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api'
import { useChatStore } from '../store/chatStore'
import { useI18nStore } from '../store/i18nStore'
import { localizeError } from '../i18n/errors'
import { toast } from '../store/toastStore'

interface TerminalPanelProps {
  workspacePath: string
  visible: boolean
  onClose: () => void
}

type TerminalStatus = 'idle' | 'starting' | 'ready' | 'error'

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  workspacePath,
  visible,
  onClose,
}) => {
  const { t } = useI18nStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const startedRef = useRef(false)
  const [status, setStatus] = useState<TerminalStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)

  // 输出订阅（组件生命周期内只注册一次）
  useEffect(() => {
    const offData = api.onTerminalData(({ id, data }) => {
      if (id === terminalIdRef.current) {
        termRef.current?.write(data)
      }
    })
    const offExit = api.onTerminalExit(({ id, exitCode }) => {
      if (id === terminalIdRef.current) {
        const message = t('processExited', { code: exitCode })
        termRef.current?.writeln(`\r\n[${message}]`)
        setStatus('error')
        setError(message)
      }
    })
    return () => {
      offData()
      offExit()
    }
  }, [t])

  // 卸载时释放 PTY
  useEffect(() => {
    return () => {
      const id = terminalIdRef.current
      if (id) void api.terminalClose(id)
      terminalIdRef.current = null
      termRef.current?.dispose()
      termRef.current = null
    }
  }, [])

  // 面板首次可见时创建终端
  useEffect(() => {
    if (!visible || startedRef.current || !containerRef.current) return
    startedRef.current = true
    setStatus('starting')
    setError(null)

    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      cursorBlink: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(containerRef.current)
    fit.fit()
    termRef.current = terminal
    fitRef.current = fit

    terminal.onData((data) => {
      const id = terminalIdRef.current
      if (id) void api.terminalWrite(id, data)
    })

    let cancelled = false
    void (async () => {
      const result = await api.terminalCreate(
        workspacePath,
        terminal.cols || 80,
        terminal.rows || 24
      )
      if (cancelled) {
        if (result.id) void api.terminalClose(result.id)
        return
      }
      if (result.success && result.id) {
        terminalIdRef.current = result.id
        setStatus('ready')
        fit.fit()
        void api.terminalResize(result.id, terminal.cols, terminal.rows)
      } else {
        const message = result.error ? localizeError(result.error) : t('terminalCreateFailed')
        setStatus('error')
        setError(message)
        terminal.writeln(`\r\n${message}`)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [visible, workspacePath, generation, t])

  // 可见时适配尺寸
  useEffect(() => {
    if (!visible || !termRef.current) return

    const fitAndResize = () => {
      fitRef.current?.fit()
      const id = terminalIdRef.current
      const terminal = termRef.current
      if (id && terminal) {
        void api.terminalResize(id, terminal.cols, terminal.rows)
      }
    }

    fitAndResize()
    const timer = setTimeout(fitAndResize, 50)
    const observer = new ResizeObserver(fitAndResize)
    if (containerRef.current) observer.observe(containerRef.current)

    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [visible])

  const restart = () => {
    const id = terminalIdRef.current
    if (id) void api.terminalClose(id)
    terminalIdRef.current = null
    termRef.current?.dispose()
    termRef.current = null
    fitRef.current = null
    startedRef.current = false
    setStatus('idle')
    setGeneration((value) => value + 1)
  }

  const sendOutputToChat = async () => {
    const id = terminalIdRef.current
    if (!id) return
    await api.terminalFlush(id)

    const separator = workspacePath.includes('\\') ? '\\' : '/'
    const logPath = `${workspacePath}${separator}.pi-workbench${separator}terminal.log`
    const exists = await api.exists(logPath)
    if (!exists.success || !exists.exists) {
      toast.error(t('terminalOutputUnavailable'))
      return
    }

    useChatStore.getState().addAttachment({ path: logPath, name: 'terminal.log' })
    toast.success(t('terminalAttached'))
  }

  return (
    <div
      className={
        visible
          ? 'h-64 flex flex-col border-t border-gray-200 dark:border-gray-700 bg-[#1e1e1e] flex-shrink-0'
          : 'hidden'
      }
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#252526] flex-shrink-0">
        <div className="flex items-center gap-3 text-xs text-gray-600 dark:text-gray-400">
          <span className="uppercase tracking-wide">{t('terminal')}</span>
          {status === 'starting' && <span>{t('terminalStarting')}</span>}
          {status === 'error' && <span className="text-red-500">{error}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={sendOutputToChat}
            disabled={status !== 'ready'}
            className="px-2 py-1 text-xs rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('sendTerminalOutput')}
          </button>
          <button
            onClick={restart}
            className="px-2 py-1 text-xs rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600"
          >
            {t('restartTerminal')}
          </button>
          <button
            onClick={onClose}
            title={t('close')}
            className="px-1.5 py-1 text-sm bg-none border-none cursor-pointer text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
          >
            ✕
          </button>
        </div>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 px-1 pb-1" />
    </div>
  )
}
