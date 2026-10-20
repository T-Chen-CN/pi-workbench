import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastMessage {
  id: string
  message: string
  type: ToastType
  duration?: number
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

const Toast: React.FC<ToastProps> = ({ message, onClose }) => {
  const { t } = useI18nStore()
  const [isExiting, setIsExiting] = useState(false)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (message.duration === 0) return

    const timer = setTimeout(() => {
      setIsExiting(true)
      exitTimerRef.current = setTimeout(() => onClose(message.id), 300)
    }, message.duration || 3000)

    return () => clearTimeout(timer)
  }, [message, onClose])

  const handleClose = () => {
    setIsExiting(true)
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
    exitTimerRef.current = setTimeout(() => onClose(message.id), 300)
  }

  const { border, icon, Icon } = TOAST_STYLES[message.type]

  return (
    <div
      role="status"
      className={`flex items-start gap-2.5 border border-line border-l-2 ${border} bg-raised px-3 py-2.5 text-ink shadow-print ${
        isExiting
          ? 'animate-out slide-out-to-right-full duration-300'
          : 'animate-in slide-in-from-right-full duration-300'
      }`}
    >
      <Icon size={15} className={`mt-0.5 flex-shrink-0 ${icon}`} />
      <span className="flex-1 text-xs leading-relaxed text-ink">{message.message}</span>
      <button
        type="button"
        onClick={handleClose}
        aria-label={t('close')}
        className="flex-shrink-0 rounded p-0.5 text-ink-subtle transition-colors hover:bg-ink/10 hover:text-ink"
      >
        <X size={13} />
      </button>
    </div>
  )
}

export const ToastContainer: React.FC<{ messages: ToastMessage[]; onClose: (id: string) => void }> = ({
  messages,
  onClose,
}) => {
  return (
    <div className="pointer-events-none fixed right-4 top-14 z-50 flex w-80 flex-col gap-2">
      {messages.map((msg) => (
        <div key={msg.id} className="pointer-events-auto">
          <Toast message={msg} onClose={onClose} />
        </div>
      ))}
    </div>
  )
}

export const useToast = () => {
  const [messages, setMessages] = useState<ToastMessage[]>([])

  const show = (message: string, type: ToastType = 'info', duration?: number) => {
    const id = Math.random().toString(36).substr(2, 9)
    const toast: ToastMessage = { id, message, type, duration }
    setMessages((prev) => [...prev, toast])
  }

  const remove = (id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id))
  }

  return {
    messages,
    show,
    remove,
    success: (msg: string, duration?: number) => show(msg, 'success', duration),
    error: (msg: string, duration?: number) => show(msg, 'error', duration),
    warning: (msg: string, duration?: number) => show(msg, 'warning', duration),
    info: (msg: string, duration?: number) => show(msg, 'info', duration),
  }
}
