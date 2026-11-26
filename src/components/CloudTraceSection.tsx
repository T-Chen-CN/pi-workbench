/**
 * 云端会话（桌面端 CloudView + 云端 Web）共用的思考过程与工具调用折叠块。
 *
 * 设计对齐 DESIGN_SYSTEM §6.5 过程轨迹：干活中（流式且尚无最终正文）自动以限高滚窗展开并跟随底部，
 * 一旦开始输出正文或本轮结束自动收拢成单条摘要；用户手动切换后优先保留用户选择（手动展开不限高）。
 * 零桌面端 store / Electron 依赖，可直接被打进云端 Web 静态包。
 */

import React, { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronRight, Loader2 } from 'lucide-react'
import { StreamdownView } from './StreamdownView'
import { Caption, DataText } from './ui'

export interface CloudProcessTraceItem {
  id: string
  toolName: string
  summary: string
  status: 'running' | 'ok' | 'error'
  durationMs?: number
  resultPreview?: string
}

export interface CloudTraceSectionProps {
  messageId: string
  thinking?: string
  thinkingRedacted?: boolean
  thinkingDurationMs?: number
  traces: CloudProcessTraceItem[]
  isStreaming: boolean
  /** 正文是否已经开始输出；正文尚未开始且有思考内容时判定为「正在思考」 */
  hasBodyText: boolean
  language?: 'zh' | 'en'
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

export const CloudTraceSection = React.memo(function CloudTraceSection({
  messageId,
  thinking,
  thinkingRedacted,
  thinkingDurationMs,
  traces,
  isStreaming,
  hasBodyText,
  language = 'zh',
}: CloudTraceSectionProps) {
  // 三态控制：null 跟随两阶段自动展开/收起，非 null 时完全尊重用户手动切换
  const [userOverride, setUserOverride] = useState<boolean | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)

  const hasThinking = Boolean(thinking || thinkingRedacted)
  const liveAutoOpen = isStreaming && !hasBodyText
  const open = userOverride ?? liveAutoOpen
  const isConstrainedLive = open && liveAutoOpen && userOverride === null
  const lastTrace = traces[traces.length - 1]
  const scrollSignal =
    (thinking?.length ?? 0) +
    traces.length * 10000 +
    (lastTrace ? (lastTrace.summary?.length ?? 0) + (lastTrace.status === 'running' ? 1 : 2) : 0)

  useEffect(() => {
    if (!isConstrainedLive) {
      stickToBottomRef.current = true
      return
    }
    const el = scrollRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [isConstrainedLive, scrollSignal])

  if (!hasThinking && traces.length === 0) return null

  const zh = language === 'zh'
  const runningTool = [...traces].reverse().find((item) => item.status === 'running')
  const thinkingActive = isStreaming && hasThinking && !hasBodyText && !runningTool
  const failedCount = traces.filter((item) => item.status === 'error').length
  const running = Boolean(runningTool) || thinkingActive

  let label = zh ? '过程' : 'Process'
  let detail = ''
  let dangerDetail = false

  if (runningTool) {
    label = zh ? `正在调用 ${runningTool.toolName}…` : `Running ${runningTool.toolName}…`
  } else if (thinkingActive) {
    label = zh ? '正在思考…' : 'Thinking…'
  } else {
    const bits: string[] = []
    if (failedCount > 0) {
      bits.push(zh ? `${failedCount} 个工具失败` : `${failedCount} tool failed`)
      dangerDetail = true
    }
    if (thinkingDurationMs && thinkingDurationMs > 0) {
      bits.push(
        zh
          ? `思考 ${formatSeconds(thinkingDurationMs)} 秒`
          : `Thought ${formatSeconds(thinkingDurationMs)}s`
      )
    } else if (hasThinking) {
      bits.push(zh ? '含思考过程' : 'Thinking')
    }
    if (traces.length > 0) {
      bits.push(zh ? `${traces.length} 个工具` : `${traces.length} tools`)
    }
    detail = bits.join(' · ')
  }

  const contentId = `cloud-trace-${messageId}`

  return (
    <div className="py-0.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setUserOverride(!open)}
        className="flex w-full items-center gap-1.5 text-left type-label text-ink-muted transition-colors hover:text-ink"
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={`flex-shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        {running && (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-accent"
          />
        )}
        <span>{label}</span>
        {detail && (
          <span
            className={`truncate type-caption ${dangerDetail ? 'text-danger' : 'text-ink-muted'}`}
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
          className={`mt-1.5 flex flex-col gap-1.5 border-l border-rule-hairline pl-3 ${
            isConstrainedLive ? 'max-h-60 overflow-y-auto pr-1' : ''
          }`}
        >
          {thinkingRedacted && (
            <Caption className="text-ink-muted">
              {zh ? '（思考内容已由模型隐去）' : '(Thinking content redacted by model)'}
            </Caption>
          )}
          {thinking && (
            <StreamdownView
              content={thinking}
              isStreaming={thinkingActive}
              showCursor={false}
              highlight={false}
              language={language}
              className="chat-markdown agent-trace-markdown text-ink-muted"
            />
          )}
          {traces.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {traces.map((trace) => (
                <li key={trace.id} className="flex items-start gap-1.5 py-0.5">
                  {trace.status === 'running' ? (
                    <Loader2 size={12} className="mt-0.5 flex-shrink-0 animate-spin text-accent" />
                  ) : trace.status === 'error' ? (
                    <AlertCircle size={12} className="mt-0.5 flex-shrink-0 text-danger" />
                  ) : (
                    <Check size={12} className="mt-0.5 flex-shrink-0 text-success" />
                  )}
                  <span className="flex-shrink-0 type-label text-ink">{trace.toolName}</span>
                  {trace.summary && (
                    <DataText
                      className={`min-w-0 flex-1 truncate ${
                        trace.status === 'error' ? 'text-danger' : 'text-ink-muted'
                      }`}
                      title={trace.summary}
                    >
                      {trace.summary}
                    </DataText>
                  )}
                  {typeof trace.durationMs === 'number' && (
                    <Caption className="flex-shrink-0 text-ink-muted">
                      {formatDuration(trace.durationMs)}
                    </Caption>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
})
