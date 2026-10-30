// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfficeDocumentView } from '../src/components/OfficeDocumentView'
import { api } from '../src/api'
import type { DocumentPreview } from '../src/types/electron'
import type { OpenFile } from '../src/types'

vi.mock('../src/api', () => ({
  api: {
    documentsPreview: vi.fn(),
    openPathExternally: vi.fn(async () => ({ success: true })),
  },
}))

const preview = vi.mocked(api.documentsPreview)

function makeFile(name: string): OpenFile {
  return {
    path: `/ws/${name}`,
    name,
    kind: 'word',
    content: '',
    isDirty: false,
    isSaving: false,
    view: 'reading',
    version: 0,
  }
}

function renderWith(document: DocumentPreview) {
  preview.mockResolvedValue({ success: true, preview: document })
  return render(<OfficeDocumentView file={makeFile('报告.docx')} />)
}

beforeEach(() => {
  preview.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('OfficeDocumentView', () => {
  it('renders heading, paragraph, bullets and table blocks from the parse model', async () => {
    renderWith({
      kind: 'word',
      format: 'docx',
      truncated: false,
      blocks: [
        { type: 'heading', level: 1, text: '年度总结' },
        { type: 'paragraph', text: '今年完成了三件事。' },
        { type: 'bullet', text: '第一件' },
        { type: 'bullet', text: '第二件' },
        {
          type: 'table',
          rows: [
            ['项目', '状态'],
            ['文档阅读', '完成'],
          ],
        },
      ],
    })

    expect(await screen.findByRole('heading', { level: 2, name: '年度总结' })).toBeTruthy()
    expect(screen.getByText('今年完成了三件事。')).toBeTruthy()
    // 连续的符号点合并成一个列表，而不是每行一个 <ul>
    const list = screen.getByRole('list')
    expect(list.querySelectorAll('li')).toHaveLength(2)
    const rows = screen.getAllByRole('row')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelectorAll('th')).toHaveLength(2)
    expect(screen.getByText('完成')).toBeTruthy()
  })

  it('shows sheet tabs and switches the visible grid', async () => {
    renderWith({
      kind: 'sheet',
      format: 'xlsx',
      sheets: [
        {
          name: '汇总',
          rows: [['一月', '二月']],
          merges: [],
          truncated: false,
        },
        {
          name: '明细',
          rows: [['甲']],
          merges: [],
          truncated: false,
        },
      ],
    })

    expect(await screen.findByText('汇总')).toBeTruthy()
    expect(screen.getByText('一月')).toBeTruthy()
    screen.getByText('明细').click()
    await waitFor(() => expect(screen.getByText('甲')).toBeTruthy())
    expect(screen.queryByText('一月')).toBeNull()
  })

  it('renders slide cards with their text and images', async () => {
    renderWith({
      kind: 'slide',
      format: 'pptx',
      slides: [
        {
          index: 1,
          lines: ['封面', '副标题'],
          images: [{ name: 'image1.png', dataUrl: 'data:image/png;base64,AAAA' }],
        },
      ],
    })

    expect(await screen.findByText('封面')).toBeTruthy()
    expect(screen.getByText('副标题')).toBeTruthy()
    expect(screen.getByAltText('image1.png')).toBeTruthy()
  })

  it('renders epub chapters in order', async () => {
    renderWith({
      kind: 'epub',
      format: 'epub',
      chapters: [
        { label: 'chapter 1', lines: ['开头'] },
        { label: 'chapter 2', lines: ['结尾'] },
      ],
    })

    expect(await screen.findByText('chapter 1')).toBeTruthy()
    expect(screen.getByText('结尾')).toBeTruthy()
  })

  it('turns legacy formats into a save-as card instead of a failure', async () => {
    renderWith({
      kind: 'legacy',
      format: 'legacy-office',
      message: '这是旧版 Word 的二进制格式，无法直接读取。用 Word 打开后另存为 .docx。',
    })

    expect(await screen.findByText(/另存为 \.docx/)).toBeTruthy()
    expect(screen.queryByText('openExternally')).toBeNull()
  })

  it('shows the parse error message for a corrupt file', async () => {
    renderWith({ kind: 'error', message: '文件已损坏，无法解析' })
    expect(await screen.findByText('文件已损坏，无法解析')).toBeTruthy()
  })

  it('falls back to an error state when the IPC call fails', async () => {
    preview.mockResolvedValue({ success: false, error: 'Untrusted IPC sender' })
    render(<OfficeDocumentView file={makeFile('报告.docx')} />)
    await waitFor(() => expect(screen.getByText(/Untrusted IPC sender/)).toBeTruthy())
  })
})
