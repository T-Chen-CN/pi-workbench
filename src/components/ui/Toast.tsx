import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useI18nStore } from '../../store/i18nStore'
import { useHostDocument } from '../../panelHost/HostContext'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastMessage {
  id: string
  message: string
  type: ToastType
  duration?: number
  /** 显示在哪个宿主窗口；缺省视为主窗口 */
  host?: string
}

interface ToastProps {
  message: ToastMessage
  onClose: (id: string) => void
}

const TOAST_STYLES: Record<ToastType, { border: string; icon: string; Icon: typeof Info }> = {
  success: { border: 'border-l-success', icon: 'text-success', Icon: CheckCircle2 },
  error: { border: 'border-l-danger', icon: 'text-danger', Icon: XCircle },
  warning: { border: 'border-l-warning', icon: 'text-warning', Icon: AlertTriangle },
  info: { border: 'border-l-accent', icon: 'text-accent', Icon: Info },
}

export const DEFAULT_TOAST_DURATION_MS = 3000
export const ERROR_TOAST_DURATION_MS = 8000
const TOAST_EXIT_MS = 160

const Toast: React.FC<ToastProps> = ({ message, onClose }) => {
  const { t } = useI18nStore()
  const [isExiting, setIsExiting] = useState(false)
  const isError = message.type === 'error'
  const baseDuration =
    message.duration ?? (isError ? ERROR_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closedRef = useRef(false)
  const remainingRef = useRef<number>(baseDuration)
  const startedAtRef = useRef<number | null>(null)
  const hoveredRef = useRef(false)
  const focusedRef = useRef(false)

  const clearAutoTimer = useCallback(() => {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current)
      autoTimerRef.current = null
    }
  }, [])

  const handleClose = useCallback(() => {
    if (closedRef.current) return
    closedRef.current = true
    clearAutoTimer()
    startedAtRef.current = null
    setIsExiting(true)
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null
      onCloseRef.current(message.id)
    }, TOAST_EXIT_MS)
  }, [clearAutoTimer, message.id])

  const startTimer = useCallback(() => {
    if (message.duration === 0 || closedRef.current) return
    if (autoTimerRef.current) return
    const remaining = remainingRef.current
    if (remaining <= 0) {
      handleClose()
      return
    }
    startedAtRef.current = Date.now()
    autoTimerRef.current = setTimeout(() => {
      autoTimerRef.current = null
      startedAtRef.current = null
      remainingRef.current = 0
      handleClose()
    }, remaining)
  }, [handleClose, message.duration])

  const pauseTimer = useCallback(() => {
    if (!autoTimerRef.current) return
    clearAutoTimer()
    if (startedAtRef.current !== null) {
      const elapsed = Math.max(0, Date.now() - startedAtRef.current)
      remainingRef.current = Math.max(0, remainingRef.current - elapsed)
      startedAtRef.current = null
    }
  }, [clearAutoTimer])

  useEffect(() => {
    return () => {
      clearAutoTimer()
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
    }
  }, [clearAutoTimer])

  useEffect(() => {
    remainingRef.current = baseDuration
    startedAtRef.current = null
    if (message.duration === 0 || closedRef.current) return
    if (isError && (hoveredRef.current || focusedRef.current)) return
    startTimer()
    return () => {
      clearAutoTimer()
    }
  }, [message.id, message.duration, baseDuration, isError, startTimer, clearAutoTimer])

  const handleMouseEnter = () => {
    if (!isError) return
    hoveredRef.current = true
    pauseTimer()
  }

  const handleMouseLeave = () => {
    if (!isError) return
    hoveredRef.current = false
    if (!focusedRef.current) startTimer()
  }

  const handleFocus = () => {
    if (!isError) return
    focusedRef.current = true
    pauseTimer()
  }

  const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!isError) return
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node)) return
    focusedRef.current = false
    if (!hoveredRef.current) startTimer()
  }

  const { border, icon, Icon } = TOAST_STYLES[message.type]

  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      onMouseEnter={isError ? handleMouseEnter : undefined}
      onMouseLeave={isError ? handleMouseLeave : undefined}
      onFocus={isError ? handleFocus : undefined}
      onBlur={isError ? handleBlur : undefined}
      className={`flex items-start gap-2.5 border border-line border-l-2 ${border} bg-raised px-3 py-2.5 text-ink shadow-print ${
        isExiting ? 'animate-toast-out' : 'animate-toast-in'
      }`}
    >
      <Icon size={15} className={`mt-0.5 flex-shrink-0 ${icon}`} />
      <span className="flex-1 type-value text-ink">{message.message}</span>
      <button
        type="button"
        onClick={handleClose}
        aria-label={t('close')}
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-ink/10 hover:text-ink"
      >
        <X size={13} />
      </button>
    </div>
  )
}

export const ToastContainer: React.FC<{
  messages: ToastMessage[]
  onClose: (id: string) => void
  /** 只渲染属于该宿主窗口的提示；辅助窗口各挂一份 */
  host?: string
}> = ({ messages, onClose, host = 'main' }) => {
  const hostDocument = useHostDocument()
  const visible = messages.filter((msg) => (msg.host ?? 'main') === host)
  const content = (
    <div
      data-toast-portal="true"
      className="pointer-events-none fixed right-4 top-14 z-50 flex w-80 flex-col gap-2"
    >
      {visible.map((msg) => (
        <div key={msg.id} className="pointer-events-auto">
          <Toast message={msg} onClose={onClose} />
        </div>
      ))}
    </div>
  )
  return hostDocument.body ? createPortal(content, hostDocument.body) : content
}
