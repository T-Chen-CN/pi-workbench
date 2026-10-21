import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api'
import { useChatStore } from '../store/chatStore'
import { readThemeTokens, tokenHex } from '../theme/tokens'
import { useI18nStore } from '../store/i18nStore'
import { useResolvedTheme } from '../store/themeStore'
import { localizeError } from '../i18n/errors'
import { toast } from '../store/toastStore'
import { IconButton } from './ui'

interface TerminalPanelProps {
  workspacePath: string
  visible: boolean
  onClose: () => void
}

type TerminalStatus = 'idle' | 'starting' | 'ready' | 'error'

/** xterm 主题跟随 Paper & Ink token */
function terminalTheme(isDark: boolean) {
  const tokens = readThemeTokens(isDark)
  return {
    background: tokenHex(tokens, 'panel'),
    foreground: tokenHex(tokens, 'ink'),
    cursor: tokenHex(tokens, 'accent'),
    selectionBackground: tokenHex(tokens, 'accent', 0x30),
  }
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  workspacePath,
  visible,
  onClose,
}) => {
  const { t } = useI18nStore()
  const resolvedTheme = useResolvedTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const terminalLogPathRef = useRef<string | null>(null)
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
      fontFamily: '"Geist Mono Variable", "Geist Mono", "Noto Sans SC Variable", Consolas, monospace',
      cursorBlink: true,
      theme: terminalTheme(resolvedTheme === 'dark'),
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
        terminalLogPathRef.current = result.logPath ?? null
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
  }, [visible, workspacePath, generation, t, resolvedTheme])

  // 主题切换时同步终端配色
  useEffect(() => {
    const terminal = termRef.current
    if (!terminal) return
    terminal.options.theme = terminalTheme(resolvedTheme === 'dark')
  }, [resolvedTheme])

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
    terminalLogPathRef.current = null
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

    const logPath = terminalLogPathRef.current
    if (!logPath) {
      toast.error(t('terminalOutputUnavailable'))
      return
    }
    const exists = await api.exists(logPath)
    if (!exists.success || !exists.exists) {
      toast.error(t('terminalOutputUnavailable'))
      return
    }

    useChatStore.getState().addAttachment({
      path: logPath,
      name: logPath.split(/[\\/]/).pop() || 'terminal.log',
    })
    toast.success(t('terminalAttached'))
  }

  return (
    <div
      className={
        visible
          ? 'flex h-[172px] flex-shrink-0 flex-col border-t border-rule-divide bg-panel'
          : 'hidden'
      }
    >
      <div className="flex h-7 flex-shrink-0 items-center justify-between border-b border-rule-divide px-3.5">
        <div className="flex items-center gap-3 type-label text-ink-muted">
          <span className="font-medium text-ink-muted">{t('terminal')}</span>
          <span className="border-b border-accent pb-0.5 type-data text-ink">zsh</span>
          {status === 'starting' && <span>{t('terminalStarting')}</span>}
          {status === 'error' && <span className="text-danger">{error}</span>}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={status !== 'ready'}
            onClick={() => void sendOutputToChat()}
            className="type-label font-normal text-ink-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            {t('sendTerminalOutput')}
          </button>
          <button
            type="button"
            onClick={restart}
            className="type-label font-normal text-ink-muted transition-colors hover:text-ink"
          >
            {t('restartTerminal')}
          </button>
          <IconButton icon={X} label={t('close')} size="sm" onClick={onClose} />
        </div>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 px-2 pb-1 pt-1" />
    </div>
  )
}
