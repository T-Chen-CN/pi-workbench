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
import '../styles/ChatPanel.css'

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
      <div className="chat-panel">
        <div className="chat-header">
          <h3>Pi Agent</h3>
          <span className="chat-loading">⏳</span>
        </div>
        <div className="messages-container">
          <div className="chat-empty">
            <div className="empty-icon">🔄</div>
            <div className="empty-text">
              <h4>{t('initializing')}</h4>
              <p>{t('startingAgent')}</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <h3>Pi Agent</h3>
        {isLoading && <span className="chat-loading">⏳</span>}
      </div>

      {error && (
        <div className="chat-error">
          <p>{error}</p>
        </div>
      )}

      <div className="messages-container">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="empty-icon">💬</div>
            <div className="empty-text">
              <h4>{t('startConversation')}</h4>
              <p>{t('discussCode')}</p>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            {isLoading && (
              <div className="message message-assistant">
                <div className="message-content">
                  <div className="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      <div className="chat-input-area">
        <textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('inputPlaceholder')}
          disabled={isLoading}
          rows={3}
          className="chat-input"
        />
        <button
          onClick={sendMessage}
          disabled={isLoading || !inputValue.trim()}
          className="send-button"
          title={t('sendMessage')}
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
    <div className={`message ${isUser ? 'message-user' : 'message-assistant'}`}>
      <div className="message-avatar">
        {isUser ? '👤' : '🤖'}
      </div>
      <div className="message-content">
        <p>{message.content}</p>
        <span className="message-time">
          {new Date(message.timestamp).toLocaleTimeString()}
        </span>
      </div>
    </div>
  )
}
