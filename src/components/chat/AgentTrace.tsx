import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronRight, ListChecks, Loader2 } from 'lucide-react'
import type { AgentTracePart, StructuredPlan } from '../../types/electron'
import { useI18nStore } from '../../store/i18nStore'
import type { TranslationKey, TranslationParams } from '../../i18n/translations'
import { StreamingMarkdown } from './AgentMarkdown'
import { Button, Caption, DataText, Label } from '../ui/ui'

type Translator = (key: TranslationKey, params?: TranslationParams) => string

type WorkPart = Extract<AgentTracePart, { type: 'thinking' | 'tool' | 'text' }>
type CompactionPart = Extract<AgentTracePart, { type: 'compaction' }>

type RenderGroup =
  | {
      type: 'text'
      key: string
      part: Extract<AgentTracePart, { type: 'text' }>
    }
  | { type: 'work'; key: string; parts: WorkPart[]; hasTrailingText: boolean }
  | { type: 'plan'; key: string; part: Extract<AgentTracePart, { type: 'plan' }> }
  | { type: 'compaction'; key: string; part: CompactionPart }

/**
 * 将同段内的思考、工具及工具间的过渡旁白归入唯一工作组（1A），
 * 仅保留最后一个工作项之后的非空文本作为最终正文；PlanCard 与 CompactionDivider 保持独立在外。
 */
function buildGroups(parts: AgentTracePart[]): RenderGroup[] {
  const groups: RenderGroup[] = []
  let segment: WorkPart[] = []

  const flushSegment = () => {
    if (segment.length === 0) return
    let lastWorkIdx = -1
    for (let i = segment.length - 1; i >= 0; i -= 1) {
      if (segment[i].type === 'thinking' || segment[i].type === 'tool') {
        lastWorkIdx = i
        break
      }
    }
    if (lastWorkIdx < 0) {
      for (const part of segment) {
        if (part.type === 'text') {
          groups.push({ type: 'text', key: `text-${part.id}`, part })
        }
      }
    } else {
      const workParts = segment.slice(0, lastWorkIdx + 1)
      const firstWork =
        workParts.find((item) => item.type === 'thinking' || item.type === 'tool') ?? workParts[0]
      const trailingTexts = segment
        .slice(lastWorkIdx + 1)
        .filter((item): item is Extract<AgentTracePart, { type: 'text' }> => item.type === 'text')
      groups.push({
        type: 'work',
        key: `work-${firstWork.id}`,
        parts: workParts,
        hasTrailingText: trailingTexts.length > 0,
      })
      for (const part of trailingTexts) {
        groups.push({ type: 'text', key: `text-${part.id}`, part })
      }
    }
    segment = []
  }

  for (const part of parts) {
    if (part.type === 'plan') {
      flushSegment()
      groups.push({ type: 'plan', key: `plan-${part.plan.id}`, part })
    } else if (part.type === 'compaction') {
      // 压缩点单独成组：跟随 parts 顺序，不能被折进可收起的工作块
      flushSegment()
      groups.push({ type: 'compaction', key: `compaction-${part.id}`, part })
    } else if (part.type === 'text') {
      // 忽略空串与纯空白文本，避免 Gemini toolUse 尾部的 text:"" 切碎工作组或误触发正文态
      if (part.text.trim()) segment.push(part)
    } else {
      segment.push(part)
    }
  }
  flushSegment()
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
    case 'web_search':
      return t('toolWebSearch')
    case 'fetch_content':
      return t('toolWebFetch')
    case 'get_search_content':
      return t('toolWebSearchContent')
    case 'source_check':
      return t('toolSourceCheck')
    default:
      return name
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatSeconds(ms: number): string {
  if (ms > 0 && ms < 100) return '<0.1'
  const seconds = ms / 1000
  return seconds >= 10 ? String(Math.round(seconds)) : seconds.toFixed(1).replace(/\.0$/, '')
}

export interface AgentPartsProps {
  parts: AgentTracePart[]
  isStreaming: boolean
  /** 有对应 Diff 可打开的工具调用 */
  diffToolIds?: Set<string>
  onOpenDiff?: (toolCallId: string) => void
  /** 查看工具结果的完整输出（R-20） */
  onOpenToolResult?: (toolCallId: string, toolName: string) => void
  /** 计划卡操作（R-04）：只读展示，仅允许批准并执行 / 完全执行 / 拒绝 */
  canActOnPlan?: boolean
  onApprovePlan?: (plan: StructuredPlan, targetMode: 'ask' | 'auto') => void
  onRejectPlan?: (plan: StructuredPlan) => void
}

/** 上下文压缩分隔线：位置由 parts 顺序决定，文案随语言切换重算 */
const CompactionDivider: React.FC<{ part: CompactionPart }> = ({ part }) => {
  const t = useI18nStore((state) => state.t)
  const label =
    typeof part.tokensBefore === 'number'
      ? t('compactionDividerTokens', { tokens: part.tokensBefore.toLocaleString() })
      : t('compactionDivider')
  return (
    <div className="flex items-center gap-3 py-1" role="separator">
      <div className="h-px flex-1 bg-rule-divide" />
      <Caption className="shrink-0 text-ink-muted">{label}</Caption>
      <div className="h-px flex-1 bg-rule-divide" />
    </div>
  )
}

export const AgentParts: React.FC<AgentPartsProps> = React.memo(function AgentParts({
  parts,
  isStreaming,
  diffToolIds,
  onOpenDiff,
  onOpenToolResult,
  canActOnPlan = false,
  onApprovePlan,
  onRejectPlan,
}) {
  const groups = useMemo(() => buildGroups(parts), [parts])
  // 末尾的压缩分隔线不算“仍在输出”，否则前面的文本 / 工作块会提前结束流式样式
  const lastSignificant = (() => {
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      if (groups[index].type !== 'compaction') return index
    }
    return -1
  })()

  return (
    <>
      {groups.map((group, index) => {
        if (group.type === 'text') {
          const isLast = index === lastSignificant
          const activeStream = isStreaming && isLast
          return (
            <div key={group.key} className="chat-markdown text-ink">
              <StreamingMarkdown
                content={group.part.text}
                isStreaming={activeStream}
                showCursor={activeStream}
                // Streamdown v2 已按块冻结，仅在超长流式回复（>100k）时暂缓高亮，彻底消除 20k 断崖
                highlight={!activeStream || group.part.text.length <= 100_000}
              />
            </div>
          )
        }
        if (group.type === 'plan') {
          return (
            <PlanCard
              key={group.key}
              plan={group.part.plan}
              canAct={canActOnPlan}
              onApprove={onApprovePlan}
              onReject={onRejectPlan}
            />
          )
        }
        if (group.type === 'compaction') {
          return <CompactionDivider key={group.key} part={group.part} />
        }
        return (
          <WorkGroup
            key={group.key}
            parts={group.parts}
            isStreaming={isStreaming && index === lastSignificant}
            hasTrailingText={group.hasTrailingText}
            diffToolIds={diffToolIds}
            onOpenDiff={onOpenDiff}
            onOpenToolResult={onOpenToolResult}
          />
        )
      })}
    </>
  )
})

function planStatusLabel(t: Translator, status: StructuredPlan['status']): string {
  if (status === 'approved') return t('planStatusApproved')
  if (status === 'rejected') return t('planStatusRejected')
  return t('planStatusProposed')
}

function stepStatusLabel(t: Translator, status: StructuredPlan['steps'][number]['status']): string {
  switch (status) {
    case 'in_progress':
      return t('planStepInProgress')
    case 'done':
      return t('planStepDone')
    case 'skipped':
      return t('planStepSkipped')
    default:
      return t('planStepPending')
  }
}

function stepStatusClass(status: StructuredPlan['steps'][number]['status']): string {
  switch (status) {
    case 'in_progress':
      return 'text-accent'
    case 'done':
      return 'text-success'
    case 'skipped':
      return 'text-ink-subtle'
    default:
      return 'text-ink-muted'
  }
}

/** 结构化计划卡（R-04）：步骤只读，可拒绝、同意并执行或完全执行 */
const PlanCard: React.FC<{
  plan: StructuredPlan
  canAct: boolean
  onApprove?: (plan: StructuredPlan, targetMode: 'ask' | 'auto') => void
  onReject?: (plan: StructuredPlan) => void
}> = ({ plan, canAct, onApprove, onReject }) => {
  const t = useI18nStore((state) => state.t)

  return (
    <div className="my-2 border border-rule-hairline bg-raised">
      <div className="flex items-center gap-2 border-b border-rule-divide px-3 py-2">
        <ListChecks size={14} className="flex-shrink-0 text-accent" />
        <Label className="text-ink">{t('planCardTitle')}</Label>
        <Caption className="ml-auto text-ink-muted">{planStatusLabel(t, plan.status)}</Caption>
      </div>
      {plan.summary && (
        <p className="m-0 border-b border-rule-divide px-3 py-2 type-value text-ink-muted">
          {plan.summary}
        </p>
      )}
      <ol className="m-0 list-none p-0">
        {plan.steps.map((step, index) => (
          <li
            key={step.id}
            className="flex items-start gap-2 border-b border-rule-divide px-3 py-2 last:border-b-0"
          >
            <span className="w-5 flex-shrink-0 text-right type-data text-ink-subtle">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="type-value text-ink">{step.title}</div>
              {step.files.length > 0 && (
                <div className="type-data text-ink-muted">{step.files.join(' · ')}</div>
              )}
              {step.risk && (
                <Caption className="text-warning">{t('planRisk', { risk: step.risk })}</Caption>
              )}
            </div>
            <span className={`flex-shrink-0 type-caption ${stepStatusClass(step.status)}`}>
              {stepStatusLabel(t, step.status)}
            </span>
          </li>
        ))}
      </ol>
      {canAct && plan.status === 'proposed' && (onApprove || onReject) && (
        <div className="flex justify-end gap-2 border-t border-rule-divide px-3 py-2">
          {onReject && (
            <Button size="sm" variant="ghost" onClick={() => onReject(plan)}>
              {t('planReject')}
            </Button>
          )}
          {onApprove && (
            <>
              <Button size="sm" variant="secondary" onClick={() => onApprove(plan, 'auto')}>
                {t('planApproveAuto')}
              </Button>
              <Button size="sm" variant="primary" onClick={() => onApprove(plan, 'ask')}>
                {t('planApproveAsk')}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

interface WorkGroupProps {
  parts: WorkPart[]
  isStreaming: boolean
  hasTrailingText: boolean
  diffToolIds?: Set<string>
  onOpenDiff?: (toolCallId: string) => void
  onOpenToolResult?: (toolCallId: string, toolName: string) => void
}

const WorkGroup: React.FC<WorkGroupProps> = ({
  parts,
  isStreaming,
  hasTrailingText,
  diffToolIds,
  onOpenDiff,
  onOpenToolResult,
}) => {
  const { t } = useI18nStore()
  // 三态控制：null 跟随两阶段自动展开/收起，非 null 时完全尊重用户手动切换
  const [userOverride, setUserOverride] = useState<boolean | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)

  const instanceId = useId()
  const liveAutoOpen = isStreaming && !hasTrailingText
  const open = userOverride ?? liveAutoOpen
  const isConstrainedLive = open && liveAutoOpen && userOverride === null
  const contentId = `trace-${instanceId}-${parts[0]?.id ?? 'group'}`

  const last = parts[parts.length - 1]
  const scrollSignal =
    parts.length * 100000 +
    (last?.type === 'thinking' || last?.type === 'text'
      ? last.text.length
      : last?.type === 'tool'
        ? (last.resultPreview?.length ?? 0) + (last.status === 'running' ? 1 : 2)
        : 0)

  useEffect(() => {
    if (!isConstrainedLive) {
      stickToBottomRef.current = true
      return
    }
    const el = scrollRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [isConstrainedLive, scrollSignal])

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
    if (toolCount > failedTools) bits.push(t('traceToolCount', { count: toolCount }))
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
  const toolCallIds = new Set(
    parts.filter((part): part is Extract<WorkPart, { type: 'tool' }> => part.type === 'tool')
      .map((part) => part.toolCallId)
  )

  return (
    <div className="py-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setUserOverride(!open)}
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
          ref={scrollRef}
          id={contentId}
          aria-busy={running}
          data-live-scroll={isConstrainedLive ? 'true' : undefined}
          onScroll={
            isConstrainedLive
              ? (event) => {
                  const el = event.currentTarget
                  stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
                }
              : undefined
          }
          className={`mt-1.5 border-l border-rule-hairline pl-3 ${
            isConstrainedLive ? 'max-h-60 overflow-y-auto pr-1' : ''
          }`}
        >
          {parts.map((part, index) =>
            part.type === 'thinking' ? (
              <ThinkingRow
                key={part.id}
                part={part}
                streaming={isStreaming && index === parts.length - 1}
              />
            ) : part.type === 'text' ? (
              <div
                key={part.id}
                className="chat-markdown agent-trace-markdown py-1 text-ink-muted"
              >
                <StreamingMarkdown
                  content={part.text}
                  isStreaming={isStreaming && index === parts.length - 1}
                  showCursor={false}
                  highlight={false}
                />
              </div>
            ) : (
              <ToolRow
                key={part.id}
                part={part}
                hasDiff={diffToolIds?.has(part.toolCallId) ?? false}
                onOpenDiff={onOpenDiff}
                nested={Boolean(
                  part.parentToolCallId && toolCallIds.has(part.parentToolCallId)
                )}
                onOpenResult={onOpenToolResult}
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
      <StreamingMarkdown
        content={part.text}
        isStreaming={streaming}
        showCursor={false}
        highlight={false}
      />
    </div>
  )
})

const ToolRow = React.memo(function ToolRow({
  part,
  hasDiff,
  onOpenDiff,
  onOpenResult,
  nested = false,
}: {
  part: Extract<AgentTracePart, { type: 'tool' }>
  hasDiff: boolean
  onOpenDiff?: (toolCallId: string) => void
  onOpenResult?: (toolCallId: string, toolName: string) => void
  nested?: boolean
}) {
  const { t } = useI18nStore()
  const [open, setOpen] = useState(false)
  const hasDetail = Boolean(part.argsSummary || part.resultPreview || part.filePath)
  const canOpenResult = Boolean(part.status !== 'running' && onOpenResult)
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
    <div
      className={
        nested ? 'ml-4 border-l border-rule-hairline py-0.5 pl-2' : 'py-0.5'
      }
      data-nested={nested || undefined}
    >
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
        {nested && (
          <span className="flex-shrink-0 type-caption text-ink-muted">
            {t('subAgent')}
          </span>
        )}
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
          {((hasDiff && onOpenDiff) || canOpenResult) && (
            <div className="flex flex-wrap items-center gap-3">
              {hasDiff && onOpenDiff && (
                <button
                  type="button"
                  onClick={() => onOpenDiff(part.toolCallId)}
                  className="type-label text-accent underline underline-offset-2 hover:text-ink"
                >
                  {t('viewChanges')}
                </button>
              )}
              {canOpenResult && onOpenResult && (
                <button
                  type="button"
                  onClick={() => onOpenResult(part.toolCallId, part.toolName)}
                  className="type-label text-accent underline underline-offset-2 hover:text-ink"
                >
                  {t('viewFullResult')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
