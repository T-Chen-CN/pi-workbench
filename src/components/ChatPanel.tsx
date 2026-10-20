import React, { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chatStore'
import { useDiffStore } from '../store/diffStore'
import { useEditorStore } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { piAgentAPI } from '../api/piAgentAPI'
import { api } from '../api'
import { buildContextPrompt } from '../api/chatContext'
import { toast } from '../store/toastStore'

interface ChatPanelProps {
  workspacePath: string
}

/** 单个附件与单条消息的上下文字符上限 */
const MAX_CONTEXT_FILE_CHARS = 120_000
const MAX_CONTEXT_TOTAL_CHARS = 300_000

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
    attachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
  } = useChatStore()

  const openFiles = useEditorStore((state) => state.openFiles)
  const { t } = useI18nStore()

  const openEdits = useDiffStore((state) => state.openEdits)

  const [input, setInput] = useState('')
  const [initialized, setInitialized] = useState(false)
  const [needsApiKey, setNeedsApiKey] = useState(false)
  const [showAttachMenu, setShowAttachMenu] = useState(false)
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

    setShowAttachMenu(false)
    setLoading(true)

    // 先插入流式占位消息，文本增量到达时直接追加
    const assistantId = startStreamingMessage()
    try {
      // 读取附件内容并注入本轮 prompt；用户气泡只显示原始文本
      const contextFiles: Array<{ path: string; content: string }> = []
      let totalChars = 0
      for (const attachment of attachments) {
        const file = await api.readFile(attachment.path)
        if (!file.success || typeof file.content !== 'string') {
          toast.error(`${t('contextReadFailed')}: ${attachment.name}`)
          continue
        }
        if (file.content.length > MAX_CONTEXT_FILE_CHARS) {
          toast.error(`${t('contextTooLarge')}: ${attachment.name}`)
          continue
        }
        if (totalChars + file.content.length > MAX_CONTEXT_TOTAL_CHARS) {
          toast.error(t('contextTotalTooLarge'))
          break
        }
        totalChars += file.content.length
        contextFiles.push({ path: attachment.path, content: file.content })
      }
      const prompt = buildContextPrompt(userMessage, contextFiles)

      const result = await piAgentAPI.chat(prompt, (delta) => {
        appendToMessage(assistantId, delta)
      })

      if (result.success && result.response) {
        setError(null)
        // 最终消息以主进程返回的完整文本为准
        finishStreamingMessage(assistantId, result.response)

        // 打开本轮全部文件修改供审阅（接受或还原）
        if (result.edits && result.edits.length > 0) {
          openEdits(result.edits)
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
      clearAttachments()
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
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((attachment) => (
              <span
                key={attachment.path}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300"
                title={attachment.path}
              >
                📄 {attachment.name}
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.path)}
                  title={t('removeAttachment')}
                  className="bg-none border-none cursor-pointer text-gray-500 hover:text-gray-200"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex gap-2">
          <div className="relative flex">
            <button
              type="button"
              onClick={() => setShowAttachMenu((open) => !open)}
              disabled={!initialized || isLoading}
              title={t('attachContext')}
              className="px-3 rounded border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ＋
            </button>
            {showAttachMenu && (
              <div className="absolute bottom-full left-0 mb-2 w-72 max-h-64 overflow-y-auto bg-gray-800 border border-gray-700 rounded shadow-lg z-10">
                <div className="px-3 py-2 text-xs text-gray-400 border-b border-gray-700">
                  {t('attachContext')}
                </div>
                {openFiles.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-gray-500">{t('noOpenFiles')}</div>
                ) : (
                  openFiles.map((file) => {
                    const attached = attachments.some((item) => item.path === file.path)
                    return (
                      <button
                        key={file.path}
                        type="button"
                        disabled={attached}
                        onClick={() => {
                          addAttachment({ path: file.path, name: file.name })
                          setShowAttachMenu(false)
                        }}
                        className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed bg-none border-none cursor-pointer"
                      >
                        <div>{file.name}</div>
                        <div className="text-xs text-gray-500 truncate">{file.path}</div>
                      </button>
                    )
                  })
                )}
              </div>
            )}
          </div>
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
