// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DialogHost } from '../src/components/DialogHost'
import { promptDialog, useDialogStore } from '../src/store/dialogStore'
import { useI18nStore } from '../src/store/i18nStore'

beforeEach(() => {
  useI18nStore.getState().setLanguage('zh')
  useDialogStore.setState({ current: null })
})

afterEach(() => {
  cleanup()
  useDialogStore.setState({ current: null })
})

describe('DialogHost（P0-4 / P0-5 / P1-9）', () => {
  it('渲染在 z-[60] 顶层、内容区有内边距，且输入法组合态按 Enter 不误提交', async () => {
    render(<DialogHost />)

    let promise!: Promise<string | null>
    act(() => {
      promise = promptDialog({ title: '重命名', message: '输入新名称', defaultValue: 'draft.md' })
    })

    const dialog = await screen.findByRole('dialog')
    expect(dialog.parentElement?.className).toContain('z-[60]')
    expect(dialog.querySelector('.px-5.py-4')).not.toBeNull()

    const input = screen.getByDisplayValue('draft.md') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'final.md' } })

    // 输入法组合态按 Enter 不得提前提交
    const imeEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    Object.defineProperty(imeEnter, 'isComposing', { value: true })
    fireEvent(input, imeEnter)
    expect(useDialogStore.getState().current).not.toBeNull()

    fireEvent.keyDown(input, { key: 'Enter' })
    await expect(promise).resolves.toBe('final.md')
    expect(useDialogStore.getState().current).toBeNull()
  })
})
