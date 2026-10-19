import React, { useEffect, useState } from 'react'

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

const Toast: React.FC<ToastProps> = ({ message, onClose }) => {
  const [isExiting, setIsExiting] = useState(false)

  useEffect(() => {
    if (message.duration === 0) return

    const timer = setTimeout(() => {
      setIsExiting(true)
      setTimeout(() => onClose(message.id), 300)
    }, message.duration || 3000)

    return () => clearTimeout(timer)
  }, [message, onClose])

  const handleClose = () => {
    setIsExiting(true)
    setTimeout(() => onClose(message.id), 300)
  }

  return (
    <div className={`toast toast-${message.type} ${isExiting ? 'toast-exit' : ''}`}>
      <span className="toast-icon">
        {message.type === 'success' && '✓'}
        {message.type === 'error' && '✕'}
        {message.type === 'warning' && '⚠'}
        {message.type === 'info' && 'ℹ'}
      </span>
      <span className="toast-message">{message.message}</span>
      <button className="toast-close" onClick={handleClose}>
        ×
      </button>
    </div>
  )
}

export const ToastContainer: React.FC<{ messages: ToastMessage[]; onClose: (id: string) => void }> = ({
  messages,
  onClose,
}) => {
  return (
    <div className="toast-container">
      {messages.map((msg) => (
        <Toast key={msg.id} message={msg} onClose={onClose} />
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
