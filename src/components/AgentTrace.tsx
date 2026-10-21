import React, { useMemo, useState } from 'react'
import { AlertCircle, Check, ChevronRight, Loader2 } from 'lucide-react'
import type { AgentTracePart } from '../types/electron'
import { useI18nStore } from '../store/i18nStore'
import type { TranslationKey, TranslationParams } from '../i18n/translations'
import { MarkdownBody, StreamingMarkdown } from './AgentMarkdown'
import { Caption, DataText } from './ui'

type Translator = (key: TranslationKey, params?: TranslationParams) => string

type WorkPart = Extract<AgentTracePart, { type: 'thinking' | 'tool' }>

type RenderGroup =
  | {
      type: 'text'
      key: string
      part: Extract<AgentTracePart, { type: 'text' }>
    }
  | { type: 'work'; key: string; parts: WorkPart[] }

function buildGroups(parts: AgentTracePart[]): RenderGroup[] {
  const groups: RenderGroup[] = []
  let work: WorkPart[] = []

  const flushWork = () => {
    if (work.length === 0) return
    groups.push({ type: 'work', key: `work-${work[0].id}`, parts: work })
    work = []
  }

  for (const part of parts) {
    if (part.type === 'text') {
      flushWork()
      groups.push({ type: 'text', key: `text-${part.id}`, part })
    } else {
      work.push(part)
    }
  }
  flushWork()
  return groups
}

function toolLabel(t: Translator, name: string): string {
  switch (name) {
    case 'read':
      return t('toolRead')
    case 'write':
      return t('toolWrite')
    case 'edit':
      return t('toolEdit')
    case 'bash':
    case 'powershell':
      return t('toolBash')
    case 'grep':
      return t('toolGrep')
    case 'find':
      return t('toolFind')
    case 'ls':
      return t('toolLs')
    default:
      return name
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000
  return seconds >= 10 ? String(Math.round(seconds)) : seconds.toFixed(1).replace(/\.0$/, '')
}

export interface AgentPartsProps {
  parts: AgentTracePart[]
  isStreaming: boolean
  /** 有对应 Diff 可打开的工具调用 */
  diffToolIds?: Set<string>
  onOpenDiff?: (toolCallId: string) => void
}

export const AgentParts: React.FC<AgentPartsProps> = React.memo(function AgentParts({
  parts,
  isStreaming,
  diffToolIds,
  onOpenDiff,
}) {
  const groups = useMemo(() => buildGroups(parts), [parts])

  return (
    <>
      {groups.map((group, index) => {
        if (group.type === 'text') {
          const isLast = index === groups.length - 1
          return (
            <div key={group.key} className="chat-markdown text-ink">
              {isStreaming && isLast ? (
                <StreamingMarkdown content={group.part.text} />
              ) : (
                <MarkdownBody
                  content={group.part.text}
                  highlight={group.part.text.length <= 20_000}
                />
              )}
            </div>
          )
        }
        return (
          <WorkGroup
            key={group.key}
            parts={group.parts}
            isStreaming={isStreaming && index === groups.length - 1}
            diffToolIds={diffToolIds}
            onOpenDiff={onOpenDiff}
          />
        )
      })}
    </>
  )
})

interface WorkGroupProps {
  parts: WorkPart[]
  isStreaming: boolean
  diffToolIds?: Set<string>
  onOpenDiff?: (toolCallId: string) => void
}

const WorkGroup: React.FC<WorkGroupProps> = ({
  parts,
  isStreaming,
  diffToolIds,
  onOpenDiff,
}) => {
  const { t } = useI18nStore()
  const [open, setOpen] = useState(false)
  const contentId = `trace-${parts[0].id}`

  const last = parts[parts.length - 1]
  const runningTool = [...parts]
    .reverse()
    .find((part): part is Extract<WorkPart, { type: 'tool' }> => {
      return part.type === 'tool' && part.status === 'running'
    })
  const thinkingActive = isStreaming && last?.type === 'thinking'
  const failedTools = parts.filter(
    (part) => part.type === 'tool' && part.status === 'error'
  ).length
  const toolCount = parts.filter((part) => part.type === 'tool').length
  const thinkingMs = parts.reduce(
    (total, part) => total + (part.type === 'thinking' ? part.durationMs ?? 0 : 0),
    0
  )

  let label = t('thoughtProcess')
  let detail = ''
  let dangerDetail = false

  if (runningTool) {
    label = t('toolRunning', { tool: toolLabel(t, runningTool.toolName) })
  } else if (thinkingActive) {
    label = t('thinkingInProgress')
  } else if (failedTools > 0) {
    const bits = [t('traceToolFailed', { count: failedTools })]
    if (thinkingMs > 0) bits.push(t('traceThinkingSeconds', { seconds: formatSeconds(thinkingMs) }))
    detail = bits.join(' · ')
    dangerDetail = true
  } else {
    const bits: string[] = []
    if (thinkingMs > 0) {
      bits.push(t('traceThinkingSeconds', { seconds: formatSeconds(thinkingMs) }))
    }
    if (toolCount > 0) bits.push(t('traceToolCount', { count: toolCount }))
    detail = bits.join(' · ')
  }

  const running = Boolean(runningTool) || thinkingActive

  return (
    <div className="py-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left type-label text-ink-muted hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        <ChevronRight
          size={12}
          className={`flex-shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        {running && <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-accent" />}
        <span>{label}</span>
        {detail && (
          <span
            className={`truncate type-caption ${
              dangerDetail ? 'text-danger' : 'text-ink-muted'
            }`}
          >
            · {detail}
          </span>
        )}
      </button>

      {open && (
        <div
          id={contentId}
          aria-busy={running}
          className="mt-1.5 border-l border-rule-hairline pl-3"
        >
          {parts.map((part, index) =>
            part.type === 'thinking' ? (
              <ThinkingRow
                key={part.id}
                part={part}
                streaming={isStreaming && index === parts.length - 1}
              />
            ) : (
              <ToolRow
                key={part.id}
                part={part}
                hasDiff={diffToolIds?.has(part.toolCallId) ?? false}
                onOpenDiff={onOpenDiff}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}

const ThinkingRow = React.memo(function ThinkingRow({
  part,
  streaming,
}: {
  part: Extract<AgentTracePart, { type: 'thinking' }>
  streaming: boolean
}) {
  const { t } = useI18nStore()

  if (part.redacted) {
    return (
      <div className="py-1 type-caption text-ink-muted">{t('redactedThinking')}</div>
    )
  }
  if (!part.text) return null

  return (
    <div className="chat-markdown agent-trace-markdown py-1 text-ink-muted">
      {streaming ? (
        <StreamingMarkdown content={part.text} showCursor={false} />
      ) : (
        <MarkdownBody content={part.text} highlight={false} />
      )}
    </div>
  )
})

const ToolRow = React.memo(function ToolRow({
  part,
  hasDiff,
  onOpenDiff,
}: {
  part: Extract<AgentTracePart, { type: 'tool' }>
  hasDiff: boolean
  onOpenDiff?: (toolCallId: string) => void
}) {
  const { t } = useI18nStore()
  const [open, setOpen] = useState(false)
  const hasDetail = Boolean(part.argsSummary || part.resultPreview || part.filePath)
  const contentId = `tool-${part.id}`
  const label = toolLabel(t, part.toolName)
  const statusText =
    part.status === 'error'
      ? t('toolError')
      : part.status === 'running'
        ? t('sessionRunning')
        : ''
  const accessibleLabel = [label, part.argsSummary, statusText].filter(Boolean).join(' ')

  const icon =
    part.status === 'running' ? (
      <Loader2 size={12} className="flex-shrink-0 animate-spin text-accent" />
    ) : part.status === 'error' ? (
      <AlertCircle size={12} className="flex-shrink-0 text-danger" />
    ) : (
      <Check size={12} className="flex-shrink-0 text-success" />
    )

  return (
    <div className="py-0.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        aria-label={accessibleLabel}
        disabled={!hasDetail}
        onClick={() => hasDetail && setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left type-label text-ink-muted hover:text-ink disabled:cursor-default"
      >
        {icon}
        <span className="flex-shrink-0 text-ink">
          {label}
          {part.status === 'running' ? '…' : ''}
        </span>
        {part.argsSummary && (
          <DataText className="min-w-0 truncate text-ink-muted">{part.argsSummary}</DataText>
        )}
        {part.status === 'error' && (
          <span className="flex-shrink-0 type-caption text-danger">{t('toolError')}</span>
        )}
        {part.durationMs !== undefined && (
          <span className="ml-auto flex-shrink-0 type-caption text-ink-muted">
            {formatDuration(part.durationMs)}
          </span>
        )}
        {hasDetail && (
          <ChevronRight
            size={10}
            className={`flex-shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          />
        )}
      </button>

      {open && (
        <div id={contentId} className="mt-1 space-y-1.5 border-l border-rule-divide pl-3">
          {part.argsSummary && (
            <div>
              <Caption className="text-ink-muted">{t('toolArgsPreview')}</Caption>
              <pre className="m-0 whitespace-pre-wrap break-words type-data text-ink-muted">
                {part.argsSummary}
              </pre>
            </div>
          )}
          {part.resultPreview && (
            <div>
              <Caption className="text-ink-muted">{t('toolResultPreview')}</Caption>
              <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-words border border-rule-hairline bg-sunken p-2 type-data text-ink">
                {part.resultPreview}
              </pre>
            </div>
          )}
          {part.status === 'error' && !part.resultPreview && (
            <Caption className="text-danger">{t('toolError')}</Caption>
          )}
          {hasDiff && onOpenDiff && (
            <button
              type="button"
              onClick={() => onOpenDiff(part.toolCallId)}
              className="type-label text-accent underline underline-offset-2 hover:text-ink"
            >
              {t('viewChanges')}
            </button>
          )}
        </div>
      )}
    </div>
  )
})
