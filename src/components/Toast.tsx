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

  const colors = {
    success: 'border-l-4 border-green-500 bg-green-50 dark:bg-green-900/20',
    error: 'border-l-4 border-red-500 bg-red-50 dark:bg-red-900/20',
    warning: 'border-l-4 border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20',
    info: 'border-l-4 border-blue-500 bg-blue-50 dark:bg-blue-900/20',
  }

  const iconColors = {
    success: 'text-green-600 dark:text-green-400',
    error: 'text-red-600 dark:text-red-400',
    warning: 'text-yellow-600 dark:text-yellow-400',
    info: 'text-blue-600 dark:text-blue-400',
  }

  const textColors = {
    success: 'text-green-800 dark:text-green-200',
    error: 'text-red-800 dark:text-red-200',
    warning: 'text-yellow-800 dark:text-yellow-200',
    info: 'text-blue-800 dark:text-blue-200',
  }

  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded bg-white dark:bg-[#252526] shadow-lg ${colors[message.type]} ${
        isExiting ? 'animate-out slide-out-to-right-full duration-300' : 'animate-in slide-in-from-right-full duration-300'
      }`}
    >
      <span className={`text-lg font-bold flex-shrink-0 ${iconColors[message.type]}`}>
        {message.type === 'success' && '✓'}
        {message.type === 'error' && '✕'}
        {message.type === 'warning' && '⚠'}
        {message.type === 'info' && 'ℹ'}
      </span>
      <span className={`flex-1 text-sm font-medium ${textColors[message.type]}`}>
        {message.message}
      </span>
      <button
        onClick={handleClose}
        className={`flex-shrink-0 bg-none border-none cursor-pointer text-lg font-bold transition-colors ${textColors[message.type]} hover:opacity-75`}
      >
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
    <div className="fixed top-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
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
