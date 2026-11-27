// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '../../src/components/ui/ui'
import { CardHeader, Tab } from '../../src/components/ui/patterns'
import { PanelWindowFrame } from '../../src/components/panels/PanelWindowFrame'
import { HtmlPreview } from '../../src/components/editor/HtmlPreview'
import { RepoMapCanvas, type RepoMapCanvasHandle } from '../../src/components/repo-map/RepoMapCanvas'
import { buildCanvasTree, chainLayout, topLevelLayout } from '../../src/utils/repoMapLayout'
import { conversationKey, useChatStore } from '../../src/store/chatStore'
import { useI18nStore } from '../../src/store/i18nStore'
import { WorkspaceScopeProvider } from '../../src/workspace/WorkspaceScope'
import type { OpenFile } from '../../src/types'
import type { RepoMapCanvasState, RepoMapFile } from '../../src/types/electron'

const canvasGet = vi.fn()
const canvasSet = vi.fn()

vi.mock('../../src/api', () => ({
  api: {
    repoMapScan: vi.fn(),
    repoMapDescribe: vi.fn(),
    repoMapCanvasGet: (workspaceDir: string) => canvasGet(workspaceDir),
    repoMapCanvasSet: (workspaceDir: string, state: unknown) => canvasSet(workspaceDir, state),
    onGitChanged: vi.fn(() => () => {}),
    openPathExternally: vi.fn(async () => ({ success: true })),
  },
}))

const emptyCanvas = (): RepoMapCanvasState => ({
  version: 1,
  layoutVersion: 4,
  zoom: 1,
  pan: { x: 0, y: 0 },
  folders: {},
  files: {},
})

const repoFile = (path: string, headComment?: string): RepoMapFile => ({
  path,
  role: 'util',
  binary: false,
  size: 100,
  mtimeMs: 1,
  described: true,
  ...(headComment ? { headComment } : {}),
})

beforeEach(() => {
  useI18nStore.getState().setLanguage('zh')
  useChatStore.getState().reset()
  canvasGet.mockReset()
  canvasSet.mockReset()
  canvasGet.mockResolvedValue({ success: true, state: emptyCanvas() })
  canvasSet.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('Phase 2 Milestone 5 — Titlebar, A11y, RepoMapCanvas & UI Perf', () => {
  it('renders Modal via portal to document.body and toggles inert on background siblings', () => {
    const onClose = vi.fn()
    const { container, rerender } = render(
      <div>
        <button type="button">background action</button>
        <Modal open onClose={onClose} title="Settings">
          <button type="button">inside button</button>
        </Modal>
      </div>
    )

    const portal = document.body.querySelector('[data-modal-portal="true"]')
    expect(portal).toBeTruthy()
    expect(portal?.parentElement).toBe(document.body)
    expect(container.hasAttribute('inert')).toBe(true)

    rerender(
      <div>
        <button type="button">background action</button>
        <Modal open={false} onClose={onClose} title="Settings">
          <button type="button">inside button</button>
        </Modal>
      </div>
    )
    expect(container.hasAttribute('inert')).toBe(false)
  })

  it('renders both status and action in CardHeader instead of swallowing action', () => {
    render(
      <CardHeader
        title="Model"
        status={<span>Ready</span>}
        action={<button type="button">Refresh</button>}
      />
    )
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
  })

  it('keeps Tab close button as a sibling outside role="tab" (no nested-interactive)', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <div role="tablist">
        <Tab active label="index.ts" onSelect={onSelect} onClose={onClose} closeLabel="Close tab" />
      </div>
    )
    const tab = screen.getByRole('tab')
    const closeBtn = screen.getByRole('button', { name: 'Close tab' })
    expect(tab.contains(closeBtn)).toBe(false)

    fireEvent.click(tab)
    expect(onSelect).toHaveBeenCalledTimes(1)
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('hides duplicate custom WindowControls in PanelWindowFrame when nativeTitleBarOverlay is enabled', () => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      platform: 'win32',
      nativeTitleBarOverlay: true,
      auxWindowCommand: vi.fn(),
      auxWindowState: vi.fn(async () => ({ success: true, maximized: false })),
      onWindowMaximizedChange: vi.fn(() => () => {}),
    }
    const { container } = render(
      <WorkspaceScopeProvider value="/ws">
        <PanelWindowFrame panel="files" workspacePath="/ws" host="aux:1">
          <div>body</div>
        </PanelWindowFrame>
      </WorkspaceScopeProvider>
    )
    expect(screen.getByRole('button', { name: '还原到主窗口' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull()
    expect(container.querySelector('.app-drag')?.className).toContain('pr-[140px]')
  })

  it('supports multi-hit search prev/next, breadcrumb collapseToDepth, and expanded Space exclusions in RepoMapCanvas', async () => {
    const files: RepoMapFile[] = [
      repoFile('README.md', 'Overview'),
      repoFile('src/alpha.ts', 'Alpha helper'),
      repoFile('src/nested/beta.ts', 'Beta helper'),
    ]
    const handleRef = React.createRef<RepoMapCanvasHandle>()
    const onMatchInfo = vi.fn()
    const onChainChange = vi.fn()

    render(
      <div>
        <details>
          <summary data-testid="outside-summary">Details</summary>
        </details>
        <RepoMapCanvas
          ref={handleRef}
          workspacePath="/ws"
          files={files}
          query="helper"
          onOpenFile={vi.fn()}
          onEnsureDescribed={vi.fn()}
          onMatchInfo={onMatchInfo}
          onChainChange={onChainChange}
        />
      </div>
    )

    await waitFor(() => expect(onMatchInfo).toHaveBeenLastCalledWith({ total: 2, index: 0 }))
    await waitFor(() => expect(onChainChange).toHaveBeenLastCalledWith(['src']))

    act(() => {
      handleRef.current?.nextMatch()
    })
    await waitFor(() => expect(onMatchInfo).toHaveBeenLastCalledWith({ total: 2, index: 1 }))
    await waitFor(() => expect(onChainChange).toHaveBeenLastCalledWith(['src', 'src/nested']))

    act(() => {
      handleRef.current?.collapseToDepth(1)
    })
    await waitFor(() => expect(onChainChange).toHaveBeenLastCalledWith(['src']))

    act(() => {
      handleRef.current?.collapseToDepth(0)
    })
    await waitFor(() => expect(onChainChange).toHaveBeenLastCalledWith([]))

    // Outside <summary> should NOT be hijacked by global Space hand-tool
    const summary = screen.getByTestId('outside-summary')
    fireEvent.keyDown(summary, { code: 'Space' })
    expect(screen.getByTestId('repo-map-canvas').dataset.space).toBe('false')
  })

  it('culls offscreen cards in RepoMapCanvas when viewport has real dimensions', async () => {
    const files: RepoMapFile[] = [repoFile('a.ts'), repoFile('b.ts')]
    const state: RepoMapCanvasState = {
      ...emptyCanvas(),
      files: {
        'a.ts': { x: 20, y: 20 },
        'b.ts': { x: 5000, y: 5000 },
      },
    }
    canvasGet.mockResolvedValue({ success: true, state })

    const origWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    const origHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 })
    try {
      render(
        <RepoMapCanvas
          workspacePath="/ws"
          files={files}
          query=""
          onOpenFile={vi.fn()}
          onEnsureDescribed={vi.fn()}
        />
      )
      await waitFor(() => {
        const paths = screen.getAllByTestId('repo-map-card').map((n) => n.dataset.path)
        expect(paths).toContain('a.ts')
        expect(paths).not.toContain('b.ts')
      })
    } finally {
      if (origWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', origWidth)
      if (origHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origHeight)
    }
  })

  it('deduplicates chainLayout nodes in O(N) without duplicates', () => {
    const files = Array.from({ length: 120 }, (_, i) => repoFile(`src/mod/file-${i}.ts`))
    const tree = buildCanvasTree(files)
    const base = topLevelLayout(tree, { folders: {}, files: {} })
    const result = chainLayout(tree, base.positions, ['src', 'src/mod'])
    expect(result.nodes.length).toBe(122)
  })

  it('waits until draft is flushed (isDirty=false) before reloading HtmlPreview iframe', async () => {
    vi.useFakeTimers()
    try {
      const baseFile: OpenFile = {
        path: '/ws/demo.html',
        name: 'demo.html',
        content: '<h1>v1</h1>',
        kind: 'html',
        view: 'reading',
        isDirty: false,
        isSaving: false,
        version: 1,
      }
      const { rerender, container } = render(<HtmlPreview file={baseFile} visible />)
      const initialSrc = container.querySelector('iframe')?.getAttribute('src')

      // Editing in memory (isDirty=true) should NOT reload disk iframe
      rerender(<HtmlPreview file={{ ...baseFile, content: '<h1>v2</h1>', isDirty: true }} visible />)
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(container.querySelector('iframe')?.getAttribute('src')).toBe(initialSrc)

      // Once autosave flushes to disk (isDirty=false), iframe reloads cleanly
      rerender(<HtmlPreview file={{ ...baseFile, content: '<h1>v2</h1>', isDirty: false }} visible />)
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(container.querySelector('iframe')?.getAttribute('src')).not.toBe(initialSrc)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tracks busyCountByWorkspace incrementally in O(1) inside chatStore', () => {
    const key1 = conversationKey('/ws-a', 's1')
    const key2 = conversationKey('/ws-a', 's2')
    const store = useChatStore.getState()
    store.ensureConversation(key1)
    store.ensureConversation(key2)

    store.setLoading(key1, true)
    expect(useChatStore.getState().busyCountByWorkspace['/ws-a']).toBe(1)

    store.setCompacting(key1, true)
    // Same conversation both loading + compacting still counts as 1 busy conversation
    expect(useChatStore.getState().busyCountByWorkspace['/ws-a']).toBe(1)

    store.setLoading(key2, true)
    expect(useChatStore.getState().busyCountByWorkspace['/ws-a']).toBe(2)

    store.setLoading(key1, false)
    expect(useChatStore.getState().busyCountByWorkspace['/ws-a']).toBe(2)

    store.setCompacting(key1, false)
    expect(useChatStore.getState().busyCountByWorkspace['/ws-a']).toBe(1)

    store.removeConversation(key2)
    expect(useChatStore.getState().busyCountByWorkspace['/ws-a']).toBeUndefined()
  })
})
