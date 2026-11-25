import { beforeEach, describe, expect, it } from 'vitest'
import {
  selectionForWorkspace,
  useSelectionStore,
  type TextSelection,
} from '../src/store/selectionStore'

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

  it('isolates selections by workspace and clears on workspace close', () => {
    const other: TextSelection = {
      path: '/ws-b/b.ts',
      name: 'b.ts',
      startLine: 1,
      endLine: 1,
      text: 'x',
    }
    useSelectionStore.getState().setSelection(selection, '/ws-a')
    expect(selectionForWorkspace(useSelectionStore.getState(), '/ws-a')).toEqual(selection)
    expect(selectionForWorkspace(useSelectionStore.getState(), '/ws-b')).toBeNull()

    useSelectionStore.getState().setSelection(other, '/ws-b')
    expect(selectionForWorkspace(useSelectionStore.getState(), '/ws-a')).toEqual(selection)
    expect(selectionForWorkspace(useSelectionStore.getState(), '/ws-b')).toEqual(other)

    useSelectionStore.getState().clearWorkspace('/ws-a')
    expect(selectionForWorkspace(useSelectionStore.getState(), '/ws-a')).toBeNull()
    expect(selectionForWorkspace(useSelectionStore.getState(), '/ws-b')).toEqual(other)
  })
})
