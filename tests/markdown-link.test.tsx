// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownBody } from '../src/components/AgentMarkdown'
import { api } from '../src/api'
import { openFileInEditor } from '../src/workspace/openFileInEditor'
import { useWorkspaceStore } from '../src/store/workspaceStore'

vi.mock('../src/api', () => ({
  api: {
    openExternalUrl: vi.fn(),
    readFile: vi.fn(),
    exists: vi.fn()
  }
}))

vi.mock('../src/workspace/openFileInEditor', () => ({
  openFileInEditor: vi.fn(async () => ({ status: 'opened', path: '/ws/a.ts' }))
}))

vi.mock('../src/store/toastStore', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() }
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.openExternalUrl).mockResolvedValue({ success: true })
  // 仓库内相对链接需要知道工作区根
  useWorkspaceStore.setState({ workspacePath: '/ws' })
})

afterEach(() => {
  cleanup()
})

describe('MarkdownBody links', () => {
  // 打包后主窗口的 setWindowOpenHandler 只放行辅助窗口，target="_blank" 会被静默拒绝
  it('routes external links through the main process instead of window.open', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<MarkdownBody content={'[docs](https://example.com/guide)'} highlight={false} />)

    const link = screen.getByRole('link', { name: 'docs' })
    expect(link.getAttribute('target')).toBeNull()

    fireEvent.click(link)

    await waitFor(() => expect(api.openExternalUrl).toHaveBeenCalledWith('https://example.com/guide'))
    expect(open).not.toHaveBeenCalled()
  })

  it('opens repository files in the editor', async () => {
    render(<MarkdownBody content={'[file](src/a.ts)'} highlight={false} />)

    fireEvent.click(screen.getByRole('link', { name: 'file' }))

    await waitFor(() => expect(openFileInEditor).toHaveBeenCalled())
    expect(api.openExternalUrl).not.toHaveBeenCalled()
  })
})
