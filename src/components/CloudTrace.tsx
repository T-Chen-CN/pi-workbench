/** 云端会话时间线：文本 / 思考（默认收起）/ 工具卡 / 分隔线 */

import React, { useMemo, useState } from 'react'
import { ChevronRight, Sparkles } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import type { CloudTracePart } from '../types/cloud'
import { Caption, DataText, Label } from './ui'
import { MarkdownBody, StreamingMarkdown } from './AgentMarkdown'
import { CloudToolCard } from './CloudToolCard'

type TextPart = Extract<CloudTracePart, { type: 'text' }>
type ThinkingPart = Extract<CloudTracePart, { type: 'thinking' }>
type ToolPart = Extract<CloudTracePart, { type: 'tool' }>
type DividerPart = Extract<CloudTracePart, { type: 'divider' }>

type Group =
  | { kind: 'text'; key: string; part: TextPart }
  | { kind: 'thinking'; key: string; parts: ThinkingPart[] }
  | { kind: 'tool'; key: string; part: ToolPart }
  | { kind: 'divider'; key: string; part: DividerPart }

/** 相邻的思考片段合成一组，避免每个 token 块各占一行 */
export function groupCloudParts(parts: CloudTracePart[]): Group[] {
  const groups: Group[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      groups.push({ kind: 'text', key: part.id, part })
      continue
    }
    if (part.type === 'tool') {
      groups.push({ kind: 'tool', key: part.id, part })
      continue
    }
    if (part.type === 'divider') {
      groups.push({ kind: 'divider', key: part.id, part })
      continue
    }
    // approval 在 P0 只做占位展示（后端当前没有闸门）
    if (part.type === 'approval') {
      groups.push({
        kind: 'divider',
        key: part.id,
        part: {
          type: 'divider',
          id: part.id,
          kind: 'run_error',
          detail: part.summary,
        },
      })
      continue
    }
    const last = groups[groups.length - 1]
    if (last && last.kind === 'thinking') {
      last.parts.push(part)
    } else {
      groups.push({ kind: 'thinking', key: part.id, parts: [part] })
    }
  }
  return groups
}

const ThinkingGroup: React.FC<{ parts: ThinkingPart[]; streaming: boolean }> = ({
  parts,
  streaming,
}) => {
  const { t } = useI18nStore()
  const [open, setOpen] = useState(false)
  const text = parts.map((part) => part.text).join('')
  const redacted = parts.every((part) => part.redacted)
  if (!text && !redacted) return null

  return (
    <div className="py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left type-label text-ink-muted hover:text-ink"
      >
        <ChevronRight
          size={12}
          className={`flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <Sparkles size={11} className="flex-shrink-0 text-ink-subtle" />
        <span>{t('cloudThinkingGroup')}</span>
        <Caption className="text-ink-subtle">
          {t('cloudThinkingCount', { count: parts.length })}
        </Caption>
      </button>
      {open && (
        <div className="chat-markdown agent-trace-markdown mt-1 border-l border-rule-hairline pl-3 text-ink-muted">
          {redacted ? (
            <div className="type-caption text-ink-muted">{t('redactedThinking')}</div>
          ) : streaming ? (
            <StreamingMarkdown content={text} showCursor={false} />
          ) : (
            <MarkdownBody content={text} highlight={false} />
          )}
        </div>
      )}
    </div>
  )
}

const TextRow: React.FC<{ part: TextPart; streaming: boolean }> = ({ part, streaming }) => {
  const { t } = useI18nStore()
  const isUser = part.role === 'user'
  return (
    <div className="border-b border-rule-divide py-3 first:pt-0 last:border-b-0">
      <div className="mb-1.5 flex items-baseline gap-2">
        <Label className={isUser ? 'text-success' : 'text-ink'}>
          {isUser ? t('roleYou') : t('cloudAgent')}
        </Label>
      </div>
      {isUser ? (
        <div className="whitespace-pre-wrap break-words type-body text-ink">{part.text}</div>
      ) : (
        <div className="chat-markdown text-ink">
          {streaming ? (
            <StreamingMarkdown content={part.text} />
          ) : (
            <MarkdownBody content={part.text} highlight={part.text.length <= 20_000} />
          )}
        </div>
      )}
    </div>
  )
}

const DividerRow: React.FC<{ part: DividerPart }> = ({ part }) => {
  const { t } = useI18nStore()
  const label =
    part.kind === 'session_meta'
      ? t('cloudSessionMetaDivider')
      : part.kind === 'disconnect'
        ? t('cloudDisconnectDivider')
        : t('cloudRunError', { error: part.detail ?? 'unknown' })
  return (
    <div className="flex items-center gap-3 py-1" role="separator">
      <div className="h-px flex-1 bg-rule-divide" />
      <Caption
        className={`shrink-0 ${part.kind === 'run_error' ? 'text-danger' : 'text-ink-subtle'}`}
      >
        {label}
      </Caption>
      <div className="h-px flex-1 bg-rule-divide" />
    </div>
  )
}

export interface CloudTraceProps {
  parts: CloudTracePart[]
  /** 本轮仍在流式输出：最后一段文本显示光标 */
  streaming: boolean
}

export const CloudTrace: React.FC<CloudTraceProps> = ({ parts, streaming }) => {
  const groups = useMemo(() => groupCloudParts(parts), [parts])
  if (groups.length === 0) return null

  const lastTextIndex = (() => {
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      if (groups[index].kind === 'text') return index
    }
    return -1
  })()

  return (
    <div className="flex flex-col gap-1.5">
      {groups.map((group, index) => {
        if (group.kind === 'text') {
          return (
            <TextRow
              key={group.key}
              part={group.part}
              streaming={streaming && index === lastTextIndex && group.part.role === 'assistant'}
            />
          )
        }
        if (group.kind === 'thinking') {
          return (
            <ThinkingGroup
              key={group.key}
              parts={group.parts}
              streaming={streaming && index > lastTextIndex}
            />
          )
        }
        if (group.kind === 'tool') {
          return <CloudToolCard key={group.key} part={group.part} />
        }
        return <DividerRow key={group.key} part={group.part} />
      })}
    </div>
  )
}

/** 会话头部的一行元信息（模型 / tokens / 花费 / 计数） */
export const CloudSessionMetaLine: React.FC<{
  model: string
  inputTokens: number
  outputTokens: number
  cost: string
  messageCount: number
  toolCallCount: number
}> = ({ model, inputTokens, outputTokens, cost, messageCount, toolCallCount }) => {
  const { t } = useI18nStore()
  const tokens = inputTokens + outputTokens
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {model && <DataText className="text-ink-muted">{model}</DataText>}
      <Caption className="text-ink-subtle">{`${tokens.toLocaleString()} ${t('cloudTokensLabel')}`}</Caption>
      <Caption className="text-ink-subtle">{`${t('cloudCostLabel')} ${cost}`}</Caption>
      <Caption className="text-ink-subtle">{`${messageCount} ${t('cloudMessagesLabel')}`}</Caption>
      <Caption className="text-ink-subtle">{`${toolCallCount} ${t('cloudToolsLabel')}`}</Caption>
    </div>
  )
}
