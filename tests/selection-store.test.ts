import { beforeEach, describe, expect, it } from 'vitest'
import { useSelectionStore, type TextSelection } from '../src/store/selectionStore'

const selection: TextSelection = {
  path: '/tmp/a.ts',
  name: 'a.ts',
  startLine: 2,
  endLine: 4,
  text: 'b\nc\nd',
}

beforeEach(() => {
  useSelectionStore.getState().clearSelection()
})

describe('selectionStore', () => {
  it('stores and clears the current selection', () => {
    useSelectionStore.getState().setSelection(selection)
    expect(useSelectionStore.getState().selection).toEqual(selection)

    useSelectionStore.getState().clearSelection()
    expect(useSelectionStore.getState().selection).toBeNull()
  })

  it('clears the selection when the active file changes', () => {
    useSelectionStore.getState().setSelection(selection)

    useSelectionStore.getState().clearForPath('/tmp/other.ts')
    expect(useSelectionStore.getState().selection).toBeNull()
  })

  it('keeps the selection for the same file', () => {
    useSelectionStore.getState().setSelection(selection)

    useSelectionStore.getState().clearForPath('/tmp/a.ts')
    expect(useSelectionStore.getState().selection).toEqual(selection)
  })
})
