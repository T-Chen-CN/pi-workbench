// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionTabs } from '../src/components/SessionTabs'
import { ChatSessionList } from '../src/components/ChatSessionList'
import { useI18nStore } from '../src/store/i18nStore'
import { useSessionStore } from '../src/store/sessionStore'
import { conversationKey, useChatStore } from '../src/store/chatStore'
import { translations } from '../src/i18n/translations'
import type { SessionSummary } from '../src/types/electron'

const WS = '/ws'
const sessions: SessionSummary[] = [
  { id: 'a', title: 'Fix login', messageCount: 3, createdAt: 1, updatedAt: 2 },
  { id: 'b', title: 'Refactor tree', messageCount: 5, createdAt: 1, updatedAt: 3 },
]

beforeEach(() => {
  useI18nStore.getState().setLanguage('zh')
  useSessionStore.getState().reset()
  useSessionStore.getState().setSessions(WS, sessions)
  useSessionStore.getState().setOpen(WS, ['a', 'b'], 'a')
})

afterEach(() => {
  cleanup()
})

describe('SessionTabs', () => {
  const renderTabs = (overrides: Partial<ComponentProps<typeof SessionTabs>> = {}) => {
    const props = {
      workspacePath: WS,
      sessions,
      onSelect: vi.fn(),
      onNew: vi.fn(),
      onClose: vi.fn(),
      onOpenList: vi.fn(),
      ...overrides,
    }
    render(<SessionTabs {...props} />)
    return props
  }

  it('renders open tabs and switches on click', () => {
    const props = renderTabs()

    fireEvent.click(screen.getByRole('tab', { name: /Refactor tree/ }))
    expect(props.onSelect).toHaveBeenCalledWith('b')
  })

  it('creates a new session and opens the session list', () => {
    const props = renderTabs()

    fireEvent.click(screen.getByLabelText(translations.zh.newSession))
    fireEvent.click(screen.getByLabelText(translations.zh.sessionList))
    expect(props.onNew).toHaveBeenCalled()
    expect(props.onOpenList).toHaveBeenCalled()
  })

  it('closes a tab', () => {
    const props = renderTabs()

    fireEvent.click(screen.getAllByLabelText(translations.zh.closeSessionTab)[0])
    expect(props.onClose).toHaveBeenCalledWith('a')
  })

  it('多个未命名会话按序号区分', () => {
    const untitled: SessionSummary[] = [
      { id: 'x', title: '', messageCount: 0, createdAt: 1, updatedAt: 2 },
      { id: 'y', title: '  ', messageCount: 0, createdAt: 1, updatedAt: 3 },
    ]
    useSessionStore.getState().setSessions(WS, untitled)
    useSessionStore.getState().setOpen(WS, ['x', 'y'], 'x')
    renderTabs({ sessions: untitled })

    expect(screen.getByRole('tab', { name: new RegExp(`${translations.zh.untitledSession} 1`) })).toBeTruthy()
    expect(screen.getByRole('tab', { name: new RegExp(`${translations.zh.untitledSession} 2`) })).toBeTruthy()
  })

  it('唯一未命名会话不加序号', () => {
    const untitled: SessionSummary[] = [
      { id: 'x', title: '', messageCount: 0, createdAt: 1, updatedAt: 2 },
    ]
    useSessionStore.getState().setSessions(WS, untitled)
    useSessionStore.getState().setOpen(WS, ['x'], 'x')
    renderTabs({ sessions: untitled })

    expect(screen.getByRole('tab', { name: translations.zh.untitledSession })).toBeTruthy()
  })

  it('shows running, error, needs-action, unread and draft states', () => {
    useSessionStore.getState().markStreaming(WS, 'a', true)
    useSessionStore.getState().markError(WS, 'b', 'provider down')
    useSessionStore.getState().markNeedsAction(WS, 'a', 'review')
    useSessionStore.getState().markUnread(WS, 'a', true)
    useChatStore.getState().ensureConversation(conversationKey(WS, 'a'))
    useChatStore.getState().setDraftInput(conversationKey(WS, 'a'), 'half typed')
    renderTabs()

    // 运行中优先于待操作/未读/草稿
    const runningTab = screen.getByRole('tab', { name: /Fix login/ })
    expect(runningTab.querySelector('.animate-pulse.bg-accent')).toBeTruthy()
    expect(runningTab.getAttribute('aria-busy')).toBe('true')
    expect(runningTab.getAttribute('aria-label')).toContain(translations.zh.sessionRunning)
    expect(runningTab.getAttribute('aria-label')).toContain(translations.zh.sessionDraft)
    expect(screen.getByLabelText(translations.zh.sessionDraft)).toBeTruthy()

    // 错误优先于未读；tooltip 带错误摘要
    const errorTab = screen.getByRole('tab', { name: /Refactor tree/ })
    expect(errorTab.querySelector('.text-danger')).toBeTruthy()
    expect(errorTab.getAttribute('aria-label')).toContain(translations.zh.sessionError)
    expect(errorTab.getAttribute('title')).toContain('provider down')
  })

  it('renders the needs-action target as a hollow warning ring with a center dot', () => {
    useSessionStore.getState().markNeedsAction(WS, 'b', 'review')
    renderTabs()

    const tab = screen.getByRole('tab', { name: /Refactor tree/ })
    const ring = tab.querySelector('.animate-breathe')
    expect(ring).toBeTruthy()
    expect(ring?.className).toContain('border-warning')
    expect(ring?.className).toContain('shadow-')
    expect(ring?.querySelector('.bg-warning')).toBeTruthy()
    expect(tab.getAttribute('aria-label')).toContain(translations.zh.sessionNeedsAction)
  })

  it('shows the unread state as a static success dot', () => {
    useSessionStore.getState().markUnread(WS, 'b', true)
    renderTabs()

    const dot = screen.getByRole('tab', { name: /Refactor tree/ }).querySelector('.bg-success')
    expect(dot).toBeTruthy()
    expect(dot?.className).not.toContain('animate')
  })
})

describe('ChatSessionList', () => {
  const renderList = (overrides: Partial<ComponentProps<typeof ChatSessionList>> = {}) => {
    const props = {
      workspacePath: WS,
      open: true,
      sessions,
      onClose: vi.fn(),
      onSelect: vi.fn(),
      onNew: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      ...overrides,
    }
    render(<ChatSessionList {...props} />)
    return props
  }

  it('lists sessions with metadata and selects one', () => {
    const props = renderList()

    expect(screen.getByText('Fix login')).toBeTruthy()
    expect(screen.getByText('Refactor tree')).toBeTruthy()
    fireEvent.click(screen.getByText('Refactor tree'))
    expect(props.onSelect).toHaveBeenCalledWith(sessions[1])
  })

  it('shows which sessions are open and active', () => {
    useSessionStore.getState().markStreaming(WS, 'a', true)
    renderList()

    expect(screen.getAllByText(translations.zh.sessionOpened)).toHaveLength(2)
    expect(
      useSessionStore.getState().streaming[conversationKey(WS, 'a')]
    ).toBe(true)
  })

  it('creates, renames and deletes sessions', () => {
    const props = renderList()

    fireEvent.click(screen.getByLabelText(translations.zh.newSession))
    fireEvent.click(screen.getAllByLabelText(translations.zh.renameSession)[0])
    fireEvent.click(screen.getAllByLabelText(translations.zh.deleteSession)[0])

    expect(props.onNew).toHaveBeenCalled()
    expect(props.onRename).toHaveBeenCalledWith(sessions[0])
    expect(props.onDelete).toHaveBeenCalledWith(sessions[0])
  })

  it('offers markdown, HTML and raw JSONL export', () => {
    const onExport = vi.fn()
    renderList({ onExport })

    fireEvent.click(screen.getAllByLabelText(translations.zh.exportSession)[0])
    fireEvent.click(screen.getByText(translations.zh.exportHtml))

    expect(onExport).toHaveBeenCalledWith(sessions[0], 'html')
  })

  it('shows an empty state when there are no sessions', () => {
    renderList({ sessions: [] })
    expect(screen.getByText(translations.zh.sessionsEmpty)).toBeTruthy()
  })
})
