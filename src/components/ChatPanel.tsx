import React, { useEffect, useRef, useState } from 'react'
import { useChatStore, ChatMessage } from '../store/chatStore'
import { useEditorStore } from '../store/editorStore'
import { useDiffStore } from '../store/diffStore'
import { useI18nStore } from '../store/i18nStore'
import { handleError } from '../store/errorStore'
import { useToast } from './Toast'
import {
  initializeAgent,
  sendMessageToAgent,
  isAgentInitialized,
  setAgentContext,
} from '../api/piAgent'
import { computeDiff } from '../api/diff'

export const ChatPanel: React.FC = () => {
  const { t } = useI18nStore()
  const toast = useToast()
  const [inputValue, setInputValue] = useState('')
  const [initialized, setInitialized] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const {
    messages,
    isLoading,
    error,
    addMessage,
    setLoading,
    setError,
    setInitialized: setChatInitialized,
  } = useChatStore()

  const { openFiles, currentFile } = useEditorStore()
  const { setDiff } = useDiffStore()

  // Update agent context when files change
  useEffect(() => {
    setAgentContext({
      currentFile: currentFile?.name,
      openFiles: openFiles.map((f: any) => f.name),
    })
  }, [currentFile, openFiles])

  // Initialize agent on mount
  useEffect(() => {
    const init = async () => {
      try {
        if (!isAgentInitialized()) {
          await initializeAgent()
        }
        setInitialized(true)
        setChatInitialized(true)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        handleError(err, 'Initialize Pi Agent', (msg) => console.error(msg))
        setError(errorMsg)
      }
    }

    init()
  }, [])

  // Update agent context when files change
  useEffect(() => {
    setAgentContext({
      currentFile: currentFile?.name,
      openFiles: openFiles.map((f) => f.name),
    })
  }, [currentFile, openFiles])

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = async () => {
    const userMessage = inputValue.trim()
    if (!userMessage || !initialized) return

    try {
      setLoading(true)
      setError(null)

      // Add user message
      addMessage({
        role: 'user',
        content: userMessage,
        isLoading: false,
      })

      // Clear input
      setInputValue('')

      // Send to agent
      const response = await sendMessageToAgent(userMessage)

      if (response.isSuccess) {
        // Add assistant response
        addMessage({
          role: 'assistant',
          content: response.content,
          isLoading: false,
        })
        toast.success('收到 Pi Agent 回复', 2000)
      } else {
        // Handle error response
        const errorMsg = response.error || 'Failed to get response'
        setError(errorMsg)
        toast.error(`Agent 回复失败: ${errorMsg}`, 3000)
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      handleError(err, 'Send chat message', (msg) => console.error(msg))
      setError(errorMsg)
      toast.error('消息发送失败', 3000)
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const showCodeDiff = (original: string, modified: string, name: string) => {
    try {
      const diff = computeDiff(original, modified, `${name} (original)`, `${name} (modified)`)
      setDiff(diff)
    } catch (err) {
      handleError(err, 'Show diff', (msg) => console.error(msg))
      toast.error('Failed to show diff', 3000)
    }
  }

  // Make showCodeDiff available to message content (for future interactive features)
  useEffect(() => {
    ;(window as any).__showCodeDiff = showCodeDiff
  }, [showCodeDiff])

  if (!initialized) {
    return (
      <div className="flex flex-col h-full bg-gray-50 dark:bg-[#252526]">
        <div className="flex justify-between items-center px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <h3 className="text-sm font-semibold m-0">Pi Agent</h3>
          <span className="text-base">⏳</span>
        </div>
        <div className="flex-1 flex items-center justify-center overflow-y-auto">
          <div className="flex flex-col items-center gap-3 p-4">
            <div className="text-3xl">🔄</div>
            <div className="text-center">
              <h4 className="text-sm font-medium m-0">{t('initializing')}</h4>
              <p className="text-xs text-gray-600 dark:text-gray-400 m-0">{t('startingAgent')}</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-[#252526]">
      {/* Header */}
      <div className="flex justify-between items-center px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <h3 className="text-sm font-semibold m-0">Pi Agent</h3>
        {isLoading && <span className="text-base">⏳</span>}
      </div>

      {/* Error Banner */}
      {error && (
        <div className="px-3 py-2 bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-xs border-b border-red-300 dark:border-red-700/50">
          <p className="m-0">{error}</p>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-600 dark:text-gray-400">
            <div className="text-3xl">💬</div>
            <div className="text-center">
              <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 m-0">{t('startConversation')}</h4>
              <p className="text-xs m-0">{t('discussCode')}</p>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            {isLoading && (
              <div className="flex gap-2 p-2">
                <div className="text-lg">🤖</div>
                <div className="flex gap-1 items-end">
                  <span className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                  <span className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                  <span className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input Area */}
      <div className="flex gap-2 p-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
        <textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('inputPlaceholder')}
          disabled={isLoading}
          rows={3}
          className="flex-1 p-2 bg-white dark:bg-[#1e1e1e] text-gray-900 dark:text-gray-100 border border-gray-300 dark:border-gray-600 rounded text-sm resize-none disabled:opacity-50"
        />
        <button
          onClick={sendMessage}
          disabled={isLoading || !inputValue.trim()}
          title={t('sendMessage')}
          className="self-end px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white border-none rounded text-lg font-semibold cursor-pointer disabled:cursor-not-allowed transition-colors"
        >
          {isLoading ? '⏳' : '↗'}
        </button>
      </div>
    </div>
  )
}

interface MessageBubbleProps {
  message: ChatMessage
}

const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
  const isUser = message.role === 'user'

  return (
    <div className={`flex gap-2 p-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className="text-lg flex-shrink-0">
        {isUser ? '👤' : '🤖'}
      </div>
      <div className={`flex-1 ${isUser ? 'text-right' : 'text-left'}`}>
        <p className="text-sm text-gray-900 dark:text-gray-100 m-0 break-words">
          {message.content}
        </p>
        <span className="text-xs text-gray-500 dark:text-gray-400 block mt-1">
          {new Date(message.timestamp).toLocaleTimeString()}
        </span>
      </div>
    </div>
  )
}
