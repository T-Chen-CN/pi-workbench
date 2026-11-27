// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MenuOption, Modal, PopoverMenu } from '../../src/components/ui/ui'
import { Tabs, TabsList, TabsPanel, TabsRoot, TabsTab } from '../../src/components/ui/patterns'
import { CommandPalette } from '../../src/components/workspace/CommandPalette'
import { useI18nStore } from '../../src/store/i18nStore'
import { useSelectionStore } from '../../src/store/selectionStore'
import { useSessionStore } from '../../src/store/sessionStore'
import { api } from '../../src/api'
import { piAgentAPI } from '../../src/api/piAgentAPI'
import { translations } from '../../src/i18n/translations'
import type { PluginInfo } from '../../src/types/electron'

vi.mock('../../src/api', () => ({
  api: {
    pluginsList: vi.fn(),
    pluginsInvoke: vi.fn(),
    pluginsReload: vi.fn(),
    pluginsSetEnabled: vi.fn(),
    onPluginsChanged: vi.fn(() => () => {}),
  },
}))

vi.mock('../../src/api/piAgentAPI', () => ({
  piAgentAPI: {
    listPromptResources: vi.fn(),
  },
}))

const samplePlugin: PluginInfo = {
  id: 'lint',
  name: 'Lint Suite',
  enabled: true,
  commands: [
    {
      id: 'lint.fix',
      title: 'Fix All Lint Issues',
      description: 'Run auto-fix across workspace',
      pluginId: 'lint',
      pluginName: 'Lint Suite',
    },
    {
      id: 'lint.check',
      title: 'Check Workspace',
      description: 'Report lint warnings',
      pluginId: 'lint',
      pluginName: 'Lint Suite',
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
  vi.mocked(api.pluginsList).mockResolvedValue({ success: true, plugins: [samplePlugin] })
  vi.mocked(api.pluginsInvoke).mockResolvedValue({ success: true, output: 'fixed' })
  vi.mocked(api.onPluginsChanged).mockReturnValue(() => {})
})

afterEach(() => {
  cleanup()
})

describe('Phase C · Base UI Modal', () => {
  it('renders via portal with data-modal-portal, closes on backdrop click and Escape, and restores focus', () => {
    const Harness = () => {
      const [open, setOpen] = useState(false)
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Launch
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="Inspect" zIndexClass="z-[60]">
            <button type="button">Inside Action</button>
          </Modal>
        </div>
      )
    }

    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Launch' })
    trigger.focus()
    fireEvent.click(trigger)

    const portal = document.body.querySelector('[data-modal-portal="true"]')
    expect(portal).toBeTruthy()
    expect(portal?.parentElement).toBe(document.body)

    const dialog = screen.getByRole('dialog', { name: 'Inspect' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.parentElement?.className).toContain('z-[60]')

    // Clicking backdrop closes modal and restores focus to trigger
    const backdrop = portal?.querySelector('.bg-overlay\\/35') as HTMLElement
    expect(backdrop).toBeTruthy()
    fireEvent.click(backdrop)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    // Reopen and close via Escape on document
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Inspect' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes ONLY the topmost modal on Escape for both React-nested and sibling stacked modals', () => {
    const StackedHarness = () => {
      const [openA, setOpenA] = useState(true)
      const [openB, setOpenB] = useState(false)
      const [openC, setOpenC] = useState(false)
      return (
        <>
          <Modal open={openA} onClose={() => setOpenA(false)} title="Modal A">
            <button type="button" onClick={() => setOpenB(true)}>
              Open Nested B
            </button>
            <Modal open={openB} onClose={() => setOpenB(false)} title="Modal B" zIndexClass="z-50">
              <button type="button" onClick={() => setOpenC(true)}>
                Open Sibling C
              </button>
            </Modal>
          </Modal>
          <Modal open={openC} onClose={() => setOpenC(false)} title="Modal C" zIndexClass="z-[60]">
            <span>Sibling Top C</span>
          </Modal>
        </>
      )
    }

    render(<StackedHarness />)
    expect(screen.getByRole('dialog', { name: 'Modal A' })).toBeTruthy()

    // Open nested Modal B inside Modal A
    fireEvent.click(screen.getByRole('button', { name: 'Open Nested B' }))
    expect(screen.getByRole('dialog', { name: 'Modal B' })).toBeTruthy()

    // Open sibling Modal C on top of Modal B
    fireEvent.click(screen.getByRole('button', { name: 'Open Sibling C' }))
    expect(screen.getByRole('dialog', { name: 'Modal C' })).toBeTruthy()
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(3)

    // First Escape dispatched on popup C closes ONLY Modal C; Modal B becomes active & accessible
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Modal C' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Modal C', hidden: true })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Modal B' })).toBeTruthy()
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2)

    // Second Escape dispatched on document closes ONLY nested Modal B; Modal A becomes active & accessible
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Modal B', hidden: true })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Modal A' })).toBeTruthy()
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1)

    // Third Escape closes Modal A
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull()
  })
})

describe('Phase C · Floating UI PopoverMenu', () => {
  it('opens with role="menu", applies Floating UI positioning & flip, and supports roving keyboard navigation', async () => {
    const onSelectA = vi.fn()
    const onSelectB = vi.fn()
    const onSelectC = vi.fn()

    const MenuHarness = () => {
      const [open, setOpen] = useState(false)
      return (
        <div className="relative" data-testid="anchor-wrap">
          <button type="button" onClick={() => setOpen((value) => !value)}>
            Options
          </button>
          <PopoverMenu open={open} onClose={() => setOpen(false)} label="Actions" placement="up">
            <MenuOption onSelect={onSelectA}>Alpha</MenuOption>
            <MenuOption onSelect={onSelectB}>Beta</MenuOption>
            <MenuOption onSelect={onSelectC}>Gamma</MenuOption>
          </PopoverMenu>
        </div>
      )
    }

    const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    const origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 })

    try {
      render(<MenuHarness />)
      const anchor = screen.getByTestId('anchor-wrap')
      anchor.getBoundingClientRect = () =>
        ({
          x: 20,
          y: 0,
          top: 0,
          left: 20,
          right: 100,
          bottom: 28,
          width: 80,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect

      fireEvent.click(screen.getByRole('button', { name: 'Options' }))
      const menu = screen.getByRole('menu', { name: 'Actions' })
      expect(menu.style.position).toBe('absolute')

      // Floating UI flips top-start -> bottom-start when anchor is flush with top edge
      menu.getBoundingClientRect = () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 160,
          bottom: 120,
          width: 160,
          height: 120,
          toJSON: () => ({}),
        }) as DOMRect
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      await waitFor(() => {
        expect(menu.getAttribute('data-placement')).toBe('bottom-start')
      })

      const alpha = screen.getByRole('menuitemradio', { name: 'Alpha' })
      const beta = screen.getByRole('menuitemradio', { name: 'Beta' })
      const gamma = screen.getByRole('menuitemradio', { name: 'Gamma' })
      expect(document.activeElement).toBe(alpha)

      fireEvent.keyDown(alpha, { key: 'ArrowDown' })
      expect(document.activeElement).toBe(beta)

      fireEvent.keyDown(beta, { key: 'End' })
      expect(document.activeElement).toBe(gamma)

      fireEvent.keyDown(gamma, { key: 'ArrowUp' })
      expect(document.activeElement).toBe(beta)

      fireEvent.keyDown(beta, { key: 'Home' })
      expect(document.activeElement).toBe(alpha)

      // Outside click closes popover
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu', { name: 'Actions' })).toBeNull()
    } finally {
      if (origClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight)
      }
      if (origClientWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', origClientWidth)
      }
    }
  })

  it('closes ONLY PopoverMenu on Escape when nested inside a Base UI Modal', () => {
    const Harness = () => {
      const [modalOpen, setModalOpen] = useState(true)
      const [menuOpen, setMenuOpen] = useState(false)
      return (
        <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Parent Modal">
          <div className="relative">
            <button type="button" onClick={() => setMenuOpen(true)}>
              Open Menu
            </button>
            <PopoverMenu open={menuOpen} onClose={() => setMenuOpen(false)} label="Sub Menu">
              <MenuOption onSelect={() => {}}>First</MenuOption>
            </PopoverMenu>
          </div>
        </Modal>
      )
    }

    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Menu' }))
    expect(screen.getByRole('menu', { name: 'Sub Menu' })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Sub Menu' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Parent Modal' })).toBeTruthy()
  })
})

describe('Phase C · Base UI Tabs primitive', () => {
  it('supports keyboard navigation and panel switching via TabsRoot/TabsList/TabsTab/TabsPanel', async () => {
    expect(Tabs.Root).toBe(TabsRoot)
    expect(Tabs.List).toBe(TabsList)
    expect(Tabs.Tab).toBe(TabsTab)
    expect(Tabs.Panel).toBe(TabsPanel)

    render(
      <TabsRoot defaultValue="general">
        <TabsList aria-label="Settings Sections">
          <TabsTab value="general">General</TabsTab>
          <TabsTab value="models">Models</TabsTab>
          <TabsTab value="about">About</TabsTab>
        </TabsList>
        <TabsPanel value="general">General content</TabsPanel>
        <TabsPanel value="models">Models content</TabsPanel>
        <TabsPanel value="about">About content</TabsPanel>
      </TabsRoot>
    )

    const generalTab = screen.getByRole('tab', { name: 'General' })
    const modelsTab = screen.getByRole('tab', { name: 'Models' })
    const aboutTab = screen.getByRole('tab', { name: 'About' })

    expect(generalTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').textContent).toBe('General content')

    act(() => generalTab.focus())
    fireEvent.keyDown(generalTab, { key: 'ArrowRight' })
    await waitFor(() => expect(document.activeElement).toBe(modelsTab))
    expect(modelsTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').textContent).toBe('Models content')

    fireEvent.keyDown(modelsTab, { key: 'End' })
    await waitFor(() => expect(document.activeElement).toBe(aboutTab))
    expect(aboutTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').textContent).toBe('About content')

    fireEvent.click(generalTab)
    expect(generalTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').textContent).toBe('General content')
  })
})

describe('Phase C · cmdk + Base UI CommandPalette', () => {
  it('exposes combobox, listbox, and option ARIA roles, filters by title/id/pluginName, and runs via Enter', async () => {
    render(<CommandPalette workspacePath="/ws" />)
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true })

    expect(await screen.findByText('Fix All Lint Issues')).toBeTruthy()

    const dialog = screen.getByRole('dialog', { name: translations.zh.commandPalette })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('data-command-palette')).toBe('true')

    const combobox = screen.getByRole('combobox')
    const listbox = screen.getByRole('listbox')
    expect(combobox.getAttribute('aria-controls')).toBe(listbox.id)
    expect(screen.getAllByRole('option').length).toBeGreaterThanOrEqual(2)

    // Filter by pluginName ("Lint Suite")
    fireEvent.change(combobox, { target: { value: 'Lint Suite' } })
    expect(screen.getByText('Fix All Lint Issues')).toBeTruthy()
    expect(screen.getByText('Check Workspace')).toBeTruthy()
    expect(screen.queryByText(translations.zh.attachSelection)).toBeNull()

    // Filter by command id ("lint.check") and execute via Enter
    fireEvent.change(combobox, { target: { value: 'lint.check' } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0].getAttribute('data-selected')).toBe('true')

    fireEvent.keyDown(combobox, { key: 'Enter' })
    await waitFor(() => {
      expect(api.pluginsInvoke).toHaveBeenCalledWith('/ws', 'lint.check', undefined)
    })

    // Filter by title ("Fix All") and navigate/select
    fireEvent.change(combobox, { target: { value: 'Fix All' } })
    expect(screen.getByText('Fix All Lint Issues')).toBeTruthy()
    fireEvent.keyDown(combobox, { key: 'Enter' })
    await waitFor(() => {
      expect(api.pluginsInvoke).toHaveBeenCalledWith('/ws', 'lint.fix', undefined)
    })
  })
})
