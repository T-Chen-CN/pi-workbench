import { afterEach, describe, expect, it } from 'vitest'
import { alertDialog, confirmDialog, promptDialog, useDialogStore } from '../src/store/dialogStore'

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

  it('resolves an alert dialog without a result', async () => {
    const promise = alertDialog({ title: 'Cannot save', message: 'Sessions are running' })
    expect(useDialogStore.getState().current?.kind).toBe('alert')

    useDialogStore.getState().close(null)
    await expect(promise).resolves.toBeUndefined()
    expect(useDialogStore.getState().current).toBeNull()
  })

  it('settles an open alert when another dialog takes over', async () => {
    const alert = alertDialog({ message: 'Heads up' })
    const confirm = confirmDialog({ message: 'Delete?' })

    await expect(alert).resolves.toBeUndefined()
    useDialogStore.getState().close(false)
    await expect(confirm).resolves.toBe(false)
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
