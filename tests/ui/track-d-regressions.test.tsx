// @vitest-environment jsdom
import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileExplorer } from '../../src/components/files/FileExplorer'
import { ChatPanel } from '../../src/components/chat/ChatPanel'
import { Modal, PopoverMenu, MenuOption } from '../../src/components/ui/ui'
import { ToastContainer } from '../../src/components/ui/Toast'
import { editorStoreFor, resetEditorStores } from '../../src/store/editorStore'
import { useChatStore, conversationKey } from '../../src/store/chatStore'
import { useSessionStore } from '../../src/store/sessionStore'
import { useToastStore } from '../../src/store/toastStore'
import { useI18nStore } from '../../src/store/i18nStore'
import { translations } from '../../src/i18n/translations'
import { api } from '../../src/api'
import { piAgentAPI } from '../../src/api/piAgentAPI'
import { confirmDialog, promptDialog } from '../../src/store/dialogStore'
import type { ProvidersListResult, SessionSummary } from '../../src/types/electron'

vi.mock('../../src/api', () => ({
  api: {
    listDirectory: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    createFile: vi.fn(),
    deletePath: vi.fn(),
    renamePath: vi.fn(),
    exists: vi.fn(),
    stat: vi.fn(),
    onFsChanged: vi.fn(() => () => {}),
    providersList: vi.fn(),
    searchWorkspaceFiles: vi.fn(async () => ({ success: true, files: [] })),
    getSessionMeta: vi.fn(async () => ({ success: true, meta: { pinned: [], archived: [] } })),
    setSessionMeta: vi.fn(async () => ({ success: true })),
  },
}))

vi.mock('../../src/api/piAgentAPI', () => ({
  piAgentAPI: {
    initialize: vi.fn(),
    chat: vi.fn(),
    abort: vi.fn(),
    onSessionTitle: vi.fn(() => () => {}),
    sessionsList: vi.fn(),
    sessionsOpen: vi.fn(),
    sessionsCreate: vi.fn(),
    sessionsClose: vi.fn(),
    sessionsRename: vi.fn(),
    sessionsDelete: vi.fn(),
    sessionsGetTabs: vi.fn(),
    sessionsSetTabs: vi.fn(),
    steer: vi.fn(),
    getContextUsage: vi.fn(),
    compactContext: vi.fn(),
    getSessionSettings: vi.fn(),
    setSessionPermission: vi.fn(),
    getSessionStats: vi.fn(),
    getModelCapabilities: vi.fn(),
    listPromptResources: vi.fn(),
    getPlan: vi.fn(),
    listBranches: vi.fn(),
    switchBranch: vi.fn(),
    respondApproval: vi.fn(),
  },
}))

vi.mock('../../src/store/dialogStore', () => ({
  confirmDialog: vi.fn(async () => true),
  promptDialog: vi.fn(async () => null),
}))

const session1: SessionSummary = {
  id: 's1',
  title: 'Session 1',
  messageCount: 0,
  createdAt: 1,
  updatedAt: 2,
}

const providersOk: ProvidersListResult = {
  success: true,
  activeProvider: 'deepseek',
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      connected: true,
      credentialType: 'api_key',
      authMethods: ['api_key'],
      active: true,
      model: 'test-model',
      models: [
        {
          id: 'test-model',
          name: 'Test Model',
          limits: { contextWindow: 128_000, maxTokens: 16_384 },
          reasoning: true,
          vision: false,
          api: 'openai-completions',
          thinkingLevels: ['low', 'medium', 'high'],
          input: ['text'],
        },
      ],
    },
  ],
}

beforeEach(() => {
  resetEditorStores()
  useChatStore.getState().reset()
  useSessionStore.getState().reset()
  useToastStore.setState({ messages: [] })
  useI18nStore.getState().setLanguage('zh')
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn()

  vi.mocked(api.providersList).mockResolvedValue(providersOk)
  vi.mocked(api.exists).mockResolvedValue({ success: true, exists: false })
  vi.mocked(api.stat).mockResolvedValue({ success: true, isFile: true, isDirectory: false, size: 0 })
  vi.mocked(api.onFsChanged).mockReturnValue(() => {})
  vi.mocked(piAgentAPI.initialize).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.abort).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.sessionsList).mockResolvedValue({
    success: true,
    sessions: [session1],
    currentId: 's1',
  })
  vi.mocked(piAgentAPI.sessionsGetTabs).mockResolvedValue({
    success: true,
    tabs: { open: ['s1'], active: 's1' },
  })
  vi.mocked(piAgentAPI.sessionsOpen).mockResolvedValue({
    success: true,
    session: session1,
    history: [],
  })
  vi.mocked(piAgentAPI.sessionsSetTabs).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.getContextUsage).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.getSessionSettings).mockResolvedValue({
    success: true,
    modelId: 'test-model',
    thinkingLevel: 'medium',
    permission: { mode: 'ask', grants: [] },
  })
  vi.mocked(piAgentAPI.getSessionStats).mockResolvedValue({
    success: true,
    stats: { tokens: 0, input: 0, output: 0, cost: 0, toolCalls: 0, messages: 0 },
  })
  vi.mocked(piAgentAPI.getModelCapabilities).mockResolvedValue({ success: true, models: [] })
  vi.mocked(piAgentAPI.listPromptResources).mockResolvedValue({
    success: true,
    templates: [],
    skills: [],
  })
  vi.mocked(piAgentAPI.getPlan).mockResolvedValue({ success: true, plan: null })
  vi.mocked(piAgentAPI.listBranches).mockResolvedValue({ success: true, groups: [] })
  vi.mocked(piAgentAPI.onSessionTitle).mockReturnValue(() => {})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('FileExplorer createFile & directory tab cleanup', () => {
  it('uses api.createFile and shows localized error when file already exists (never calls writeFile)', async () => {
    vi.mocked(api.listDirectory).mockResolvedValue({ success: true, items: [] })
    vi.mocked(api.createFile).mockResolvedValue({
      success: false,
      code: 'EEXIST',
      error: 'File already exists',
    })

    render(<FileExplorer workspacePath="/ws" />)
    fireEvent.click(await screen.findByRole('button', { name: translations.zh.createNewFile }))

    const input = await screen.findByPlaceholderText(translations.zh.fileName)
    fireEvent.change(input, { target: { value: 'existing.ts' } })
    fireEvent.click(screen.getByRole('button', { name: translations.zh.create }))

    await waitFor(() => {
      expect(api.createFile).toHaveBeenCalledWith('/ws/existing.ts')
    })
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(useToastStore.getState().messages.some((m) => m.message.includes('文件已存在'))).toBe(true)
  })

  it('closes all nested open editor tabs when deleting or renaming a directory', async () => {
    const ws = 'C:\\ws'
    vi.mocked(api.listDirectory).mockResolvedValue({
      success: true,
      items: [
        { name: 'src', path: 'C:\\ws\\src', isDirectory: true },
        { name: 'src-other', path: 'C:\\ws\\src-other', isDirectory: true },
      ],
    })
    vi.mocked(api.deletePath).mockResolvedValue({ success: true })
    vi.mocked(api.renamePath).mockResolvedValue({ success: true })

    const store = editorStoreFor(ws).getState()
    store.addOpenFile({
      path: 'c:/ws/src/a.ts',
      name: 'a.ts',
      content: 'a',
      isDirty: false,
      isSaving: false,
    })
    store.addOpenFile({
      path: 'C:\\ws\\src\\nested\\b.ts',
      name: 'b.ts',
      content: 'b',
      isDirty: false,
      isSaving: false,
    })
    store.addOpenFile({
      path: 'C:\\ws\\src-other\\keep.ts',
      name: 'keep.ts',
      content: 'keep',
      isDirty: false,
      isSaving: false,
    })

    render(<FileExplorer workspacePath={ws} />)
    const srcFolder = await screen.findByText('src')
    fireEvent.contextMenu(srcFolder)
    vi.mocked(confirmDialog).mockResolvedValueOnce(true)
    fireEvent.click(await screen.findByRole('menuitem', { name: translations.zh.delete }))

    await waitFor(() => {
      expect(editorStoreFor(ws).getState().openFiles.map((f) => f.path)).toEqual([
        'C:\\ws\\src-other\\keep.ts',
      ])
    })

    // 重命名目录同样关闭该目录下全部已打开标签
    editorStoreFor(ws).getState().addOpenFile({
      path: 'C:\\ws\\src-other\\deep\\c.ts',
      name: 'c.ts',
      content: 'c',
      isDirty: false,
      isSaving: false,
    })
    vi.mocked(promptDialog).mockResolvedValueOnce('src-renamed')
    fireEvent.contextMenu(screen.getByText('src-other'))
    fireEvent.click(await screen.findByRole('menuitem', { name: translations.zh.rename }))

    await waitFor(() => {
      expect(editorStoreFor(ws).getState().openFiles).toEqual([])
    })
  })
})

describe('ChatPanel detach/dock mid-stream turn control', () => {
  it('preserves Stop control and live open tabs across ChatPanel unmount/remount', async () => {
    let resolveChat: ((value: { success: boolean; error?: string }) => void) | null = null
    vi.mocked(piAgentAPI.chat).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveChat = resolve
        })
    )

    const { rerender } = render(<ChatPanel key="main" workspacePath="/ws" />)
    const textarea = await screen.findByPlaceholderText(translations.zh.inputPlaceholder)
    await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false))

    fireEvent.change(textarea, { target: { value: 'first prompt' } })
    fireEvent.click(screen.getByRole('button', { name: translations.zh.send }))
    await waitFor(() => expect(piAgentAPI.chat).toHaveBeenCalledTimes(1))

    // 排队一条消息，同时在内存中打开第二个会话标签（磁盘 sessionsGetTabs 仍是旧的 ['s1']）
    const key = conversationKey('/ws', 's1')
    act(() => {
      useChatStore.getState().addPending(key, 'queued prompt')
      useSessionStore.getState().setOpen('/ws', ['s1', 's2'], 's1')
    })

    expect(piAgentAPI.initialize).toHaveBeenCalledTimes(1)

    // 模拟 PanelSlot 以 key={host} 拆窗重挂 ChatPanel
    rerender(<ChatPanel key="aux:1" workspacePath="/ws" />)

    // 重挂不重复初始化、也不拿旧磁盘标签覆盖实时内存标签
    expect(piAgentAPI.initialize).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().byWorkspace['/ws'].open).toEqual(['s1', 's2'])

    // 在新实例上点击「停止」
    const stopBtn = await screen.findByRole('button', { name: translations.zh.stop })
    fireEvent.click(stopBtn)
    await waitFor(() => expect(piAgentAPI.abort).toHaveBeenCalledWith('/ws', 's1'))

    // 旧实例飞行中的 chat() 因中止返回失败：必须识别为已停止，不标错也不派发排队消息
    await act(async () => {
      resolveChat?.({ success: false, error: 'Aborted' })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(useChatStore.getState().conversations[key].error).toBeNull()
    expect(useSessionStore.getState().errors[key]).toBeUndefined()
    expect(piAgentAPI.chat).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().conversations[key].pending).toHaveLength(1)
  })

  it('dispatches a queued turn through the remounted ChatPanel when the previous turn completes after detach', async () => {
    let resolveFirst: ((value: { success: boolean; response?: string }) => void) | null = null
    vi.mocked(piAgentAPI.chat)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce({ success: true, response: 'second done' })

    const { rerender } = render(<ChatPanel key="main" workspacePath="/ws" />)
    const textarea = await screen.findByPlaceholderText(translations.zh.inputPlaceholder)
    await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false))

    fireEvent.change(textarea, { target: { value: 'first turn' } })
    fireEvent.click(screen.getByRole('button', { name: translations.zh.send }))
    await waitFor(() => expect(piAgentAPI.chat).toHaveBeenCalledTimes(1))

    const key = conversationKey('/ws', 's1')
    act(() => {
      useChatStore.getState().addPending(key, 'second queued turn')
    })

    // 拆窗重挂
    rerender(<ChatPanel key="aux:2" workspacePath="/ws" />)

    // 第一轮正常完成：排队消息经由新实例的 live submit 发出
    await act(async () => {
      resolveFirst?.({ success: true, response: 'first done' })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    await waitFor(() => expect(piAgentAPI.chat).toHaveBeenCalledTimes(2))
    expect(vi.mocked(piAgentAPI.chat).mock.calls[1][0]).toBe('second queued turn')
  })
})

describe('Modal, PopoverMenu, and Toast interaction regressions', () => {
  it('captures previousFocus before applying inert and restores focus when Modal closes', () => {
    const ModalHarness = () => {
      const [open, setOpen] = useState(false)
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Open Modal
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="Settings">
            <button type="button" onClick={() => setOpen(false)}>
              Done
            </button>
          </Modal>
        </div>
      )
    }

    // 模拟真实浏览器：容器被标上 inert 时立即 blur 其中的焦点元素
    const origSetAttr = Element.prototype.setAttribute
    const setAttrSpy = vi
      .spyOn(Element.prototype, 'setAttribute')
      .mockImplementation(function (this: Element, name: string, value: string) {
        origSetAttr.call(this, name, value)
        if (name === 'inert' && document.activeElement && this.contains(document.activeElement)) {
          ;(document.activeElement as HTMLElement).blur()
        }
      })

    try {
      render(<ModalHarness />)
      const trigger = screen.getByRole('button', { name: 'Open Modal' })
      trigger.focus()
      expect(document.activeElement).toBe(trigger)

      fireEvent.click(trigger)
      expect(screen.getByRole('dialog')).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    } finally {
      setAttrSpy.mockRestore()
    }
  })

  it('closes only PopoverMenu on Escape inside a Modal and does not steal focus on parent re-render', () => {
    const NestedHarness: React.FC<{ tick: number }> = ({ tick }) => {
      const [modalOpen, setModalOpen] = useState(true)
      const [menuOpen, setMenuOpen] = useState(false)
      return (
        <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={`Outer ${tick}`}>
          <div className="relative">
            <button type="button" onClick={() => setMenuOpen(true)}>
              Open Menu
            </button>
            <PopoverMenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              label="Inner Menu"
              role="dialog"
            >
              <input aria-label="Filter inside menu" />
              <MenuOption onSelect={() => {}}>Option A</MenuOption>
            </PopoverMenu>
          </div>
        </Modal>
      )
    }

    const { rerender } = render(<NestedHarness tick={0} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Menu' }))
    const input = screen.getByLabelText('Filter inside menu')
    input.focus()
    expect(document.activeElement).toBe(input)

    // 父组件重渲染产生新内联 onClose 引用时，不得重跑焦点 effect 把焦点从输入框抢走
    rerender(<NestedHarness tick={1} />)
    expect(document.activeElement).toBe(input)

    // 在 PopoverMenu 打开时按 Escape：只关闭 PopoverMenu，外层 Modal 必须保持打开
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Inner Menu' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Outer 1' })).toBeTruthy()
  })

  it('fires Toast onClose strictly once and keeps ToastContainer outside Modal inert', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const message = { id: 't1', message: 'Saved', type: 'success' as const, duration: 1000 }

    const { rerender } = render(
      <div>
        <Modal open onClose={() => {}} title="Active Modal">
          <span>body</span>
        </Modal>
        <ToastContainer messages={[message]} onClose={(id) => onClose(id)} />
      </div>
    )

    // ToastContainer 通过独立 portal 渲染在 body 上，不被 Modal 标为 inert
    const toastPortal = document.body.querySelector('[data-toast-portal="true"]')
    expect(toastPortal).toBeTruthy()
    expect(toastPortal?.parentElement).toBe(document.body)
    expect(toastPortal?.hasAttribute('inert')).toBe(false)

    // 父组件传入新的内联 onClose 不重置计时器；点击关闭后自动关闭也不得重复触发 onClose
    rerender(
      <div>
        <Modal open onClose={() => {}} title="Active Modal">
          <span>body</span>
        </Modal>
        <ToastContainer messages={[message]} onClose={(id) => onClose(id)} />
      </div>
    )

    const closeBtn = screen.getAllByRole('button', { name: translations.zh.close }).pop()!
    fireEvent.click(closeBtn)
    fireEvent.click(closeBtn)

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith('t1')
  })
})
