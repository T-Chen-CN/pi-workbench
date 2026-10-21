// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionTabs } from '../src/components/SessionTabs'
import { ChatSessionList } from '../src/components/ChatSessionList'
import { useI18nStore } from '../src/store/i18nStore'
import { useSessionStore } from '../src/store/sessionStore'
import { conversationKey } from '../src/store/chatStore'
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

  it('shows running and unread indicators', () => {
    useSessionStore.getState().markStreaming(WS, 'a', true)
    useSessionStore.getState().markUnread(WS, 'b', true)
    renderTabs()

    expect(
      document.querySelectorAll('.animate-pulse.rounded-full.bg-accent').length
    ).toBeGreaterThan(0)
    expect(document.querySelectorAll('.rounded-full.bg-accent').length).toBeGreaterThanOrEqual(2)
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

  it('shows an empty state when there are no sessions', () => {
    renderList({ sessions: [] })
    expect(screen.getByText(translations.zh.sessionsEmpty)).toBeTruthy()
  })
})
