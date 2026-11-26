/**
 * 云端会话（桌面端 CloudView + 云端 Web）共用的思考过程与工具调用折叠块。
 *
 * 设计对齐 DESIGN_SYSTEM §6.5 过程轨迹：默认收起，流式期间头部显示脉冲点与实时状态，
 * 展开后以降低一级排版呈现思考正文（无光标）及工具调用步骤与耗时。
 * 零桌面端 store / Electron 依赖，可直接被打进云端 Web 静态包。
 */

import React, { useState } from 'react'
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
  const [open, setOpen] = useState(false)
  const hasThinking = Boolean(thinking || thinkingRedacted)
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
        onClick={() => setOpen((value) => !value)}
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
          id={contentId}
          aria-busy={running}
          className="mt-1.5 flex flex-col gap-1.5 border-l border-rule-hairline pl-3"
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
