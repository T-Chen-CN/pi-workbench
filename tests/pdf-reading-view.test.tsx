// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translations } from '../src/i18n/translations'

const zh = translations.zh

const loadPdf = vi.fn()

vi.mock('../src/pdf/loadPdf', () => ({
  loadPdf: (...args: unknown[]) => loadPdf(...args),
}))

vi.mock('../src/api', () => ({
  api: {
    openPathExternally: vi.fn(async () => ({ success: true })),
  },
}))

const { PdfReadingView } = await import('../src/components/PdfReadingView')

const file = {
  path: '/ws/sample.pdf',
  name: 'sample.pdf',
  kind: 'pdf' as const,
  view: 'reading' as const,
  content: '',
  isDirty: false,
  isSaving: false,
  version: 1,
}

const makeDocument = (numPages: number) => ({
  numPages,
  getPage: vi.fn(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
  })),
})

beforeEach(() => {
  loadPdf.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('PdfReadingView', () => {
  it('renders one placeholder per page and paints only the visible ones', async () => {
    loadPdf.mockResolvedValue({ document: makeDocument(3), destroy: () => {} })
    const { container } = render(<PdfReadingView file={file} />)

    await waitFor(() => expect(container.querySelectorAll('[data-page]')).toHaveLength(3))
    // 页码指示与工具条
    expect(screen.getByTestId('pdf-page-indicator').textContent).toBe(`1 / 3`)
    expect(screen.getByRole('button', { name: zh.fitWidth }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    // jsdom 没有 canvas 2d 上下文，渲染会安全退出而不是抛错
    expect(container.querySelectorAll('[data-page] canvas')).toHaveLength(3)
  })

  it('reports a failed load instead of falling back to another viewer', async () => {
    loadPdf.mockRejectedValue(new Error('broken'))
    render(<PdfReadingView file={file} />)

    await waitFor(() => expect(screen.getByText(zh.pdfLoadFailed)).toBeTruthy())
    // 一条渲染路径：失败时只给系统打开入口，不出现 iframe 内置查看器
    expect(document.querySelector('iframe')).toBeNull()
    expect(screen.getByRole('button', { name: zh.openExternally })).toBeTruthy()
  })

  it('pages with the toolbar and the keyboard', async () => {
    loadPdf.mockResolvedValue({ document: makeDocument(4), destroy: () => {} })
    render(<PdfReadingView file={file} />)
    await waitFor(() => expect(screen.getByTestId('pdf-page-indicator').textContent).toBe('1 / 4'))

    fireEvent.click(screen.getByRole('button', { name: zh.nextPage }))
    await waitFor(() => expect(screen.getByTestId('pdf-page-indicator').textContent).toBe('2 / 4'))

    fireEvent.click(screen.getByRole('button', { name: zh.previousPage }))
    await waitFor(() => expect(screen.getByTestId('pdf-page-indicator').textContent).toBe('1 / 4'))

    const scroller = screen.getByTestId('pdf-scroll')
    fireEvent.keyDown(scroller, { key: 'End' })
    await waitFor(() => expect(screen.getByTestId('pdf-page-indicator').textContent).toBe('4 / 4'))

    fireEvent.keyDown(scroller, { key: 'Home' })
    await waitFor(() => expect(screen.getByTestId('pdf-page-indicator').textContent).toBe('1 / 4'))
  })

  it('drops out of fit-width when zoomed manually', async () => {
    loadPdf.mockResolvedValue({ document: makeDocument(2), destroy: () => {} })
    render(<PdfReadingView file={file} />)
    await waitFor(() => expect(screen.getByTestId('pdf-page-indicator').textContent).toBe('1 / 2'))

    const fit = screen.getByRole('button', { name: zh.fitWidth })
    expect(fit.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: zh.zoomIn }))
    expect(fit.getAttribute('aria-pressed')).toBeNull()

    fireEvent.click(fit)
    expect(fit.getAttribute('aria-pressed')).toBe('true')
  })
})
