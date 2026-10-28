// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentParts } from '../src/components/AgentTrace'
import { ChatMessageRow } from '../src/components/ChatMessageRow'
import type { ChatMessage } from '../src/store/chatStore'
import { useI18nStore } from '../src/store/i18nStore'
import { translations } from '../src/i18n/translations'
import type { AgentTracePart } from '../src/types/electron'

const parts: AgentTracePart[] = [
  { type: 'text', id: 'text-1', text: 'before compaction' },
  {
    type: 'compaction',
    id: 'compaction-c1',
    entryId: 'c1',
    timestamp: 1_500,
    tokensBefore: 128_000,
  },
  { type: 'text', id: 'text-2', text: 'after compaction' },
]

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'before compaction\nafter compaction',
    timestamp: 1_000,
    parts,
    ...overrides,
  }
}

beforeEach(() => {
  useI18nStore.setState({ language: 'zh' })
})

afterEach(() => {
  cleanup()
})

describe('compaction divider rendering', () => {
  it('keeps the divider at its place in the part timeline', () => {
    const { container } = render(<AgentParts parts={parts} isStreaming={false} />)
    const text = container.textContent ?? ''

    expect(screen.getByRole('separator')).toBeTruthy()
    expect(text.indexOf('before compaction')).toBeLessThan(
      text.indexOf('上下文已压缩')
    )
    expect(text.indexOf('上下文已压缩')).toBeLessThan(
      text.indexOf('after compaction')
    )
  })

  it('shows the token count and drops any manual/auto wording', () => {
    render(<AgentParts parts={parts} isStreaming={false} />)
    const label = screen.getByText('上下文已压缩 · 压缩前 128,000 tokens')
    const text = label.textContent ?? ''

    expect(text).not.toContain('手动')
    expect(text).not.toContain('自动')
  })

  it('falls back to a token-free label when the count is unknown', () => {
    render(
      <AgentParts
        parts={[{ type: 'compaction', id: 'compaction-c2', timestamp: 2_000 }]}
        isStreaming={false}
      />
    )

    expect(screen.getByText(translations.zh.compactionDivider)).toBeTruthy()
  })

  it('follows the language setting', () => {
    useI18nStore.setState({ language: 'en' })
    render(<AgentParts parts={parts} isStreaming={false} />)

    expect(screen.getByText('Context compacted · 128,000 tokens before')).toBeTruthy()
  })

  it('hides the row header when the message only carries a divider', () => {
    render(<ChatMessageRow message={assistantMessage({ content: '', parts: [parts[1]] })} />)

    expect(screen.getByRole('separator')).toBeTruthy()
    expect(screen.queryByText(translations.zh.piAgent)).toBeNull()
  })

  it('keeps the header when the divider shares the turn with text', () => {
    render(<ChatMessageRow message={assistantMessage()} />)

    expect(screen.getByText(translations.zh.piAgent)).toBeTruthy()
    expect(screen.getByRole('separator')).toBeTruthy()
  })

  it('still renders legacy system dividers without parts', () => {
    render(
      <ChatMessageRow
        message={{
          id: 'old',
          role: 'system',
          content: '上下文已压缩',
          timestamp: 1_000,
        }}
      />
    )

    expect(screen.getByText('上下文已压缩')).toBeTruthy()
  })
})
