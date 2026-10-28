/** 聊天消息行、本轮任务与修改摘要 */

import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Copy, Pencil, RotateCcw, X } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useWorkspaceScope } from '../workspace/WorkspaceScope'
import { useChatStore, type ChatMessage } from '../store/chatStore'
import { diffStoreFor } from '../store/diffStore'
import { useRevertEdits } from '../hooks/useRevertEdits'
import { useHostDocument, useHostKeydown } from '../panelHost/HostContext'
import type { AgentTracePart, FileEdit, StructuredPlan } from '../types/electron'
import { Caption, IconButton, Label, Spinner } from './ui'
import { AgentParts } from './AgentTrace'
import { MarkdownBody, StreamingMarkdown } from './AgentMarkdown'
import { basename } from '../utils/filePath'

/** 本轮任务列表（AF-12）：由助手消息里的工具步骤派生 */
export const TurnTaskList: React.FC<{ parts: AgentTracePart[] }> = ({
  parts,
}) => {
  const { t } = useI18nStore()
  const [open, setOpen] = useState(false)
  const tools = parts.filter(
    (part): part is Extract<AgentTracePart, { type: 'tool' }> =>
      part.type === 'tool'
  )
  if (tools.length === 0) return null
  const done = tools.filter((tool) => tool.status !== 'running').length
  const running = done < tools.length

  return (
    <div className="border border-rule-hairline bg-raised">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <ChevronRight
          size={12}
          className={`flex-shrink-0 text-ink-muted transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="type-label text-ink">{t('currentTasks')}</span>
        <span className="type-caption text-ink-muted">
          {t('taskProgress', { done, total: tools.length })}
        </span>
        {running && <Spinner size={10} />}
      </button>
      {open && (
        <div className="border-t border-rule-divide">
          {tools.map((tool) => (
            <div
              key={tool.id}
              className="flex items-center gap-2 border-b border-rule-divide px-3 py-1 last:border-b-0"
            >
              <span
                className={`h-1 w-1 flex-shrink-0 rounded-full ${
                  tool.status === 'running'
                    ? 'animate-pulse bg-accent'
                    : tool.isError || tool.status === 'error'
                      ? 'bg-danger'
                      : 'bg-success'
                }`}
              />
              <span className="type-label text-ink">{tool.toolName}</span>
              <span className="min-w-0 flex-1 truncate type-data text-ink-muted">
                {tool.argsSummary}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 一轮修改的内联变更卡（AF-10）：逐文件查看 / 还原 */
const TurnEditSummary: React.FC<{
  edits: FileEdit[]
  messageKey: string
  messageId: string
}> = ({ edits, messageKey, messageId }) => {
  const { t } = useI18nStore()
  // 默认收起：一轮可能改十几个文件，全部平铺会把对话吃掉
  const [open, setOpen] = useState(false)
  const scopeWorkspace = useWorkspaceScope()
  const workspacePath = scopeWorkspace ?? useWorkspaceStore.getState().workspacePath ?? ''
  const { busy, handleRevert, handleRevertAll } = useRevertEdits({
    workspacePath,
    onReverted: (edit) =>
      useChatStore.getState().removeMessageEdit(messageKey, messageId, edit.path),
  })

  if (edits.length === 0) return null
  const fileName = (target: string) => basename(target) || target
  const contentId = `turn-changes-${messageId}`

  return (
    <div className="mt-2 border border-rule-hairline bg-raised">
      <div className="flex items-center gap-2 border-b border-rule-divide px-3 py-1.5 last:border-b-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left type-label text-ink transition-colors hover:text-accent"
        >
          <ChevronRight
            size={12}
            className={`flex-shrink-0 text-ink-muted transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <span className="truncate">{t('turnChanges', { count: edits.length })}</span>
        </button>
        <button
          type="button"
          disabled={busy}
          data-turn-changes-aux
          onClick={(event) => {
            event.stopPropagation()
            void handleRevertAll(edits)
          }}
          className="flex-shrink-0 type-caption text-ink-muted transition-colors hover:text-danger disabled:opacity-40"
        >
          {t('revertAll')}
        </button>
      </div>
      {open &&
        edits.map((edit) => (
          <div
            key={edit.path}
            id={contentId}
            className="flex items-center gap-2 border-b border-rule-divide px-3 py-1 last:border-b-0"
          >
            <span className="min-w-0 flex-1 truncate type-data text-ink-muted" title={edit.path}>
              {fileName(edit.path)}
            </span>
            <button
              type="button"
              onClick={() => diffStoreFor(workspacePath).getState().openEdits([edit])}
              className="type-caption text-ink-muted transition-colors hover:text-ink"
            >
              {t('viewChanges')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRevert(edit)}
              className="type-caption text-ink-muted transition-colors hover:text-danger disabled:opacity-40"
            >
              {t('revertFile')}
            </button>
          </div>
        ))}
    </div>
  )
}

/** 单条消息；memo 保证流式追加只重渲染最后一条 */
/** 用户消息中的图片缩略图；点击打开大图预览（R-08） */
const MessageImages: React.FC<{
  images: Array<{ data: string; mimeType: string }>
}> = ({ images }) => {
  const { t } = useI18nStore()
  const hostDocument = useHostDocument()
  const [preview, setPreview] = useState<number | null>(null)

  useHostKeydown(
    (event) => {
      if (event.key === 'Escape') setPreview(null)
    },
    [],
    preview !== null
  )

  return (
    <>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {images.map((image, index) => (
          <button
            key={index}
            type="button"
            onClick={() => setPreview(index)}
            className="border border-rule-hairline bg-sunken p-1"
            aria-label={t('imagePreviewLabel', { index: index + 1 })}
          >
            <img
              src={`data:${image.mimeType};base64,${image.data}`}
              alt=""
              className="h-32 max-w-[16rem] object-contain"
            />
          </button>
        ))}
      </div>
      {preview !== null &&
        images[preview] &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('imagePreviewLabel', { index: preview + 1 })}
            className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/80 p-6"
            onClick={() => setPreview(null)}
          >
            <img
              src={`data:${images[preview].mimeType};base64,${images[preview].data}`}
              alt=""
              onClick={(event) => event.stopPropagation()}
              className="max-h-full max-w-full object-contain"
            />
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setPreview(null)
              }}
              aria-label={t('close')}
              className="absolute right-4 top-4 border border-rule-control bg-raised p-1.5 text-ink transition-colors hover:text-accent"
            >
              <X size={16} />
            </button>
          </div>,
          hostDocument.body
        )}
    </>
  )
}

export const ChatMessageRow = React.memo(function ChatMessageRow({
  message,
  diffToolIds,
  onOpenDiff,
  onCopy,
  onRetry,
  onEdit,
  onSwitchBranch,
  onOpenToolResult,
  canActOnPlan,
  onApprovePlan,
  onRejectPlan,
  conversationKey,
}: {
  message: ChatMessage
  diffToolIds?: Set<string>
  onOpenDiff?: (toolCallId: string) => void
  onCopy?: (text: string) => void
  onRetry?: () => void
  onEdit?: () => void
  onSwitchBranch?: (entryId: string) => void
  onOpenToolResult?: (toolCallId: string, toolName: string) => void
  canActOnPlan?: boolean
  onApprovePlan?: (plan: StructuredPlan, targetMode: 'ask' | 'auto') => void
  onRejectPlan?: (plan: StructuredPlan) => void
  conversationKey?: string
}) {
  const { t, language } = useI18nStore()

  if (message.role === 'system') {
    // 旧的压缩提示是纯文本分隔线；新结构下压缩点是 part，二者都能渲染
    if (message.parts?.length) {
      return (
        <AgentParts
          parts={message.parts}
          isStreaming={false}
          diffToolIds={diffToolIds}
          onOpenDiff={onOpenDiff}
          onOpenToolResult={onOpenToolResult}
          canActOnPlan={canActOnPlan}
          onApprovePlan={onApprovePlan}
          onRejectPlan={onRejectPlan}
        />
      )
    }
    return (
      <div className="flex items-center gap-3 py-2">
        <span className="h-px flex-1 bg-rule-divide" />
        <Caption className="flex-shrink-0 text-ink-muted">{message.content}</Caption>
        <span className="h-px flex-1 bg-rule-divide" />
      </div>
    )
  }

  if (message.isStreaming && !message.content && !message.parts?.length) return null
  const isUser = message.role === 'user'
  const hasActions = Boolean(onCopy || onRetry || onEdit)
  // 只承载压缩分隔线的消息不显示表头与操作区
  const dividerOnly = Boolean(
    message.parts?.length && message.parts.every((part) => part.type === 'compaction')
  )

  if (dividerOnly) {
    return (
      <AgentParts
        parts={message.parts ?? []}
        isStreaming={false}
        diffToolIds={diffToolIds}
        onOpenDiff={onOpenDiff}
        onOpenToolResult={onOpenToolResult}
      />
    )
  }

  return (
    <div
      data-testid="chat-message"
      className="group border-b border-rule-divide py-3 first:pt-0 last:border-b-0"
    >
      <div className="mb-1.5 flex items-baseline gap-2">
        <Label className={isUser ? 'text-success' : 'text-ink'}>{isUser ? t('roleYou') : t('piAgent')}</Label>
        <Caption className="text-ink-muted">
          {new Date(message.timestamp).toLocaleTimeString(
            language === 'zh' ? 'zh-CN' : 'en-US'
          )}
        </Caption>
        {message.branch && message.branch.entryIds.length > 1 && (
          <span className="flex items-center gap-0.5">
            <IconButton
              icon={ChevronLeft}
              label={t('previousBranch')}
              size="sm"
              disabled={message.branch.activeIndex <= 0}
              onClick={() => {
                const branch = message.branch
                if (branch) onSwitchBranch?.(branch.entryIds[branch.activeIndex - 1])
              }}
            />
            <Caption className="text-ink-muted">
              {message.branch.activeIndex + 1}/{message.branch.entryIds.length}
            </Caption>
            <IconButton
              icon={ChevronRight}
              label={t('nextBranch')}
              size="sm"
              disabled={
                message.branch.activeIndex >= message.branch.entryIds.length - 1
              }
              onClick={() => {
                const branch = message.branch
                if (branch) onSwitchBranch?.(branch.entryIds[branch.activeIndex + 1])
              }}
            />
          </span>
        )}
        {hasActions && (
          <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {onCopy && (
              <IconButton
                icon={Copy}
                label={t('copyMessage')}
                size="sm"
                onClick={() => onCopy(message.content)}
              />
            )}
            {onRetry && (
              <IconButton
                icon={RotateCcw}
                label={t('retryMessage')}
                size="sm"
                onClick={onRetry}
              />
            )}
            {onEdit && (
              <IconButton
                icon={Pencil}
                label={t('editMessage')}
                size="sm"
                onClick={onEdit}
              />
            )}
          </span>
        )}
      </div>
      {isUser ? (
        // 用户消息 = 纸卡批注：抬升纸底 + 发丝外框 + 2px 松绿左竖线，与 Agent 的流动正文区分开
        <div
          data-testid="user-message"
          className="flex gap-2 border border-rule-hairline border-l-2 border-l-success bg-raised px-3 py-2 type-reading text-ink"
        >
          <span className="type-project flex-shrink-0 text-success" aria-hidden="true">
            ›
          </span>
          <div className="min-w-0 flex-1">
            <span className="whitespace-pre-wrap">{message.content}</span>
            {message.images && message.images.length > 0 && <MessageImages images={message.images} />}
          </div>
        </div>
      ) : (
        <div className="text-ink" data-testid="agent-message" data-quote-scope="chat">
          {message.parts?.length ? (
            <AgentParts
              parts={message.parts}
              isStreaming={Boolean(message.isStreaming)}
              diffToolIds={diffToolIds}
              onOpenDiff={onOpenDiff}
              onOpenToolResult={onOpenToolResult}
              canActOnPlan={canActOnPlan}
              onApprovePlan={onApprovePlan}
              onRejectPlan={onRejectPlan}
            />
          ) : (
            <div className="chat-markdown text-ink">
              {message.isStreaming ? (
                <StreamingMarkdown content={message.content} />
              ) : (
                <MarkdownBody
                  content={message.content}
                  highlight={message.content.length <= 20_000}
                />
              )}
            </div>
          )}
          {message.usage && (
            <Caption className="mt-1 block text-ink-muted">
              {message.usage.totalTokens.toLocaleString()} tokens
              {message.usage.cost > 0 ? ` · $${message.usage.cost.toFixed(4)}` : ''}
            </Caption>
          )}
          {message.edits && message.edits.length > 0 && conversationKey && (
            <TurnEditSummary
              edits={message.edits}
              messageKey={conversationKey}
              messageId={message.id}
            />
          )}
        </div>
      )}
    </div>
  )
})

