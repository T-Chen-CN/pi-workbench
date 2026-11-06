// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CloudToolCard } from '../src/components/CloudToolCard'
import { useI18nStore } from '../src/store/i18nStore'
import { translations } from '../src/i18n/translations'
import type { CloudTracePart } from '../src/types/cloud'

const zh = translations.zh

type ToolPart = Extract<CloudTracePart, { type: 'tool' }>

const base: ToolPart = {
  type: 'tool',
  id: 't:call_1',
  toolCallId: 'call_1',
  toolName: 'terminal',
  argsSummary: 'ls /root/nonexistent-dir',
  status: 'error',
  resultPreview: '',
}

describe('CloudToolCard', () => {
  afterEach(() => {
    cleanup()
    useI18nStore.setState({ locale: 'zh' })
  })

  it('explains a failure that came with no error text', () => {
    // 上游 tool.completed 只给 error:true + 空 preview —— 卡片不能变成一个空抽屉
    render(<CloudToolCard part={base} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(zh.cloudToolFailedNoDetail)).toBeTruthy()
  })

  it('stays expandable when a failed call has no args either', () => {
    render(<CloudToolCard part={{ ...base, argsSummary: '' }} />)
    const button = screen.getByRole('button') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(screen.getByText(zh.cloudToolFailedNoDetail)).toBeTruthy()
  })

  it('shows the result preview instead of the hint when there is one', () => {
    render(
      <CloudToolCard
        part={{ ...base, status: 'success', resultPreview: 'g1-ok' }}
      />
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('g1-ok')).toBeTruthy()
    expect(screen.queryByText(zh.cloudToolFailedNoDetail)).toBeNull()
  })

  it('does not open a successful call that has nothing to show', () => {
    render(<CloudToolCard part={{ ...base, status: 'success', argsSummary: '' }} />)
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
  })
})
