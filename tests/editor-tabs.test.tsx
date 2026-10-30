// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorTabs } from '../src/components/EditorTabs'
import { editorStoreFor, resetEditorStores } from '../src/store/editorStore'
import { useI18nStore } from '../src/store/i18nStore'
import { translations } from '../src/i18n/translations'

vi.mock('../src/api', () => ({
  api: {
    draftDelete: vi.fn(async () => ({ success: true })),
  },
}))

const zh = translations.zh

const openFile = (path: string, name: string) => {
  act(() => {
    editorStoreFor('/ws').getState().addOpenFile({
      path,
      name,
      content: '',
      isDirty: false,
      isSaving: false,
    })
  })
}

/** 面板标签的可访问名就是它的文案，文件标签是文件名：用文案精确命中前者 */
const panelTab = () => screen.getByRole('tab', { name: zh.panelTab })

beforeEach(() => {
  resetEditorStores()
  useI18nStore.getState().setLanguage('zh')
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('面板标签', () => {
  it('没有打开任何文件时标签条仍然存在，且只有面板标签', () => {
    render(<EditorTabs workspacePath="/ws" root="/ws" />)

    expect(screen.getByTestId('editor-tabs')).toBeTruthy()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(1)
    expect(tabs[0].getAttribute('aria-label')).toBe(zh.panelTab)
  })

  it('始终在左端第一位，文件标签排在它后面', () => {
    openFile('/ws/a.ts', 'a.ts')
    openFile('/ws/b.ts', 'b.ts')
    render(<EditorTabs workspacePath="/ws" root="/ws" />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs[0].getAttribute('aria-label')).toBe(zh.panelTab)
    expect(tabs[1].getAttribute('aria-label')).toMatch(/a\.ts/)
  })

  it('不可关闭：没有 × 按钮，中键也不关闭', async () => {
    openFile('/ws/a.ts', 'a.ts')
    render(<EditorTabs workspacePath="/ws" root="/ws" />)

    // 唯一一个关闭按钮属于文件标签
    expect(screen.getAllByLabelText(zh.close)).toHaveLength(1)
    expect(panelTab().querySelector('button')).toBeNull()

    fireEvent(panelTab(), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })

  it('点面板标签切到面板，点文件标签切回文件视图', () => {
    openFile('/ws/a.ts', 'a.ts')
    render(<EditorTabs workspacePath="/ws" root="/ws" />)

    const store = editorStoreFor('/ws')
    act(() => store.getState().setPanelActive(false))
    expect(panelTab().getAttribute('aria-selected')).toBe('false')

    fireEvent.click(panelTab())
    expect(store.getState().panelActive).toBe(true)
    expect(panelTab().getAttribute('aria-selected')).toBe('true')
    // 面板激活时没有文件标签高亮：上次的文件仍记着，点一下就回去
    expect(screen.getByRole('tab', { name: /a\.ts/ }).getAttribute('aria-selected')).toBe(
      'false'
    )

    fireEvent.click(screen.getByRole('tab', { name: /a\.ts/ }))
    expect(store.getState().panelActive).toBe(false)
    expect(store.getState().currentFile?.path).toBe('/ws/a.ts')
    expect(screen.getByRole('tab', { name: /a\.ts/ }).getAttribute('aria-selected')).toBe('true')
  })
})
