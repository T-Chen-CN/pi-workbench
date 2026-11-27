// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatHeader } from '../../src/components/chat/ChatHeader'
import { usePanelStore } from '../../src/store/panelStore'
import { useI18nStore } from '../../src/store/i18nStore'
import { translations } from '../../src/i18n/translations'
import { WorkspaceScopeProvider } from '../../src/workspace/WorkspaceScope'

vi.mock('../../src/api', () => ({
  api: {
    auxDetachAt: vi.fn(),
    panelDetach: vi.fn(async (req: { hostId: string }) => ({
      success: true,
      hostId: req.hostId,
      frameName: `pi-panel:${req.hostId}`,
    })),
    panelDock: vi.fn(async () => ({ success: true })),
    onAgentSessionRootChanged: vi.fn(() => () => {}),
    onGitChanged: vi.fn(() => () => {}),
    worktreeStatus: vi.fn(async () => ({ success: false })),
  },
}))

const { api } = await import('../../src/api')
const WORKSPACE = '/tmp/ws'
const zh = translations.zh

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
  vi.mocked(api.panelDetach).mockClear()
  vi.mocked(api.panelDock).mockClear()
})

afterEach(() => {
  cleanup()
  usePanelStore.setState({ panelHost: {}, windows: {} })
  vi.restoreAllMocks()
})

describe('chat panel detach', () => {
  it('offers detach from the header context menu and invokes panel:detach', async () => {
    renderHeader()

    fireEvent.contextMenu(screen.getByText(zh.agentChatTitle))

    const item = await screen.findByRole('menuitem', { name: zh.panelDetach })
    expect(item).toBeTruthy()

    fireEvent.click(item)

    await waitFor(() =>
      expect(usePanelStore.getState().panelHost[WORKSPACE]?.chat).toMatch(/^aux:/)
    )
    expect(api.panelDetach).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: WORKSPACE, panel: 'chat' })
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
    expect(api.panelDock).toHaveBeenCalled()
    expect(usePanelStore.getState().windows).toEqual({})
  })

  it('shows the drag grip in the header', () => {
    renderHeader()
    expect(document.querySelector('[draggable="true"]')).toBeTruthy()
  })
})
