import type React from 'react'
import type { TranslationKey } from '../i18n/translations'
import type { ChatMessage } from '../store/chatStore'
import type { SessionPermission, SessionSummary } from '../types/electron'

export interface ChatPanelProps {
  workspacePath: string
  /** 当前会话的工作树根；文件搜索、附加打开文件以它为基准 */
  viewRoot?: string
  onCollapse?: () => void
  collapseButtonRef?: React.Ref<HTMLButtonElement>
  panelId?: string
  active?: boolean
}

/** 单条消息的附件上限（文件 + 图片合计） */
export const MAX_ATTACHMENTS = 10
/** 片段上下文上限（选区 / 划词引用仍然内联） */
export const MAX_CONTEXT_SNIPPET_CHARS = 40_000
export const MAX_CONTEXT_TOTAL_CHARS = 300_000

/** 1.2k / 12k / 96k */
export function formatTokenCount(value: number): string {
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
}

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export const THINKING_LABEL_KEYS: Record<(typeof THINKING_LEVELS)[number], TranslationKey> = {
  off: 'thinkingOff',
  minimal: 'thinkingMinimal',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  xhigh: 'thinkingXhigh',
  max: 'thinkingMax',
}

export const DEFAULT_SESSION_PERMISSION: SessionPermission = { mode: 'ask', grants: [] }

export const EMPTY_SESSIONS: SessionSummary[] = []
export const EMPTY_MESSAGES: ChatMessage[] = []

