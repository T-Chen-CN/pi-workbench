// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsChangedListeners = new Set<(payload: { type: string; path: string }) => void>()
const listDirectoryMock = vi.fn(async () => ({
  success: true,
  items: [{ name: 'index.ts', path: '/ws/index.ts', isDirectory: false }],
}))
const saveSettingsMock = vi.fn(async () => ({ success: true }))
const getSettingsMock = vi.fn(async () => ({ success: true, settings: {} }))
const loadPdfMock = vi.fn()

vi.mock('../../src/api', () => ({
  api: {
    onGitChanged: vi.fn(() => () => {}),
    onGitWorktreeDeps: vi.fn(() => () => {}),
    onAgentSessionRootChanged: vi.fn(() => () => {}),
    editorTabsSet: vi.fn(async () => ({ success: true })),
    listDirectory: (...args: unknown[]) => listDirectoryMock(...(args as [])),
    onFsChanged: vi.fn((cb: (payload: { type: string; path: string }) => void) => {
      fsChangedListeners.add(cb)
      return () => {
        fsChangedListeners.delete(cb)
      }
    }),
    getSettings: () => getSettingsMock(),
    saveSettings: (...args: unknown[]) => saveSettingsMock(...(args as [])),
    openPathExternally: vi.fn(async () => ({ success: true })),
  },
}))

vi.mock('../../src/pdf/loadPdf', () => ({
  loadPdf: (...args: unknown[]) => loadPdfMock(...args),
}))

let chatPanelMountCount = 0
let chatPanelUnmountCount = 0
let lastObservedAssistantText = ''

vi.mock('../../src/components/chat/ChatPanel', () => ({
  ChatPanel: ({ workspacePath }: { workspacePath: string }) => {
    const messages = useChatStore(
      (state) => state.conversations[conversationKey(workspacePath, 's1')]?.messages
    )
    React.useEffect(() => {
      chatPanelMountCount += 1
      return () => {
        chatPanelUnmountCount += 1
      }
    }, [])
    lastObservedAssistantText = messages?.[messages.length - 1]?.content ?? ''
    return <div data-testid={`chat-panel-${workspacePath}`}>{lastObservedAssistantText}</div>
  },
}))
vi.mock('../../src/components/git/GitView', () => ({
  GitView: () => <div data-testid="git-panel" />,
}))
vi.mock('../../src/components/editor/TerminalPanel', () => ({
  TerminalPanel: () => <div data-testid="terminal-panel" />,
}))
vi.mock('../../src/components/editor/DiffViewer', () => ({ DiffViewer: () => null }))
vi.mock('../../src/components/git/CommitDetailView', () => ({ CommitDetailView: () => null }))
vi.mock('../../src/components/editor/FileView', () => ({
  FileView: () => <div data-testid="file-view" />,
}))

import { WorkspaceView } from '../../src/components/workspace/WorkspaceView'
import { FileExplorer } from '../../src/components/files/FileExplorer'
import { PdfReadingView } from '../../src/components/editor/PdfReadingView'
import { conversationKey, useChatStore } from '../../src/store/chatStore'
import {
  DEFAULT_PANEL_WIDTHS,
  useSettingsStore,
} from '../../src/store/settingsStore'
import { usePanelStore } from '../../src/store/panelStore'
import { readThemeTokens } from '../../src/theme/tokens'

beforeEach(() => {
  chatPanelMountCount = 0
  chatPanelUnmountCount = 0
  lastObservedAssistantText = ''
  fsChangedListeners.clear()
  listDirectoryMock.mockClear()
  saveSettingsMock.mockClear()
  getSettingsMock.mockClear()
  loadPdfMock.mockReset()
  useChatStore.getState().reset()
  usePanelStore.setState({ panelHost: {}, windows: {} })
  useSettingsStore.setState({ panelWidths: { ...DEFAULT_PANEL_WIDTHS } })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Phase B Track 2 — Workspace Sleep, Panel Widths, Store Atomicity & Tokens', () => {
  it('hides inactive WorkspaceView via display:none (hidden) while keeping background Agent subscriptions mounted and live', () => {
    const ws = '/ws-bg'
    const key = conversationKey(ws, 's1')
    useChatStore.getState().ensureConversation(key)
    const assistantId = useChatStore.getState().startStreamingMessage(key)

    const { container, rerender } = render(<WorkspaceView workspacePath={ws} active />)
    const root = container.firstElementChild as HTMLElement
    expect(root.className.split(/\s+/)).toContain('flex')
    expect(root.className.split(/\s+/)).not.toContain('hidden')
    expect(chatPanelMountCount).toBe(1)

    // 切到后台工作区：外层改为 hidden（display: none）且不卸载 ChatPanel
    rerender(<WorkspaceView workspacePath={ws} active={false} />)
    expect(root.className.split(/\s+/)).toContain('hidden')
    expect(root.className.split(/\s+/)).not.toContain('flex')
    expect(root.getAttribute('aria-hidden')).toBe('true')
    expect(chatPanelUnmountCount).toBe(0)

    // 后台休眠期间 Agent 流式输出照常送达并更新订阅状态
    act(() => {
      useChatStore.getState().applyTraceEvents(key, assistantId, [
        { type: 'text_delta', delta: 'background stream ok' },
      ])
    })
    expect(lastObservedAssistantText).toBe('background stream ok')
    expect(screen.getByTestId(`chat-panel-${ws}`).textContent).toBe('background stream ok')
  })

  it('hydrates, clamps, and persists panelWidths via settingsStore and WorkspaceView drag', async () => {
    // 越界值会被安全钳制到合法范围
    useSettingsStore.getState().hydrate({
      panelWidths: { sidebar: 9999, chat: 50, terminalHeight: 320 },
    })
    expect(useSettingsStore.getState().panelWidths).toEqual({
      sidebar: 600,
      chat: 260,
      terminalHeight: 320,
    })

    // 恢复正常尺寸后渲染 WorkspaceView，确认初始列宽来自 settingsStore
    useSettingsStore.getState().setPanelWidths({ sidebar: 280, chat: 420, terminalHeight: 240 })
    const { container } = render(<WorkspaceView workspacePath="/ws-widths" active />)
    const asides = container.querySelectorAll('aside')
    expect((asides[0] as HTMLElement).style.width).toBe('280px')

    // 拖拽侧栏分隔线并在 pointerup 持久化
    const separators = container.querySelectorAll('[role="separator"]')
    const sidebarSep = separators[0] as HTMLElement
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    fireEvent.pointerDown(sidebarSep, { clientX: 280 })
    fireEvent.pointerMove(window, { clientX: 320 })
    fireEvent.pointerUp(window)

    await waitFor(() => expect(saveSettingsMock).toHaveBeenCalled())
    expect(useSettingsStore.getState().panelWidths.sidebar).toBe(320)
    expect(saveSettingsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        panelWidths: expect.objectContaining({ sidebar: 320 }),
      })
    )
  })

  it('batches multiple trace events atomically in chatStore.applyTraceEvents and keeps conversations[key] immutable on draft edits', () => {
    const key = conversationKey('/ws-chat', 's1')
    useChatStore.getState().ensureConversation(key)
    const assistantId = useChatStore.getState().startStreamingMessage(key)

    let notifications = 0
    const unsub = useChatStore.subscribe(() => {
      notifications += 1
    })

    useChatStore.getState().applyTraceEvents(key, assistantId, [
      { type: 'thinking_delta', delta: 'step 1 ' },
      { type: 'thinking_delta', delta: 'step 2' },
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'read', argsSummary: 'a.ts', startedAt: 1000 },
      { type: 'tool_update', toolCallId: 'tc1', resultPreview: 'line 1' },
      { type: 'tool_end', toolCallId: 'tc1', toolName: 'read', status: 'success', durationMs: 12 },
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: 'world' },
    ])

    // 7 条 trace 事件合并为 1 次 store 通知
    expect(notifications).toBe(1)
    const msg = useChatStore.getState().conversations[key].messages[0]
    expect(msg.content).toBe('Hello world')
    expect(msg.parts?.map((p) => p.type)).toEqual(['thinking', 'tool', 'text'])
    expect(msg.parts?.[0].type === 'thinking' ? msg.parts[0].text : '').toBe('step 1 step 2')
    expect(msg.parts?.[1].type === 'tool' ? msg.parts[1].status : '').toBe('success')

    // 输入草稿绝不替换 conversations[key] 对象引用，同时保持 draftInputs 与向后兼容读取一致
    const convBefore = useChatStore.getState().conversations[key]
    const convsMapBefore = useChatStore.getState().conversations
    useChatStore.getState().setDraftInput(key, 'typing draft')
    expect(useChatStore.getState().conversations).toBe(convsMapBefore)
    expect(useChatStore.getState().conversations[key]).toBe(convBefore)
    expect(useChatStore.getState().draftInputs[key]).toBe('typing draft')
    expect(useChatStore.getState().conversations[key].draftInput).toBe('typing draft')

    unsub()
  })

  it('reads Paper and Ink theme tokens without touching documentElement.classList', () => {
    const toggleSpy = vi.spyOn(document.documentElement.classList, 'toggle')
    const addSpy = vi.spyOn(document.documentElement.classList, 'add')
    const removeSpy = vi.spyOn(document.documentElement.classList, 'remove')

    document.documentElement.classList.remove('dark')
    removeSpy.mockClear()

    const light = readThemeTokens(false)
    const dark = readThemeTokens(true)

    expect(toggleSpy).not.toHaveBeenCalled()
    expect(addSpy).not.toHaveBeenCalled()
    expect(removeSpy).not.toHaveBeenCalled()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(light.surface).toBe('244 241 234')
    expect(dark.surface).toBe('20 19 17')
    expect(light.accent).toBe('47 93 78')
    expect(dark.accent).toBe('143 199 180')
  })

  it('defers FileExplorer onFsChanged refreshes while inactive and flushes once when reactivated', async () => {
    const { rerender } = render(<FileExplorer workspacePath="/ws" active />)
    await waitFor(() => expect(listDirectoryMock).toHaveBeenCalledTimes(1))

    // 切到后台休眠
    rerender(<FileExplorer workspacePath="/ws" active={false} />)
    act(() => {
      for (const listener of fsChangedListeners) {
        listener({ type: 'rename', path: '/ws/new-file.ts' })
        listener({ type: 'rename', path: '/ws/other-file.ts' })
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 260))
    // 休眠期间绝不发 listDirectory IPC
    expect(listDirectoryMock).toHaveBeenCalledTimes(1)

    // 切回前台：一次性补刷
    rerender(<FileExplorer workspacePath="/ws" active />)
    await waitFor(() => expect(listDirectoryMock).toHaveBeenCalledTimes(2))
  })

  it('configures PdfReadingView IntersectionObserver with scrollRef root and releases canvases when inactive', async () => {
    const observerInstances: Array<{
      options?: IntersectionObserverInit
      callback: IntersectionObserverCallback
      observed: Set<Element>
    }> = []

    class MockIntersectionObserver {
      observed = new Set<Element>()
      callback: IntersectionObserverCallback
      options?: IntersectionObserverInit
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.callback = callback
        this.options = options
        observerInstances.push(this)
      }
      observe(el: Element) {
        this.observed.add(el)
        this.callback(
          [{ target: el, isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver
        )
      }
      unobserve(el: Element) {
        this.observed.delete(el)
      }
      disconnect() {
        this.observed.clear()
      }
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({} as CanvasRenderingContext2D)

    loadPdfMock.mockResolvedValue({
      document: {
        numPages: 1,
        getPage: vi.fn(async () => ({
          getViewport: ({ scale }: { scale: number }) => ({
            width: 600 * scale,
            height: 800 * scale,
          }),
          render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
        })),
      },
      destroy: () => {},
    })

    const file = {
      path: '/ws/doc.pdf',
      name: 'doc.pdf',
      kind: 'pdf' as const,
      view: 'reading' as const,
      content: '',
      isDirty: false,
      isSaving: false,
      version: 1,
    }

    const { container, rerender } = render(<PdfReadingView file={file} active />)
    await waitFor(() => {
      const canvas = container.querySelector('canvas') as HTMLCanvasElement | null
      expect(canvas?.dataset.rendered).toBe('true')
    })

    // IntersectionObserver 的 root 必须是 pdf 滚动容器而非 null
    const scroller = screen.getByTestId('pdf-scroll')
    expect(observerInstances[0]?.options?.root).toBe(scroller)

    const canvas = container.querySelector('canvas') as HTMLCanvasElement
    expect(canvas.width).toBeGreaterThan(0)
    expect(canvas.height).toBeGreaterThan(0)

    // 切到后台：立刻释放 canvas 位图内存
    rerender(<PdfReadingView file={file} active={false} />)
    expect(canvas.width).toBe(0)
    expect(canvas.height).toBe(0)
    expect(canvas.dataset.rendered).toBeUndefined()

    // 切回前台：自动重绘
    rerender(<PdfReadingView file={file} active />)
    await waitFor(() => expect(canvas.dataset.rendered).toBe('true'))
    expect(canvas.width).toBeGreaterThan(0)

    getContextSpy.mockRestore()
    vi.unstubAllGlobals()
  })
})
