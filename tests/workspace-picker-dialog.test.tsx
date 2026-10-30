// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkspacePickerDialog,
  type WorkspacePickerDialogProps,
} from '../src/components/WorkspacePickerDialog'

afterEach(cleanup)

const RECENT = ['C:\\work\\alpha', 'C:\\work\\beta', 'C:\\work\\gamma']

function renderDialog(overrides: Partial<WorkspacePickerDialogProps> = {}) {
  const props: WorkspacePickerDialogProps = {
    open: true,
    onClose: vi.fn(),
    recentWorkspaces: RECENT,
    openWorkspaces: [],
    onOpenWorkspace: vi.fn(),
    onAddWorkspace: vi.fn(),
    ...overrides,
  }
  render(<WorkspacePickerDialog {...props} />)
  return props
}

/** 弹窗里的行按钮，顺序即渲染顺序 */
function rows(): HTMLElement[] {
  // Modal 没给 role="dialog" 设 aria-label，标题在单独的 h2 里
  return within(screen.getByRole('dialog')).getAllByRole('button')
}

describe('WorkspacePickerDialog', () => {
  it('renders nothing while closed', () => {
    renderDialog({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is a modal dialog rather than an anchored popover', () => {
    renderDialog()
    expect(screen.getByText('选择工作区')).toBeTruthy()
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
  })

  it('lists recent workspaces in order, skipping the ones already open', () => {
    renderDialog({ openWorkspaces: ['C:\\work\\beta'] })

    // 关闭按钮 + 取消按钮在前，随后才是列表行
    const listRows = rows().filter((row) => row.textContent?.includes('C:\\work') || row.textContent?.includes('新增工作区'))
    expect(listRows).toHaveLength(3)
    expect(listRows[0].textContent).toContain('alpha')
    expect(listRows[1].textContent).toContain('gamma')
    expect(listRows[2].textContent).toContain('新增工作区')
    expect(screen.queryByText('C:\\work\\beta')).toBeNull()
  })

  it('opens the native picker only from the new-workspace row', () => {
    const props = renderDialog()
    // 渲染弹窗本身绝不触发系统文件选择器
    expect(props.onAddWorkspace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('alpha'))
    expect(props.onOpenWorkspace).toHaveBeenCalledWith('C:\\work\\alpha')
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onAddWorkspace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('新增工作区'))
    expect(props.onAddWorkspace).toHaveBeenCalledTimes(1)
    expect(props.onOpenWorkspace).toHaveBeenCalledTimes(1)
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })

  it('closes from the cancel button', () => {
    const props = renderDialog()
    fireEvent.click(screen.getByText('取消'))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onOpenWorkspace).not.toHaveBeenCalled()
    expect(props.onAddWorkspace).not.toHaveBeenCalled()
  })

  it('shows the new-workspace row alone when every recent workspace is already open', () => {
    renderDialog({ openWorkspaces: [...RECENT] })

    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.getByText('新增工作区')).toBeTruthy()
  })
})
