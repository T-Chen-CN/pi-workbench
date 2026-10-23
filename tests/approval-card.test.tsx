// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalCard } from '../src/components/ApprovalCard'
import { useI18nStore } from '../src/store/i18nStore'
import { translations } from '../src/i18n/translations'
import type { ApprovalRequestPayload } from '../src/types/electron'

const request: ApprovalRequestPayload = {
  requestId: 'req-1',
  workspaceDir: 'F:/work',
  sessionId: 'session-1',
  toolCallId: 'call-1',
  toolName: 'bash',
  category: 'command',
  summary: 'npm test',
  details: { command: 'npm test' },
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
}

beforeEach(() => {
  useI18nStore.getState().setLanguage('zh')
})

afterEach(() => {
  cleanup()
})

describe('ApprovalCard', () => {
  it('shows the tool, category and command', () => {
    render(<ApprovalCard request={request} onRespond={vi.fn()} />)
    const zh = translations.zh
    expect(screen.getByText(zh.approvalTitle)).toBeTruthy()
    expect(screen.getByText(zh.approvalCategoryCommand)).toBeTruthy()
    expect(screen.getByText('npm test')).toBeTruthy()
  })

  it('responds with allow once', () => {
    const onRespond = vi.fn()
    render(<ApprovalCard request={request} onRespond={onRespond} />)
    fireEvent.click(screen.getByText(translations.zh.approvalAllowOnce))
    expect(onRespond).toHaveBeenCalledWith('req-1', { action: 'allow-once' })
  })

  it('responds with allow for session and always', () => {
    const sessionRespond = vi.fn()
    const first = render(<ApprovalCard request={request} onRespond={sessionRespond} />)
    fireEvent.click(screen.getByText(translations.zh.approvalAllowSession))
    expect(sessionRespond).toHaveBeenCalledWith('req-1', { action: 'allow-session' })
    first.unmount()

    const alwaysRespond = vi.fn()
    render(<ApprovalCard request={request} onRespond={alwaysRespond} />)
    fireEvent.click(screen.getByText(translations.zh.approvalAllowAlways))
    expect(alwaysRespond).toHaveBeenCalledWith('req-1', { action: 'allow-always' })
  })

  it('sends a denial with the optional reason', () => {
    const onRespond = vi.fn()
    render(<ApprovalCard request={request} onRespond={onRespond} />)
    fireEvent.click(screen.getByText(translations.zh.approvalDeny))
    fireEvent.change(screen.getByPlaceholderText(translations.zh.approvalDenyReason), {
      target: { value: '改错文件了' },
    })
    fireEvent.click(screen.getByText(translations.zh.approvalDenyConfirm))
    expect(onRespond).toHaveBeenCalledWith('req-1', { action: 'deny', reason: '改错文件了' })
  })
})
