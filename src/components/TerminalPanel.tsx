import React, { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api'
import { conversationKey, useChatStore } from '../store/chatStore'
import { subscribeTerminalData, terminalId, terminalReplay, useTerminalStore } from '../store/terminalStore'
import { useSessionStore } from '../store/sessionStore'
import { readThemeTokens, tokenHex } from '../theme/tokens'
import { useI18nStore } from '../store/i18nStore'
import { useResolvedTheme } from '../store/themeStore'
import { toast } from '../store/toastStore'
import { IconButton } from './ui'
import { useHostId } from '../panelHost/HostContext'
import { usePanelContextMenu } from './PanelContextMenu'
import { MAIN_HOST } from '../panelHost/types'
import { basename } from '../utils/filePath'

interface TerminalPanelProps {
  workspacePath: string
  /** 终端工作目录；跟随当前会话的工作树，默认工作区根 */
  cwd?: string
  visible: boolean
  /** 缺省时不给关闭按钮：面板已拆到独立窗口，收起入口是窗口自己 */
  onClose?: () => void
  active?: boolean
}

/** xterm 主题跟随 Paper & Ink token */
function terminalTheme(isDark: boolean) {
  const tokens = readThemeTokens(isDark)
  return {
    background: tokenHex(tokens, 'panel'),
    foreground: tokenHex(tokens, 'ink'),
    cursor: tokenHex(tokens, 'accent'),
    selectionBackground: tokenHex(tokens, 'accent', 0x30)
  }
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  workspacePath,
  cwd,
  visible,
  onClose,
  active = true
}) => {
  const { t } = useI18nStore()
  const resolvedTheme = useResolvedTheme()
  // 独立窗口里没有编辑器可让位，终端铺满整个窗口
  const detached = useHostId() !== MAIN_HOST
  const panelMenu = usePanelContextMenu('terminal')
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const startedRef = useRef(false)
  // PTY 与回放缓冲在 store 里，拆窗重建组件也不会丢 shell
  const status = useTerminalStore((state) => state.byWorkspace[workspacePath]?.status ?? 'idle')
  const error = useTerminalStore((state) => state.byWorkspace[workspacePath]?.error ?? null)
  const shellName = useTerminalStore((state) => state.byWorkspace[workspacePath]?.shellName ?? '')
  const logPath = useTerminalStore((state) => state.byWorkspace[workspacePath]?.logPath ?? null)
  const activeSessionId = useSessionStore((state) => state.byWorkspace[workspacePath]?.active ?? null)

  // 面板卸下时只销毁 xterm，PTY 留给 store
  useEffect(() => {
    return () => {
      termRef.current?.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // 面板首次可见时挂上 xterm：先回放缓冲，再接管实时输出
  useEffect(() => {
    if (!visible || startedRef.current || !containerRef.current) return
    startedRef.current = true

    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: '"Geist Mono Variable", "Geist Mono", "Noto Sans SC Variable", Consolas, monospace',
      cursorBlink: true,
      theme: terminalTheme(resolvedTheme === 'dark')
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(containerRef.current)
    fit.fit()
    termRef.current = terminal
    fitRef.current = fit

    const replay = terminalReplay(workspacePath)
    if (replay) terminal.write(replay)

    const offData = subscribeTerminalData(workspacePath, (chunk) => {
      termRef.current?.write(chunk)
    })

    terminal.onData((data) => {
      const id = terminalId(workspacePath)
      if (id) void api.terminalWrite(id, data)
    })

    useTerminalStore.getState().ensure(workspacePath, cwd ?? null, terminal.cols || 80, terminal.rows || 24)

    return () => {
      offData()
    }
  }, [visible, workspacePath, cwd, resolvedTheme])

  // PTY 建好（或换新）后同步一次尺寸
  useEffect(() => {
    if (status !== 'ready') return
    const terminal = termRef.current
    const id = terminalId(workspacePath)
    if (terminal && id) {
      fitRef.current?.fit()
      void api.terminalResize(id, terminal.cols, terminal.rows)
    }
  }, [status, workspacePath])

  // 主题切换时同步终端配色
  useEffect(() => {
    const terminal = termRef.current
    if (!terminal) return
    terminal.options.theme = terminalTheme(resolvedTheme === 'dark')
  }, [resolvedTheme])

  // 可见且处于活动工作区时适配尺寸
  useEffect(() => {
    if (!visible || !active || !termRef.current) return

    const fitAndResize = () => {
      fitRef.current?.fit()
      const id = terminalId(workspacePath)
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
  }, [visible, active, workspacePath])

  const restart = () => {
    const terminal = termRef.current
    terminal?.reset()
    useTerminalStore.getState().restart(workspacePath, cwd ?? null, terminal?.cols || 80, terminal?.rows || 24)
  }

  const sendOutputToChat = async () => {
    const id = terminalId(workspacePath)
    if (!id) return
    await api.terminalFlush(id)

    if (!logPath) {
      toast.error(t('terminalOutputUnavailable'))
      return
    }
    const exists = await api.exists(logPath)
    if (!exists.success || !exists.exists) {
      toast.error(t('terminalOutputUnavailable'))
      return
    }

    if (!activeSessionId) {
      toast.error(t('noActiveSession'))
      return
    }

    useChatStore.getState().addAttachment(conversationKey(workspacePath, activeSessionId), {
      kind: 'file',
      path: logPath,
      name: basename(logPath) || 'terminal.log'
    })
    toast.success(t('terminalAttached'))
  }

  return (
    <div
      className={
        detached
          ? 'flex h-full flex-col overflow-hidden bg-panel'
          : visible
            ? 'flex h-[172px] flex-shrink-0 flex-col border-t border-rule-divide bg-panel'
            : 'hidden'
      }
    >
      <div
        onContextMenu={panelMenu.onContextMenu}
        className="flex h-7 flex-shrink-0 items-center justify-between border-b border-rule-divide px-3.5"
      >
        <div className="flex items-center gap-3 type-label text-ink-muted">
          <span className="font-medium text-ink-muted">{t('terminal')}</span>
          {shellName && <span className="border-b border-accent pb-0.5 type-data text-ink">{shellName}</span>}
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
          {onClose && <IconButton icon={X} label={t('close')} size="sm" onClick={onClose} />}
        </div>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 px-2 pb-1 pt-1" />
      {panelMenu.menu}
    </div>
  )
}
