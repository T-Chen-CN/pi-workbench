// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tab } from '../src/components/patterns'
import { EditorTabs } from '../src/components/EditorTabs'
import { SessionTabs } from '../src/components/SessionTabs'
import { editorStoreFor, resetEditorStores } from '../src/store/editorStore'
import { useI18nStore } from '../src/store/i18nStore'
import { useSessionStore } from '../src/store/sessionStore'
import { translations } from '../src/i18n/translations'
import type { SessionSummary } from '../src/types/electron'

vi.mock('../src/api', () => ({
  api: {
    draftDelete: vi.fn(async () => ({ success: true })),
  },
}))

const zh = translations.zh

// Vitest 未开 globals，RTL 不会自动清理：每个用例后手动卸载
afterEach(() => {
  cleanup()
})

/** 标签矩形本身就是控件：不要求点中文字、图标或内边距里的具体位置 */
describe('Tab 命中区', () => {
  const renderStrip = () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <div role="tablist" aria-label="标签条">
        <Tab active label="甲" onSelect={onSelect} onClose={onClose} closeLabel="关闭甲" />
        <Tab label="乙" onSelect={onSelect} onClose={onClose} closeLabel="关闭乙" />
        <Tab label="丙" onSelect={onSelect} />
      </div>
    )
    return { onSelect, onClose }
  }

  it('标签矩形本体即点击目标，整块带 cursor-pointer', () => {
    const { onSelect } = renderStrip()

    const tab = screen.getByRole('tab', { name: '乙' })
    expect(tab.className).toContain('cursor-pointer')
    // 文字层不接触指针事件，点击落点始终是标签本体
    expect(tab.querySelector('.pointer-events-none')).toBeTruthy()

    fireEvent.click(tab)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('关闭按钮只关闭、不切换标签', () => {
    const { onSelect, onClose } = renderStrip()

    fireEvent.click(screen.getByLabelText('关闭乙'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('中键关闭标签', () => {
    const { onSelect, onClose } = renderStrip()

    fireEvent(
      screen.getByRole('tab', { name: '乙' }),
      new MouseEvent('auxclick', { bubbles: true, button: 1 })
    )
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('roving tabindex：只有激活标签在 Tab 顺序里', () => {
    renderStrip()

    expect(screen.getByRole('tab', { name: '甲' }).tabIndex).toBe(0)
    expect(screen.getByRole('tab', { name: '乙' }).tabIndex).toBe(-1)
    expect(screen.getByRole('tab', { name: '丙' }).tabIndex).toBe(-1)
  })

  it('←/→/Home/End 移动焦点并自动激活；Enter/Space 激活当前项', () => {
    const { onSelect } = renderStrip()
    const first = screen.getByRole('tab', { name: '甲' })
    const second = screen.getByRole('tab', { name: '乙' })
    const third = screen.getByRole('tab', { name: '丙' })

    act(() => first.focus())
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(second)

    fireEvent.keyDown(second, { key: 'End' })
    expect(document.activeElement).toBe(third)

    // 循环回到另一端
    fireEvent.keyDown(third, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(third)
    fireEvent.keyDown(third, { key: 'Home' })
    expect(document.activeElement).toBe(first)

    onSelect.mockClear()
    fireEvent.keyDown(first, { key: 'Enter' })
    fireEvent.keyDown(first, { key: ' ' })
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it('焦点在关闭按钮上时方向键不切换标签', () => {
    const { onSelect } = renderStrip()

    const close = screen.getByLabelText('关闭乙')
    act(() => close.focus())
    fireEvent.keyDown(close, { key: 'ArrowRight' })
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('EditorTabs 命中区', () => {
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

  beforeEach(() => {
    resetEditorStores()
    useI18nStore.getState().setLanguage('zh')
    openFile('/ws/a.ts', 'a.ts')
    openFile('/ws/b.ts', 'b.ts')
  })

  afterEach(() => {
    cleanup()
  })

  it('点标签矩形（不是文字）就能切换文件', () => {
    render(<EditorTabs workspacePath="/ws" root="/ws" />)

    // 第二个文件是当前文件；点第一个标签任意位置都应切过去
    expect(screen.getByTestId('editor-tabs').getAttribute('role')).toBe('tablist')
    fireEvent.click(screen.getByRole('tab', { name: /a\.ts/ }))
    expect(editorStoreFor('/ws').getState().currentFile?.path).toBe('/ws/a.ts')
  })

  it('点 × 只关闭文件，不切换当前文件', async () => {
    render(<EditorTabs workspacePath="/ws" root="/ws" />)

    fireEvent.click(screen.getAllByLabelText(zh.close)[0])
    await waitFor(() => expect(editorStoreFor('/ws').getState().openFiles).toHaveLength(1))
    expect(editorStoreFor('/ws').getState().currentFile?.path).toBe('/ws/b.ts')
  })

  it('未保存状态写进标签的可访问名称', () => {
    act(() => {
      editorStoreFor('/ws').getState().markDirty('/ws/a.ts')
    })
    render(<EditorTabs workspacePath="/ws" root="/ws" />)

    expect(
      screen.getByRole('tab', { name: new RegExp(`${zh.unsavedChanges}`) })
    ).toBeTruthy()
  })
})

describe('SessionTabs 命中区', () => {
  const WS = '/ws'
  const sessions: SessionSummary[] = [
    { id: 'a', title: 'Fix login', messageCount: 3, createdAt: 1, updatedAt: 2 },
    { id: 'b', title: 'Refactor tree', messageCount: 5, createdAt: 1, updatedAt: 3 },
  ]

  const renderTabs = () => {
    const props = {
      workspacePath: WS,
      sessions,
      onSelect: vi.fn(),
      onNew: vi.fn(),
      onClose: vi.fn(),
      onOpenList: vi.fn(),
    }
    render(<SessionTabs {...props} />)
    return props
  }

  beforeEach(() => {
    useI18nStore.getState().setLanguage('zh')
    useSessionStore.getState().reset()
    useSessionStore.getState().setSessions(WS, sessions)
    useSessionStore.getState().setOpen(WS, ['a', 'b'], 'a')
  })

  afterEach(() => {
    cleanup()
  })

  it('点标签矩形即切换会话', () => {
    const props = renderTabs()

    fireEvent.click(screen.getByRole('tab', { name: /Refactor tree/ }))
    expect(props.onSelect).toHaveBeenCalledWith('b')
  })

  it('点 × 只关闭会话，不切换', () => {
    const props = renderTabs()

    fireEvent.click(screen.getAllByLabelText(zh.closeSessionTab)[0])
    expect(props.onClose).toHaveBeenCalledWith('a')
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('方向键在会话标签间移动并激活', () => {
    const props = renderTabs()

    const first = screen.getByRole('tab', { name: /Fix login/ })
    act(() => first.focus())
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(props.onSelect).toHaveBeenCalledWith('b')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Refactor tree/ }))
  })
})
