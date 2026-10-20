import { afterEach, describe, expect, it } from 'vitest'
import { confirmDialog, promptDialog, useDialogStore } from '../src/store/dialogStore'

afterEach(() => {
  useDialogStore.setState({ current: null })
})

describe('dialog store', () => {
  it('resolves a confirm dialog with the chosen boolean', async () => {
    const promise = confirmDialog({ message: 'Delete?' })
    expect(useDialogStore.getState().current?.kind).toBe('confirm')

    useDialogStore.getState().close(true)
    await expect(promise).resolves.toBe(true)
    expect(useDialogStore.getState().current).toBeNull()
  })

  it('resolves a prompt dialog with the entered value or null', async () => {
    const typed = promptDialog({ title: 'Rename', defaultValue: 'old.txt' })
    useDialogStore.getState().close('new.txt')
    await expect(typed).resolves.toBe('new.txt')

    const cancelled = promptDialog({ title: 'Rename' })
    useDialogStore.getState().close(null)
    await expect(cancelled).resolves.toBeNull()
  })

  it('cancels the previous dialog when a new one opens', async () => {
    const first = confirmDialog({ message: 'First' })
    const second = confirmDialog({ message: 'Second' })

    await expect(first).resolves.toBe(false)
    expect(useDialogStore.getState().current?.kind).toBe('confirm')
    useDialogStore.getState().close(true)
    await expect(second).resolves.toBe(true)
  })
})
