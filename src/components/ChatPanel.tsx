import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import {
  AlertCircle,
  Check,
  Copy,
  FileText,
  Paperclip,
  Send,
  Settings2,
  Square,
  X,
} from 'lucide-react'
import { useChatStore, type ChatMessage } from '../store/chatStore'
import { useSelectionStore } from '../store/selectionStore'
import { useDiffStore } from '../store/diffStore'
import { useEditorStore } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { piAgentAPI } from '../api/piAgentAPI'
import { api } from '../api'
import { buildContextPrompt } from '../api/chatContext'
import { localizeError } from '../i18n/errors'
import { commandPaletteShortcut } from '../utils/shortcuts'
import { toast } from '../store/toastStore'
import { useVirtualRows } from '../hooks/useVirtualRows'
import { Button, Caption, DataText, EmptyState, IconButton, Label, Spinner, Textarea } from './ui'

interface ChatPanelProps {
  workspacePath: string
}

/** 单个附件与单条消息的上下文字符上限 */
const MAX_CONTEXT_FILE_CHARS = 120_000
const MAX_CONTEXT_SNIPPET_CHARS = 40_000
const MAX_CONTEXT_TOTAL_CHARS = 300_000

/** 代码块：带复制按钮 */
const CodeBlock: React.FC<{ children?: React.ReactNode }> = ({ children }) => {  const { t } = useI18nStore()
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    const text = preRef.current?.textContent ?? ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      console.error('Failed to copy code:', error)
    }
  }

  return (
    <div className="group/code relative">
      <pre ref={preRef}>{children}</pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={t('copyCode')}
        className="absolute right-2 top-2 flex items-center gap-1 rounded border border-rule-control bg-raised px-1.5 py-1 type-caption text-ink-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/code:opacity-100 group-focus-within/code:opacity-100"
      >
        {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
        {copied ? t('copied') : t('copyCode')}
      </button>
    </div>
  )
}

const REMARK_PLUGINS = [remarkGfm]
const HIGHLIGHT_PLUGINS = [rehypeHighlight]
const NO_PLUGINS: [] = []

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
}

/** 单条消息；memo 保证流式追加只重渲染最后一条 */
const ChatMessageRow = React.memo(function ChatMessageRow({
  message,
}: {
  message: ChatMessage
}) {
  const { t, language } = useI18nStore()

  // 流式消息还没有内容时显示下方的 Thinking 占位
  if (message.isStreaming && !message.content) return null
  const isUser = message.role === 'user'

  return (
    <div
      data-testid="chat-message"
      className="border-b border-rule-divide py-3 first:pt-0 last:border-b-0"
    >
      <div className="mb-1.5 flex items-baseline gap-2">
        <Label className="text-ink">{isUser ? t('roleYou') : t('piAgent')}</Label>
        <Caption className="text-ink-muted">
          {new Date(message.timestamp).toLocaleTimeString(
            language === 'zh' ? 'zh-CN' : 'en-US'
          )}
        </Caption>
      </div>
      {isUser ? (
        <div className="flex gap-2 type-reading text-ink">
          <span className="type-project text-accent">›</span>
          <span className="whitespace-pre-wrap">{message.content}</span>
        </div>
      ) : (
        <div className="chat-markdown text-ink">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            // 超长消息跳过语法高亮，避免一次性高亮阻塞滚动
            rehypePlugins={message.content.length > 20_000 ? NO_PLUGINS : HIGHLIGHT_PLUGINS}
            components={MARKDOWN_COMPONENTS}
          >
            {message.content}
          </ReactMarkdown>
          {message.isStreaming && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-text-bottom" />
          )}
          {message.usage && (
            <Caption className="mt-1 block text-ink-muted">
              {message.usage.totalTokens.toLocaleString()} tokens
              {message.usage.cost > 0 ? ` · $${message.usage.cost.toFixed(4)}` : ''}
            </Caption>
          )}
        </div>
      )}
    </div>
  )
})

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
    setMessageUsage,
    attachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
    draftInput,
    clearDraftInput,
  } = useChatStore()

  const openFiles = useEditorStore((state) => state.openFiles)
  const selection = useSelectionStore((state) => state.selection)
  const { t } = useI18nStore()

  const openEdits = useDiffStore((state) => state.openEdits)

  const [input, setInput] = useState('')
  const [initialized, setInitialized] = useState(false)
  const [needsApiKey, setNeedsApiKey] = useState(false)
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { parentRef: transcriptRef, virtualizer } = useVirtualRows({
    count: messages.length,
    estimateSize: 96,
    overscan: 8,
  })
  const stickToBottomRef = useRef(true)

  // Initialize agent on mount
  const initSeqRef = useRef(0)

  useEffect(() => {
    const doInit = async (seq: number) => {
      try {
        setInitialized(false)
        setNeedsApiKey(false)
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
          apiConfig: configResult.config,
        })
        if (seq !== initSeqRef.current) return

        if (result.success) {
          setError(null)
          const status = await piAgentAPI.isInitialized(workspacePath)
          if (seq !== initSeqRef.current) return
          setInitialized(status.success ? Boolean(status.initialized) : true)

          // 恢复该工作区持久化的对话历史
          const history = await piAgentAPI.getHistory(workspacePath)
          if (seq !== initSeqRef.current) return

          if (history.success && history.history && history.history.length > 0) {
            setMessages(
              history.history.map((message, index) => ({
                ...message,
                id: `history-${index}-${message.timestamp}`,
              }))
            )
          } else if (useChatStore.getState().messages.length === 0) {
            addMessage({
              role: 'assistant',
              content: t('agentReadyMessage', { model: configResult.config.selectedModel }),
            })
          }
        } else {
          setError(result.error ? localizeError(result.error) : t('agentInitFailed'))
          setNeedsApiKey(true)
        }
      } catch (err) {
        if (seq !== initSeqRef.current) return
        const errorMsg = err instanceof Error ? err.message : String(err)
        setError(localizeError(errorMsg))
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

    return () => {
      // 使旧的初始化流程失效（含 React StrictMode 的双重挂载）
      // eslint-disable-next-line react-hooks/exhaustive-deps
      initSeqRef.current++
      window.removeEventListener('api-config-saved', handleConfigSaved)
      // 切换工作区时保留各工作区的 Agent 实例；关闭工作区由 App 显式 dispose
    }
  }, [workspacePath, addMessage, setError, setLoading, setMessages, t])

  // 命令面板：把当前选区附加到对话
  useEffect(() => {
    const onAttachSelection = () => {
      const current = useSelectionStore.getState().selection
      if (!current) {
        toast.error(t('selectionEmpty'))
        return
      }
      addAttachment({
        kind: 'snippet',
        path: current.path,
        name: current.name,
        startLine: current.startLine,
        endLine: current.endLine,
        content: current.text,
      })
      toast.success(t('selectionAttached'))
    }
    window.addEventListener('attach-selection', onAttachSelection)
    return () => window.removeEventListener('attach-selection', onAttachSelection)
  }, [addAttachment, t])

  // 用户停留在底部时才跟随新消息；往上翻阅时不打断阅读
  useEffect(() => {
    if (!stickToBottomRef.current || messages.length === 0) return
    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
    })
    return () => cancelAnimationFrame(frame)
  }, [messages, virtualizer])

  const handleTranscriptScroll = () => {
    const element = transcriptRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    stickToBottomRef.current = distance < 64
  }

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 欢迎页提问：把草稿带入输入框
  useEffect(() => {
    if (!draftInput) return
    setInput(draftInput)
    clearDraftInput()
    inputRef.current?.focus()
  }, [workspacePath, draftInput, clearDraftInput])

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault()

    if (!input.trim() || isLoading) return

    const userMessage = input.trim()
    setInput('')

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
      const contextFiles: Array<{
        path: string
        content: string
        startLine?: number
        endLine?: number
      }> = []
      let totalChars = 0
      for (const attachment of attachments) {
        let content: string
        if (attachment.kind === 'snippet') {
          content = attachment.content ?? ''
          if (!content) continue
          if (content.length > MAX_CONTEXT_SNIPPET_CHARS) {
            toast.error(`${t('contextTooLarge')}: ${attachment.name}`)
            continue
          }
        } else {
          const file = await api.readFile(attachment.path)
          if (!file.success || typeof file.content !== 'string') {
            toast.error(`${t('contextReadFailed')}: ${attachment.name}`)
            continue
          }
          if (file.content.length > MAX_CONTEXT_FILE_CHARS) {
            toast.error(`${t('contextTooLarge')}: ${attachment.name}`)
            continue
          }
          content = file.content
        }
        if (totalChars + content.length > MAX_CONTEXT_TOTAL_CHARS) {
          toast.error(t('contextTotalTooLarge'))
          break
        }
        totalChars += content.length
        contextFiles.push({
          path: attachment.path,
          content,
          startLine: attachment.startLine,
          endLine: attachment.endLine,
        })
      }
      const prompt = buildContextPrompt(userMessage, contextFiles)

      const result = await piAgentAPI.chat(prompt, (delta) => {
        appendToMessage(assistantId, delta)
      }, workspacePath)

      if (result.success && result.response) {
        setError(null)
        finishStreamingMessage(assistantId, result.response)
        if (result.usage) {
          setMessageUsage(assistantId, result.usage)
        }

        // 打开本轮全部文件修改供审阅（接受或还原）
        if (result.edits && result.edits.length > 0) {
          openEdits(result.edits)
          toast.info(t('agentModifiedFiles', { count: result.edits.length }))
        }
      } else {
        const errorMessage = result.error ? localizeError(result.error) : t('agentResponseFailed')
        setError(errorMessage)
        finishStreamingMessage(assistantId, t('errorPrefix', { message: errorMessage }))
      }
    } catch (err) {
      const errorMsg = localizeError(err instanceof Error ? err.message : String(err))
      setError(errorMsg)
      finishStreamingMessage(assistantId, t('errorPrefix', { message: errorMsg }))
    } finally {
      setLoading(false)
      clearAttachments()
      inputRef.current?.focus()
    }
  }

  const handleStop = async () => {
    await piAgentAPI.abort(workspacePath)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  if (needsApiKey) {
    return (
      <div className="flex h-full flex-col bg-panel">
        <div className="flex flex-1 items-center justify-center p-4">
          <EmptyState
            icon={Settings2}
            title={t('apiConfigRequired')}
            description={t('apiConfigRequiredDesc')}
            action={
              <Button
                variant="primary"
                size="sm"
                icon={Settings2}
                onClick={() => window.dispatchEvent(new CustomEvent('open-settings'))}
              >
                {t('goToSettings')}
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-panel">
      {/* Header */}
      <div className="flex h-[38px] flex-shrink-0 items-center justify-between border-b border-rule-divide px-3.5">
        <div className="flex items-center gap-2.5">
          <h3 className="m-0 type-label text-ink-muted">
            {t('agentChatTitle')}
          </h3>
          <span className="flex items-center gap-1.5 type-caption text-ink-muted">
            <span
              className={`h-1 w-1 rounded-full ${
                initialized ? 'bg-success' : 'animate-pulse bg-warning'
              }`}
            />
            {initialized ? t('agentReadyStatus') : t('agentInitializingStatus')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="border border-rule-control px-1.5 py-0.5 type-key text-ink-muted">
            {commandPaletteShortcut()}
          </span>
          <IconButton
            icon={Settings2}
            label={t('settings')}
            size="sm"
            onClick={() => window.dispatchEvent(new CustomEvent('open-settings'))}
          />
        </div>
      </div>

      {/* Transcript */}
      <div
        ref={transcriptRef}
        onScroll={handleTranscriptScroll}
        data-testid="chat-transcript"
        className="flex-1 overflow-y-auto px-3.5 py-3"
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().length > 0
            ? virtualizer.getVirtualItems().map((virtualRow) => {
                const msg = messages[virtualRow.index]
                if (!msg) return null
                return (
                  <div
                    key={msg.id}
                    data-index={virtualRow.index}
                    ref={typeof ResizeObserver !== 'undefined' ? virtualizer.measureElement : undefined}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <ChatMessageRow message={msg} />
                  </div>
                )
              })
            : messages
                .slice(0, 30)
                .map((msg) => <ChatMessageRow key={msg.id} message={msg} />)}
        </div>

        {isLoading && !messages.some((msg) => msg.isStreaming && msg.content) && (
          <div className="flex items-center gap-2 border-b border-rule-divide py-3 type-value text-ink-muted last:border-b-0">
            <Spinner size={12} />
            {t('thinking')}
          </div>
        )}

        {error && (
          <div className="mt-3 flex items-start gap-2 border-l-2 border-danger bg-danger/5 py-2 pl-3 type-caption text-danger">
            <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
            <span className="leading-relaxed">{error}</span>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="flex-shrink-0 p-2.5">
        {attachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => {
              const label =
                attachment.kind === 'snippet'
                  ? `${attachment.name}:${attachment.startLine}–${attachment.endLine}`
                  : attachment.name
              return (
                <span
                  key={attachment.id}
                  className="inline-flex items-center gap-1 border border-rule-control bg-sunken px-2 py-1 type-data text-ink-muted"
                  title={
                    attachment.kind === 'snippet'
                      ? `${attachment.path}:${attachment.startLine}-${attachment.endLine}`
                      : attachment.path
                  }
                >
                  <FileText size={10} className="text-ink-muted" />
                  {label}
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment.id)}
                    title={t('removeAttachment')}
                    aria-label={t('removeAttachment')}
                    className="ml-0.5 p-0.5 text-ink-muted hover:text-ink"
                  >
                    <X size={10} />
                  </button>
                </span>
              )
            })}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="border border-rule-control bg-sunken transition-colors focus-within:border-accent"
        >
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('inputPlaceholder')}
            disabled={!initialized || isLoading}
            rows={3}
            className="min-h-[68px] max-h-40 border-none bg-transparent px-3 py-2 focus:ring-0"
          />
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <div className="relative flex items-center gap-1">
              <IconButton
                icon={Paperclip}
                label={t('attachContext')}
                size="sm"
                disabled={!initialized || isLoading}
                onClick={() => setShowAttachMenu((open) => !open)}
              />
              {showAttachMenu && (
                <div className="absolute bottom-full left-0 z-10 mb-2 max-h-64 w-72 overflow-y-auto border border-line bg-raised py-1 shadow-print">
                  <div className="px-3 py-1.5 type-label text-ink-muted">
                    {t('attachContext')}
                  </div>
                  <button
                    type="button"
                    disabled={!selection}
                    onClick={() => {
                      if (!selection) return
                      addAttachment({
                        kind: 'snippet',
                        path: selection.path,
                        name: selection.name,
                        startLine: selection.startLine,
                        endLine: selection.endLine,
                        content: selection.text,
                      })
                      setShowAttachMenu(false)
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink hover:bg-hover disabled:opacity-40"
                  >
                    <FileText size={12} className="flex-shrink-0 text-ink-muted" />
                    <span className="flex min-w-0 flex-col">
                      <span>{t('attachSelection')}</span>
                      <DataText className="truncate text-ink-muted">
                        {selection
                          ? `${selection.name}:${selection.startLine}–${selection.endLine}`
                          : t('noSelection')}
                      </DataText>
                    </span>
                  </button>
                  <div className="my-1 border-t border-rule-divide" />
                  {openFiles.length === 0 && !selection ? (
                    <div className="px-3 py-2 type-caption text-ink-muted">{t('noOpenFiles')}</div>
                  ) : (
                    openFiles.map((file) => {
                      const attached = attachments.some(
                        (item) => item.kind === 'file' && item.path === file.path
                      )
                      return (
                        <button
                          key={file.path}
                          type="button"
                          disabled={attached}
                          onClick={() => {
                            addAttachment({ kind: 'file', path: file.path, name: file.name })
                            setShowAttachMenu(false)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-value text-ink hover:bg-hover disabled:opacity-40"
                        >
                          <FileText size={12} className="flex-shrink-0 text-ink-muted" />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate">{file.name}</span>
                            <DataText className="truncate text-ink-muted">
                              {file.path}
                            </DataText>
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>
              )}
            </div>

            {isLoading ? (
              <Button variant="danger" size="sm" icon={Square} onClick={() => void handleStop()}>
                {t('stop')}
              </Button>
            ) : (
              <Button
                type="submit"
                variant="primary"
                size="sm"
                icon={Send}
                disabled={!initialized || !input.trim()}
              >
                {t('send')}
              </Button>
            )}
          </div>
        </form>
        <p className="mb-0 mt-1.5 px-0.5 type-caption text-ink-muted">
          {t('chatInputHint')}
        </p>
      </div>
    </div>
  )
}
