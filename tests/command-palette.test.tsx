// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '../src/components/CommandPalette'
import { useI18nStore } from '../src/store/i18nStore'
import { useSelectionStore } from '../src/store/selectionStore'
import { useSessionStore } from '../src/store/sessionStore'
import { api } from '../src/api'
import { piAgentAPI } from '../src/api/piAgentAPI'
import { translations } from '../src/i18n/translations'
import type { PluginInfo } from '../src/types/electron'

vi.mock('../src/api', () => ({
  api: {
    pluginsList: vi.fn(),
    pluginsInvoke: vi.fn(),
    pluginsReload: vi.fn(),
    pluginsSetEnabled: vi.fn(),
    onPluginsChanged: vi.fn(() => () => {}),
  },
}))

vi.mock('../src/api/piAgentAPI', () => ({
  piAgentAPI: {
    listPromptResources: vi.fn(),
  },
}))

const plugin: PluginInfo = {
  id: 'git',
  name: 'Git Tools',
  enabled: true,
  commands: [
    {
      id: 'git.status',
      title: 'Git Status',
      description: 'Show working tree status',
      pluginId: 'git',
      pluginName: 'Git Tools',
    },
  ],
}

beforeEach(() => {
  useI18nStore.getState().setLanguage('zh')
  useSelectionStore.getState().clearSelection()
  useSessionStore.getState().reset()
  vi.clearAllMocks()
  vi.mocked(piAgentAPI.listPromptResources).mockResolvedValue({
    success: true,
    templates: [],
    skills: [],
  })
  vi.mocked(api.pluginsList).mockResolvedValue({ success: true, plugins: [plugin] })
  vi.mocked(api.pluginsInvoke).mockResolvedValue({ success: true, output: 'clean' })
  vi.mocked(api.onPluginsChanged).mockReturnValue(() => {})
})

afterEach(() => {
  cleanup()
})

function openPalette() {
  fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true })
}

describe('CommandPalette', () => {
  it('opens with Ctrl+Shift+P and lists built-in and plugin commands', async () => {
    render(<CommandPalette workspacePath="/ws" />)

    openPalette()
    expect(screen.getByRole('dialog')).toBeTruthy()

    expect(await screen.findByText('Git Status')).toBeTruthy()
    expect(screen.getByText(translations.zh.attachSelection)).toBeTruthy()
  })

  it('filters commands by query and shows an empty state', async () => {
    render(<CommandPalette workspacePath="/ws" />)
    openPalette()
    await screen.findByText('Git Status')

    const input = screen.getByPlaceholderText(translations.zh.pluginCommands)
    fireEvent.change(input, { target: { value: 'status' } })
    expect(screen.getByText('Git Status')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'no-such-command' } })
    expect(screen.getByText(translations.zh.noPluginCommands)).toBeTruthy()
  })

  it('inserts prompt templates and skills into the chat input', async () => {
    useSessionStore.getState().setSessions('/ws', [])
    useSessionStore.getState().setOpen('/ws', ['s1'], 's1')
    vi.mocked(piAgentAPI.listPromptResources).mockResolvedValue({
      success: true,
      templates: [{ name: 'review', description: 'Review changes', scope: 'user' }],
      skills: [],
    })
    const listener = vi.fn()
    window.addEventListener('pi:insert-slash', listener)

    render(<CommandPalette workspacePath="/ws" />)
    openPalette()

    fireEvent.click(await screen.findByText('/review'))

    expect(listener).toHaveBeenCalledTimes(1)
    const event = listener.mock.calls[0][0] as CustomEvent<{ insert: string }>
    expect(event.detail.insert).toBe('/review ')
    window.removeEventListener('pi:insert-slash', listener)
  })

  it('runs the selected command with Enter', async () => {
    render(<CommandPalette workspacePath="/ws" />)
    openPalette()
    await screen.findByText('Git Status')

    const input = screen.getByPlaceholderText(translations.zh.pluginCommands)
    fireEvent.change(input, { target: { value: 'git' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(api.pluginsInvoke).toHaveBeenCalledWith('/ws', 'git.status', undefined)
    })
  })

  it('dispatches attach-selection for the built-in command when text is selected', async () => {
    useSelectionStore.getState().setSelection({
      path: '/tmp/a.ts',
      name: 'a.ts',
      startLine: 1,
      endLine: 2,
      text: 'a\nb',
    })
    const listener = vi.fn()
    window.addEventListener('attach-selection', listener)

    render(<CommandPalette workspacePath="/ws" />)
    openPalette()
    await screen.findByText('Git Status')

    fireEvent.click(screen.getByText(translations.zh.attachSelection))

    expect(listener).toHaveBeenCalled()
    window.removeEventListener('attach-selection', listener)
  })

  it('reports an empty selection instead of dispatching', async () => {
    const listener = vi.fn()
    window.addEventListener('attach-selection', listener)

    render(<CommandPalette workspacePath="/ws" />)
    openPalette()
    await screen.findByText('Git Status')

    fireEvent.click(screen.getByText(translations.zh.attachSelection))

    expect(listener).not.toHaveBeenCalled()
    expect(screen.getByText(new RegExp(translations.zh.selectionEmpty))).toBeTruthy()
    window.removeEventListener('attach-selection', listener)
  })

  it('closes on Escape', async () => {
    render(<CommandPalette workspacePath="/ws" />)
    openPalette()
    await screen.findByText('Git Status')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
