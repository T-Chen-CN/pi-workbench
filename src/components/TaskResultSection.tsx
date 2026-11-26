/**
 * 工单结果与改动清单折叠区（桌面端 CloudView 与云端 Web 共用）。
 *
 * 外层卡片只展示去 Markdown 噪声后的单行摘要预览，避免长调研报告撑爆工单列表；
 * 展开后通过 StreamdownView 按完整 Markdown 排版呈现结果报告与改动/疑似密钥清单。
 * 零桌面端 store / Electron 依赖，可直接打进云端 Web 静态包。
 */

import React, { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { DataText, summarizeCloudTaskPreview as summarizeTaskPreview } from '@pi-workbench/cloud-ui'
import { StreamdownView } from './StreamdownView'

export { summarizeTaskPreview }

export interface TaskChangedFileItem {
  path: string
  kind?: string
  attention?: string
}

export interface TaskSecretHitItem {
  path: string
  line: number
  kind: string
}

export interface TaskResultSectionProps {
  taskId: string
  summary?: string
  changedFiles?: TaskChangedFileItem[]
  secretHits?: TaskSecretHitItem[]
  /** 侧栏窄视图限制展开高度；独立工单页给更充裕的阅读空间 */
  compact?: boolean
  language?: 'zh' | 'en'
}

export const TaskResultSection = React.memo(function TaskResultSection({
  taskId,
  summary,
  changedFiles = [],
  secretHits = [],
  compact = false,
  language = 'zh',
}: TaskResultSectionProps) {
  const [open, setOpen] = useState(false)
  const attentionFiles = changedFiles.filter((file) => Boolean(file.attention))
  const normalFiles = changedFiles.filter((file) => !file.attention)
  const hasSummary = Boolean(summary?.trim())
  if (!hasSummary && changedFiles.length === 0 && secretHits.length === 0) return null

  const zh = language === 'zh'
  const label = zh ? '结果与改动清单' : 'Result & changes'
  const metaParts: string[] = []
  if (changedFiles.length > 0) {
    metaParts.push(
      zh ? `${changedFiles.length} 个文件` : `${changedFiles.length} file${changedFiles.length > 1 ? 's' : ''}`
    )
  }
  if (attentionFiles.length > 0) {
    metaParts.push(zh ? `${attentionFiles.length} 项注意` : `${attentionFiles.length} attention`)
  }
  if (secretHits.length > 0) {
    metaParts.push(zh ? `${secretHits.length} 处疑似密钥` : `${secretHits.length} secret hits`)
  }
  const contentId = `task-result-${taskId}`

  return (
    <div className="pt-0.5">
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
        <span>{label}</span>
        {metaParts.length > 0 && (
          <span
            className={`truncate type-caption ${
              secretHits.length > 0
                ? 'text-danger'
                : attentionFiles.length > 0
                  ? 'text-warning'
                  : 'text-ink-muted'
            }`}
          >
            · {metaParts.join(' · ')}
          </span>
        )}
      </button>

      {open && (
        <div
          id={contentId}
          className={`mt-2 flex flex-col gap-2.5 border border-rule-hairline bg-sunken p-3 ${
            compact ? 'max-h-80 overflow-y-auto' : ''
          }`}
        >
          {hasSummary && (
            <StreamdownView
              content={summary!}
              isStreaming={false}
              showCursor={false}
              highlight={summary!.length <= 20_000}
              language={language}
              className="chat-markdown agent-trace-markdown text-ink"
            />
          )}
          {(attentionFiles.length > 0 || normalFiles.length > 0 || secretHits.length > 0) && (
            <div
              className={`flex flex-col gap-1.5 ${
                hasSummary ? 'border-t border-rule-divide pt-2' : ''
              }`}
            >
              {attentionFiles.length > 0 && (
                <DataText className="break-words text-warning">
                  {zh ? '注意：' : 'Attention: '}
                  {attentionFiles.map((file) => `${file.path} (${file.attention})`).join(', ')}
                </DataText>
              )}
              {normalFiles.length > 0 && (
                <DataText className="break-words text-ink-muted">
                  {zh ? '改动：' : 'Changed: '}
                  {normalFiles.map((file) => file.path).join(', ')}
                </DataText>
              )}
              {secretHits.length > 0 && (
                <DataText className="break-words text-danger">
                  {zh ? '疑似密钥（仅报位置）：' : 'Potential secrets (locations only): '}
                  {secretHits.map((hit) => `${hit.path}:${hit.line} (${hit.kind})`).join(', ')}
                </DataText>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})
