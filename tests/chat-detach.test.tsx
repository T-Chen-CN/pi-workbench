// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatHeader } from '../src/components/ChatHeader'
import { usePanelStore } from '../src/store/panelStore'
import { useI18nStore } from '../src/store/i18nStore'
import { translations } from '../src/i18n/translations'
import { WorkspaceScopeProvider } from '../src/workspace/WorkspaceScope'

vi.mock('../src/api', () => ({
  api: {
    auxDetachAt: vi.fn(),
    onAgentSessionRootChanged: vi.fn(() => () => {}),
    onGitChanged: vi.fn(() => () => {}),
    worktreeStatus: vi.fn(async () => ({ success: false })),
  },
}))

const WORKSPACE = '/tmp/ws'
const zh = translations.zh

function installPopup() {
  const popup = {
    document: document.implementation.createHTMLDocument('blank'),
    closed: false,
    close() {
      this.closed = true
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: vi.fn(),
  }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  return popup
}

function renderHeader() {
  const t = (key: keyof typeof zh) => zh[key]
  return render(
    <WorkspaceScopeProvider value={WORKSPACE}>
      <ChatHeader
        t={t}
        initialized
        workspacePath={WORKSPACE}
        sessions={[]}
        handleSelectSession={vi.fn()}
        handleNewSession={vi.fn()}
        handleCloseTab={vi.fn()}
      />
    </WorkspaceScopeProvider>
  )
}

beforeEach(() => {
  usePanelStore.setState({ panelHost: {}, windows: {} })
  useI18nStore.getState().setLanguage?.('zh')
  installPopup()
})

afterEach(() => {
  cleanup()
  usePanelStore.setState({ panelHost: {}, windows: {} })
  vi.restoreAllMocks()
})

describe('chat panel detach', () => {
  it('offers detach from the header context menu', async () => {
    renderHeader()

    fireEvent.contextMenu(screen.getByText(zh.agentChatTitle))

    const item = await screen.findByRole('menuitem', { name: zh.panelDetach })
    expect(item).toBeTruthy()

    fireEvent.click(item)

    await waitFor(() =>
      expect(usePanelStore.getState().panelHost[WORKSPACE]?.chat).toMatch(/^aux:/)
    )
    expect(Object.values(usePanelStore.getState().windows)[0]?.panel).toBe('chat')
  })

  it('switches the menu to dock-back once the panel is detached', async () => {
    renderHeader()

    fireEvent.contextMenu(screen.getByText(zh.agentChatTitle))
    fireEvent.click(await screen.findByRole('menuitem', { name: zh.panelDetach }))
    await waitFor(() => expect(Object.keys(usePanelStore.getState().windows)).toHaveLength(1))

    fireEvent.contextMenu(screen.getByText(zh.agentChatTitle))
    expect(await screen.findByRole('menuitem', { name: zh.panelDockBack })).toBeTruthy()

    act(() => usePanelStore.getState().dockPanel(WORKSPACE, 'chat'))
    expect(usePanelStore.getState().windows).toEqual({})
  })

  it('shows the drag grip in the header', () => {
    renderHeader()
    expect(document.querySelector('[draggable="true"]')).toBeTruthy()
  })
})
