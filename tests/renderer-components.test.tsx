// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../src/components/ChatPanel'
import { FileExplorer } from '../src/components/FileExplorer'
import { MonacoEditor } from '../src/components/MonacoEditor'
import { useChatStore } from '../src/store/chatStore'
import { useEditorStore } from '../src/store/editorStore'
import { useI18nStore } from '../src/store/i18nStore'
import { translations } from '../src/i18n/translations'
import { api } from '../src/api'
import { piAgentAPI } from '../src/api/piAgentAPI'
import type { ApiConfig } from '../src/types/electron'

vi.mock('../src/api', () => ({
  api: {
    apiConfigGet: vi.fn(),
    readFile: vi.fn(),
    listDirectory: vi.fn(),
    writeFile: vi.fn(),
    deletePath: vi.fn(),
    renamePath: vi.fn(),
    exists: vi.fn(),
    stat: vi.fn(),
    onFsChanged: vi.fn(() => () => {}),
  },
}))

vi.mock('../src/api/piAgentAPI', () => ({
  piAgentAPI: {
    initialize: vi.fn(),
    getHistory: vi.fn(),
    chat: vi.fn(),
    abort: vi.fn(),
    dispose: vi.fn(),
    isInitialized: vi.fn(),
  },
}))

vi.mock('monaco-editor', () => {
  const createModel = (initialValue: string) => {
    let value = initialValue
    return {
      getValue: () => value,
      setValue: (next: string) => {
        value = next
      },
      dispose: () => {},
    }
  }
  return {
    Uri: {
      file: (filePath: string) => ({ path: filePath, toString: () => `file://${filePath}` }),
    },
    editor: {
      create: () => {
        let model = createModel('')
        return {
          getModel: () => model,
          setModel: (next: typeof model) => {
            model = next
          },
          getValue: () => model.getValue(),
          setValue: (next: string) => model.setValue(next),
          saveViewState: () => null,
          restoreViewState: () => {},
          onDidChangeModelContent: () => ({ dispose: () => {} }),
          layout: () => {},
          dispose: () => {},
        }
      },
      getModel: () => null,
      setModelLanguage: vi.fn(),
      setTheme: vi.fn(),
      defineTheme: vi.fn(),
      createModel: vi.fn((value: string) => createModel(value)),
    },
  }
})

const configWithKey: ApiConfig = {
  provider: 'anthropic',
  apiUrl: 'https://example.test/v1',
  apiKey: 'test-key',
  availableModels: ['test-model'],
  selectedModel: 'test-model',
}

beforeEach(() => {
  useChatStore.getState().reset()
  useEditorStore.getState().reset()
  useI18nStore.getState().setLanguage('zh')
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
  vi.mocked(piAgentAPI.initialize).mockResolvedValue({ success: true })
  vi.mocked(piAgentAPI.getHistory).mockResolvedValue({ success: true, history: [] })
  vi.mocked(piAgentAPI.isInitialized).mockResolvedValue({ success: true, initialized: false })
  vi.mocked(api.stat).mockResolvedValue({ success: true, isFile: true, isDirectory: false, size: 0 })
  vi.mocked(api.onFsChanged).mockReturnValue(() => {})
})

afterEach(() => {
  cleanup()
})

describe('ChatPanel', () => {
  it('leaves the API key prompt after a configuration is saved', async () => {
    vi.mocked(api.apiConfigGet).mockResolvedValue({
      success: true,
      config: { ...configWithKey, apiKey: '' },
    })

    render(<ChatPanel workspacePath="/ws" />)
    await screen.findByText(translations.zh.apiConfigRequired)

    vi.mocked(api.apiConfigGet).mockResolvedValue({
      success: true,
      config: configWithKey,
    })

    act(() => {
      window.dispatchEvent(new CustomEvent('api-config-saved'))
    })

    await waitFor(() => {
      expect(screen.queryByText(translations.zh.apiConfigRequired)).toBeNull()
    })
    expect(screen.getByText(new RegExp(translations.zh.agentChatTitle))).toBeTruthy()
  })

  it('renders assistant markdown with highlighted code blocks', async () => {
    vi.mocked(api.apiConfigGet).mockResolvedValue({
      success: true,
      config: configWithKey,
    })
    vi.mocked(piAgentAPI.getHistory).mockResolvedValue({
      success: true,
      history: [
        {
          role: 'assistant',
          content: 'Example:\n\n```ts\nconst answer = 42\n```',
          timestamp: Date.now(),
        },
      ],
    })

    render(<ChatPanel workspacePath="/ws" />)

    await waitFor(() => {
      const code = document.querySelector('.chat-markdown pre code')
      expect(code?.textContent).toContain('const answer = 42')
    })
    expect(screen.getByLabelText(translations.zh.copyCode)).toBeTruthy()
  })
})

describe('FileExplorer', () => {
  it('opens a file whose content is an empty string', async () => {
    vi.mocked(api.listDirectory).mockResolvedValue({
      success: true,
      items: [{ name: 'empty.txt', path: '/ws/empty.txt', isDirectory: false }],
    })
    vi.mocked(api.readFile).mockResolvedValue({ success: true, content: '' })

    render(<FileExplorer workspacePath="/ws" />)
    const fileLabel = await screen.findByText('empty.txt')
    fireEvent.click(fileLabel)

    await waitFor(() => {
      expect(
        useEditorStore.getState().openFiles.some((file) => file.path === '/ws/empty.txt')
      ).toBe(true)
    })
    expect(useEditorStore.getState().currentFile?.content).toBe('')
  })
})

describe('MonacoEditor', () => {
  it('syncs external changes for files open in background tabs', async () => {
    let fsChanged: ((payload: { type: string; path: string }) => void) | null = null
    vi.mocked(api.onFsChanged).mockImplementation((callback) => {
      fsChanged = callback
      return () => {}
    })
    vi.mocked(api.exists).mockResolvedValue({ success: true, exists: true })
    vi.mocked(api.readFile).mockResolvedValue({ success: true, content: 'updated-a' })

    render(<MonacoEditor />)
    act(() => {
      useEditorStore.getState().addOpenFile({
        path: '/ws/a.ts',
        name: 'a.ts',
        content: 'old-a',
        isDirty: false,
        isSaving: false,
      })
      useEditorStore.getState().addOpenFile({
        path: '/ws/b.ts',
        name: 'b.ts',
        content: 'b',
        isDirty: false,
        isSaving: false,
      })
    })

    // 当前文件是 b.ts，外部修改的是后台标签页 a.ts
    act(() => {
      fsChanged?.({ type: 'change', path: '/ws/a.ts' })
    })

    await waitFor(() => {
      const file = useEditorStore.getState().openFiles.find((item) => item.path === '/ws/a.ts')
      expect(file?.content).toBe('updated-a')
    })
  })
})
