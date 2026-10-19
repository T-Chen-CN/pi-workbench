import React, { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chatStore'
import { piAgentAPI } from '../api/piAgentAPI'
import { api } from '../api'

export const ChatPanel: React.FC = () => {
  const {
    messages,
    isLoading,
    error,
    addMessage,
    setLoading,
    setError,
  } = useChatStore()

  const [input, setInput] = useState('')
  const [initialized, setInitialized] = useState(false)
  const [needsApiKey, setNeedsApiKey] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Initialize agent on mount
  useEffect(() => {
    const init = async () => {
      try {
        setLoading(true)

        // 检查是否配置了 API Key
        const apiKeysResult = await api.apiKeysGet()
        if (!apiKeysResult.success || !apiKeysResult.apiKeys?.anthropic) {
          setNeedsApiKey(true)
          setLoading(false)
          return
        }

        // 初始化 Agent（使用当前工作目录作为workspace）
        const result = await piAgentAPI.initialize({
          workspaceDir: process.cwd(),
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
        })

        if (result.success) {
          setInitialized(true)
          addMessage({
            role: 'assistant',
            content: 'Pi Agent is ready! How can I help you with your code today?',
            timestamp: new Date(),
          })
        } else {
          setError(result.error || 'Failed to initialize agent')
          setNeedsApiKey(true)
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        setError(errorMsg)
        console.error('[ChatPanel] Initialize error:', err)
      } finally {
        setLoading(false)
      }
    }

    init()

    // Cleanup on unmount
    return () => {
      piAgentAPI.dispose()
    }
  }, [])

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()

    if (!input.trim() || isLoading) return

    const userMessage = input.trim()
    setInput('')

    // Add user message
    addMessage({
      role: 'user',
      content: userMessage,
      timestamp: new Date(),
    })

    // Send to agent
    setLoading(true)
    try {
      const result = await piAgentAPI.chat(userMessage)

      if (result.success && result.response) {
        addMessage({
          role: 'assistant',
          content: result.response,
          timestamp: new Date(),
        })
      } else {
        setError(result.error || 'Failed to get response from agent')
        addMessage({
          role: 'assistant',
          content: `Error: ${result.error || 'Failed to get response'}`,
          timestamp: new Date(),
        })
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      addMessage({
        role: 'assistant',
        content: `Error: ${errorMsg}`,
        timestamp: new Date(),
      })
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  if (needsApiKey) {
    return (
      <div className="flex flex-col h-full bg-gray-900 p-6">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md">
            <h3 className="text-xl font-bold text-gray-100 mb-4">
              API Key Required
            </h3>
            <p className="text-gray-400 mb-6">
              Please configure your Anthropic API key in Settings to use Pi Agent.
            </p>
            <a
              href="#settings"
              className="inline-block bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded font-medium transition-colors"
              onClick={(e) => {
                e.preventDefault()
                // TODO: 触发 Settings 面板打开
                alert('Please open Settings from the sidebar to configure API keys')
              }}
            >
              Go to Settings
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Header */}
      <div className="border-b border-gray-700 p-4">
        <h3 className="text-lg font-semibold text-gray-100">
          Pi Agent Chat
          {initialized && <span className="ml-2 text-xs text-green-400">● Ready</span>}
          {!initialized && <span className="ml-2 text-xs text-yellow-400">● Initializing...</span>}
        </h3>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-lg p-3 ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-100'
              }`}
            >
              <div className="text-sm font-medium mb-1">
                {msg.role === 'user' ? 'You' : 'Pi Agent'}
              </div>
              <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
              <div className="text-xs mt-2 opacity-70">
                {msg.timestamp.toLocaleTimeString()}
              </div>
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-800 text-gray-100 rounded-lg p-3">
              <div className="text-sm font-medium mb-1">Pi Agent</div>
              <div className="text-sm">Thinking...</div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex justify-center">
            <div className="bg-red-900/20 border border-red-600 text-red-400 rounded-lg p-3 max-w-[80%]">
              <div className="text-sm font-medium mb-1">Error</div>
              <div className="text-sm">{error}</div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-700 p-4">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message... (Shift+Enter for new line)"
            disabled={!initialized || isLoading}
            className="flex-1 bg-gray-800 text-gray-100 px-4 py-2 rounded border border-gray-700 focus:outline-none focus:border-blue-500 resize-none disabled:opacity-50 disabled:cursor-not-allowed"
            rows={3}
          />
          <button
            type="submit"
            disabled={!initialized || isLoading || !input.trim()}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  )
}
