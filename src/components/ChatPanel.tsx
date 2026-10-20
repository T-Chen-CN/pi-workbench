import React, { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chatStore'
import { useDiffStore } from '../store/diffStore'
import { piAgentAPI } from '../api/piAgentAPI'
import { api } from '../api'
import { computeDiff } from '../api/diff'
import { toast } from '../store/toastStore'

interface ChatPanelProps {
  workspacePath: string
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ workspacePath }) => {
  const {
    messages,
    isLoading,
    error,
    addMessage,
    setMessages,
    setLoading,
    setError,
    startStreamingMessage,
    appendToMessage,
    finishStreamingMessage,
  } = useChatStore()

  const setDiff = useDiffStore((state) => state.setDiff)

  const [input, setInput] = useState('')
  const [initialized, setInitialized] = useState(false)
  const [needsApiKey, setNeedsApiKey] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Initialize agent on mount
  const initSeqRef = useRef(0)

  useEffect(() => {
    const doInit = async (seq: number) => {
      try {
        setInitialized(false)
        setLoading(true)

        // Load API configuration
        const configResult = await api.apiConfigGet()
        if (seq !== initSeqRef.current) return
        if (!configResult.success || !configResult.config || !configResult.config.apiKey) {
          setNeedsApiKey(true)
          setLoading(false)
          return
        }

        // Initialize Agent with full API config
        const result = await piAgentAPI.initialize({
          workspaceDir: workspacePath,
          apiConfig: configResult.config
        })
        if (seq !== initSeqRef.current) return

        if (result.success) {
          setError(null)
          setInitialized(true)

          // 恢复该工作区持久化的对话历史
          const history = await piAgentAPI.getHistory()
          if (seq !== initSeqRef.current) return

          if (history.success && history.history && history.history.length > 0) {
            setMessages(history.history)
          } else if (useChatStore.getState().messages.length === 0) {
            addMessage({
              role: 'assistant',
              content: `Pi Agent (${configResult.config.selectedModel}) is ready! How can I help you with your code today?`,
            })
          }
        } else {
          setError(result.error || 'Failed to initialize agent')
          setNeedsApiKey(true)
        }
      } catch (err) {
        if (seq !== initSeqRef.current) return
        const errorMsg = err instanceof Error ? err.message : String(err)
        setError(errorMsg)
        console.error('[ChatPanel] Initialize error:', err)
      } finally {
        if (seq === initSeqRef.current) setLoading(false)
      }
    }

    const runInit = () => {
      const seq = ++initSeqRef.current
      void doInit(seq)
    }

    runInit()

    // Settings 保存新 API 配置后重新初始化 Agent
    const handleConfigSaved = () => runInit()
    window.addEventListener('api-config-saved', handleConfigSaved)

    // Cleanup on unmount
    return () => {
      // 使旧的初始化流程失效（含 React StrictMode 的双重挂载）
      // eslint-disable-next-line react-hooks/exhaustive-deps
      initSeqRef.current++
      window.removeEventListener('api-config-saved', handleConfigSaved)
      piAgentAPI.dispose()
    }
  }, [workspacePath, addMessage, setError, setLoading, setMessages])

  // Auto-scroll to bottom
  useEffect(() => {
    // 流式更新时用即时滚动，避免每个增量都触发平滑滚动动画
    const streaming = useChatStore.getState().messages.some((message) => message.isStreaming)
    messagesEndRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' })
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
    })

    // Send to agent
    setLoading(true)
    // 先插入流式占位消息，文本增量到达时直接追加
    const assistantId = startStreamingMessage()
    try {
      const result = await piAgentAPI.chat(userMessage, (delta) => {
        appendToMessage(assistantId, delta)
      })

      if (result.success && result.response) {
        setError(null)
        // 最终消息以主进程返回的完整文本为准
        finishStreamingMessage(assistantId, result.response)

        // 展示 Agent 本轮修改（最后一个改动的文件）
        if (result.edits && result.edits.length > 0) {
          const lastEdit = result.edits[result.edits.length - 1]
          setDiff(computeDiff(lastEdit.oldContent, lastEdit.newContent, `${lastEdit.path} (before)`, lastEdit.path))
          toast.info(`Agent modified ${result.edits.length} file(s)`)
        }
      } else {
        const errorMessage = result.error || 'Failed to get response from agent'
        setError(errorMessage)
        finishStreamingMessage(assistantId, `Error: ${errorMessage}`)
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      finishStreamingMessage(assistantId, `Error: ${errorMsg}`)
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
              API Configuration Required
            </h3>
            <p className="text-gray-400 mb-6">
              Please configure your API provider, URL, key and model in Settings to use Pi Agent.
            </p>
            <button
              className="inline-block bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded font-medium transition-colors border-none cursor-pointer"
              onClick={() => window.dispatchEvent(new CustomEvent('open-settings'))}
            >
              Go to Settings
            </button>
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
        {messages.map((msg) => {
          // 流式消息还没有内容时显示下方的 Thinking 占位
          if (msg.isStreaming && !msg.content) return null
          return (
            <div
              key={msg.id}
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
                <div className="text-sm whitespace-pre-wrap">
                  {msg.content}
                  {msg.isStreaming && (
                    <span className="inline-block w-1.5 h-3.5 ml-0.5 align-text-bottom bg-gray-400 animate-pulse" />
                  )}
                </div>
                <div className="text-xs mt-2 opacity-70">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </div>
              </div>
            </div>
          )
        })}

        {isLoading && !messages.some((msg) => msg.isStreaming && msg.content) && (
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
