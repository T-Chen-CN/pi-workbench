/** 聊天记录滚动区 */

import React from 'react'
import { AlertCircle, History } from 'lucide-react'
import { useChatStore, type ChatMessage } from '../store/chatStore'
import type { StructuredPlan } from '../types/electron'
import type { useVirtualRows } from '../hooks/useVirtualRows'
import { ChatMessageRow } from './ChatMessageRow'
import { VirtualRows } from './VirtualRows'
import { Button, EmptyState, Spinner } from './ui'
import { emitAppEvent } from '../utils/appEvents'

interface Suggestion {
  id: string
  label: string
  prompt: string
}

export interface ChatTranscriptProps {
  activeSessionId: string | null
  activeKey: string | null
  handleNewSession: () => void | Promise<void>
  t: (key: any, params?: any) => string
  transcriptRef: React.RefObject<HTMLDivElement | null>
  handleTranscriptScroll: () => void
  messages: ChatMessage[]
  isLoading: boolean
  initialized: boolean
  emptySuggestions: Suggestion[]
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  virtualizer: ReturnType<typeof useVirtualRows>['virtualizer']
  diffToolIds: Set<string>
  openToolDiff: (toolCallId: string) => void
  handleCopyMessage: (text: string) => void | Promise<void>
  handleSwitchBranch: (entryId: string) => void | Promise<void>
  handleOpenToolResult: (toolCallId: string, toolName: string) => void
  latestProposedPlan: { messageId: string; plan: StructuredPlan } | null
  handleApprovePlan: (plan: StructuredPlan, mode: 'ask' | 'auto') => void | Promise<void>
  handleRejectPlan: (plan: StructuredPlan) => void | Promise<void>
  lastMessageId: string | null
  lastUserMessageId: string | null
  handleRetryMessage: (message: ChatMessage) => void | Promise<void>
  handleEditMessage: (message: ChatMessage) => void | Promise<void>
  error: string | null
  fatalError: string | null
  lastAssistantMessage: ChatMessage | null
}

export const ChatTranscript: React.FC<ChatTranscriptProps> = ({
  activeSessionId,
  activeKey,
  handleNewSession,
  t,
  transcriptRef,
  handleTranscriptScroll,
  messages,
  isLoading,
  initialized,
  emptySuggestions,
  inputRef,
  virtualizer,
  diffToolIds,
  openToolDiff,
  handleCopyMessage,
  handleSwitchBranch,
  handleOpenToolResult,
  latestProposedPlan,
  handleApprovePlan,
  handleRejectPlan,
  lastMessageId,
  lastUserMessageId,
  handleRetryMessage,
  handleEditMessage,
  error,
  fatalError,
  lastAssistantMessage,
}) => (
  <>
      {!activeSessionId ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <EmptyState
            icon={History}
            title={t('sessionsEmpty')}
            action={
              <Button variant="primary" size="sm" onClick={() => void handleNewSession()}>
                {t('newSession')}
              </Button>
            }
          />
        </div>
      ) : (
        <div
          ref={transcriptRef}
          onScroll={handleTranscriptScroll}
          data-testid="chat-transcript"
          className="flex-1 overflow-y-auto px-3.5 py-3"
        >
          {messages.length === 0 && !isLoading ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <EmptyState
                compact
                icon={History}
                title={t('agentChatTitle')}
                description={initialized ? undefined : t('agentInitializingStatus')}
              />
              {initialized && activeKey && (
                <div className="flex max-w-md flex-wrap justify-center gap-1.5">
                  {emptySuggestions.map((suggestion) => (
                    <button
                      key={suggestion.id}
                      type="button"
                      onClick={() => {
                        useChatStore.getState().setDraftInput(activeKey, suggestion.prompt)
                        inputRef.current?.focus()
                      }}
                      className="border border-rule-control px-2 py-1 type-caption text-ink-muted transition-colors hover:bg-hover hover:text-ink"
                    >
                      {suggestion.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <VirtualRows
              virtualizer={virtualizer}
              items={messages}
              getKey={(msg) => msg.id}
              measure
              renderItem={(msg) => (
                <ChatMessageRow
                  message={msg}
                  conversationKey={activeKey ?? undefined}
                  diffToolIds={diffToolIds}
                  onOpenDiff={openToolDiff}
                  onCopy={handleCopyMessage}
                  onSwitchBranch={handleSwitchBranch}
                  onOpenToolResult={handleOpenToolResult}
                  canActOnPlan={!isLoading && msg.id === latestProposedPlan?.messageId}
                  onApprovePlan={handleApprovePlan}
                  onRejectPlan={handleRejectPlan}
                  onRetry={
                    !isLoading && msg.id === lastMessageId && msg.role === 'assistant'
                      ? () => void handleRetryMessage(msg)
                      : undefined
                  }
                  onEdit={
                    !isLoading && msg.id === lastUserMessageId
                      ? () => void handleEditMessage(msg)
                      : undefined
                  }
                />
              )}
            />
          )}
          {isLoading && !messages.some((msg) => msg.isStreaming && msg.content) && (
            <div className="flex items-center gap-2 border-b border-rule-divide py-3 type-value text-ink-muted last:border-b-0">
              <Spinner size={12} />
              {t('thinking')}
            </div>
          )}

          {(error || fatalError) && (
            <div className="mt-3 flex items-start gap-2 border-l-2 border-danger bg-danger/5 py-2 pl-3 type-caption text-danger">
              <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
              <span className="min-w-0 flex-1 leading-relaxed">{fatalError || error}</span>
              <span className="flex flex-shrink-0 items-center gap-2">
                {lastAssistantMessage && !isLoading && (
                  <button
                    type="button"
                    onClick={() => void handleRetryMessage(lastAssistantMessage!)}
                    className="text-ink-muted transition-colors hover:text-ink"
                  >
                    {t('retryMessage')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => emitAppEvent('open-settings')}
                  className="text-ink-muted transition-colors hover:text-ink"
                >
                  {t('goToSettings')}
                </button>
              </span>
            </div>
          )}
        </div>
      )}

  </>
)
