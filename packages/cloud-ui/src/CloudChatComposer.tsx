import React, { useRef } from 'react'
import { Send, Square } from 'lucide-react'
import { translate, type Language } from '@pi-workbench/i18n'
import { Button, Caption, Textarea } from '@pi-workbench/ui'
import type { CloudAgentStatusName } from './types'

export interface CloudChatComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  canStopReply: boolean
  onStopReply: () => void
  language?: Language
  agentStatus?: CloudAgentStatusName
  /** 可选覆盖状态文案；未传时根据 `agentStatus` 按 `language` 自动生成 */
  agentStatusText?: string
  extraActions?: React.ReactNode
  showIcons?: boolean
  stopButtonVariant?: 'ghost' | 'secondary'
  textareaAriaLabel?: string
  placeholder?: string
  shortcutHint?: string
  className?: string
  innerClassName?: string
  shortcutClassName?: string
  statusClassName?: string
}

/**
 * 桌面端 CloudView 与云端 Web 共用的多行消息输入区：
 * 内置 Enter 发送 / Shift+Enter 换行 / IME 组合态保护（composition + keyCode 229）。
 */
export const CloudChatComposer: React.FC<CloudChatComposerProps> = ({
  value,
  onChange,
  onSend,
  canStopReply,
  onStopReply,
  language = 'zh',
  agentStatus = 'idle',
  agentStatusText,
  extraActions,
  showIcons = false,
  stopButtonVariant = 'secondary',
  textareaAriaLabel,
  placeholder,
  shortcutHint,
  className = 'flex-shrink-0 border-t border-rule-divide bg-panel',
  innerClassName = 'flex flex-col gap-2 px-4 py-3',
  shortcutClassName = 'text-ink-muted',
  statusClassName = 'ml-auto text-ink-muted',
}) => {
  const composingRef = useRef(false)

  const resolvedStatus =
    agentStatusText !== undefined
      ? agentStatusText
      : agentStatus === 'thinking'
        ? translate(language, 'cloudAgentThinking')
        : agentStatus === 'replying'
          ? translate(language, 'cloudAgentReplying')
          : ''

  return (
    <div className={className}>
      <div className={innerClassName}>
        <Textarea
          aria-label={textareaAriaLabel ?? translate(language, 'cloudWebComposerAria')}
          value={value}
          rows={3}
          placeholder={placeholder ?? translate(language, 'cloudSendPlaceholder')}
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !composingRef.current &&
              !event.nativeEvent.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault()
              onSend()
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={!value.trim()} onClick={onSend}>
            {showIcons && <Send size={13} aria-hidden="true" />}
            {translate(language, 'cloudSend')}
          </Button>
          <Button
            variant={stopButtonVariant}
            size="sm"
            disabled={!canStopReply}
            onClick={onStopReply}
          >
            {showIcons && <Square size={13} aria-hidden="true" />}
            {translate(language, 'cloudStopReply')}
          </Button>
          {extraActions}
          <Caption className={shortcutClassName}>
            {shortcutHint ?? translate(language, 'cloudSendShortcutHint')}
          </Caption>
          {resolvedStatus && <Caption className={statusClassName}>{resolvedStatus}</Caption>}
        </div>
      </div>
    </div>
  )
}
