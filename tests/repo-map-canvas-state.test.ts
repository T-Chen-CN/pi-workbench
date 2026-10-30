import { describe, expect, it } from 'vitest'
import {
  CANVAS_LAYOUT_VERSION,
  CANVAS_MAX_COORD,
  CANVAS_STATE_VERSION,
  canvasStateEquals,
  emptyCanvasState,
  migrateCanvasLayout,
  persistedPositionsFor,
  pruneCanvasState,
  sanitizeCanvasState,
} from '../src/utils/repoMapCanvasState'

const VALID = {
  version: CANVAS_STATE_VERSION,
  layoutVersion: CANVAS_LAYOUT_VERSION,
  zoom: 1.5,
  pan: { x: -120, y: 40 },
  folders: {
    src: { x: 320, y: 80 },
    docs: { x: 640, y: 80 },
  },
  files: { 'src/App.tsx': { x: 960, y: 80 } },
}

describe('sanitizeCanvasState', () => {
  it('keeps a valid state intact', () => {
    expect(sanitizeCanvasState(VALID)).toEqual(VALID)
  })

  it('returns an empty state for garbage or a version mismatch', () => {
    expect(sanitizeCanvasState(null)).toEqual(emptyCanvasState())
    expect(sanitizeCanvasState('nope')).toEqual(emptyCanvasState())
    expect(sanitizeCanvasState({ ...VALID, version: 0 })).toEqual(emptyCanvasState())
  })

  it('clamps zoom into the supported range and drops a broken pan', () => {
    const state = sanitizeCanvasState({ ...VALID, zoom: 40, pan: { x: 'a', y: 1 } })
    expect(state.zoom).toBe(2)
    expect(state.pan).toEqual({ x: 0, y: 0 })
  })

  it('clamps absurd coordinates', () => {
    const state = sanitizeCanvasState({
      ...VALID,
      files: { 'a.ts': { x: 9e9, y: -9e9 }, 'b.ts': { x: Number.NaN, y: 0 } },
    })
    expect(state.files['a.ts']).toEqual({ x: CANVAS_MAX_COORD, y: -CANVAS_MAX_COORD })
    expect(state.files['b.ts']).toBeUndefined()
  })

  it('drops unsafe path keys', () => {
    const state = sanitizeCanvasState({
      ...VALID,
      files: {
        '../escape.ts': { x: 1, y: 2 },
        '/abs.ts': { x: 1, y: 2 },
        'a\\b.ts': { x: 1, y: 2 },
        'ok.ts': { x: 1, y: 2 },
      },
    })
    expect(Object.keys(state.files)).toEqual(['ok.ts'])
  })

  it('drops a folder entry without coordinates (only manual positions are stored)', () => {
    const state = sanitizeCanvasState({
      ...VALID,
      folders: { src: { collapsed: false }, docs: { x: 5, y: 6 } },
    })
    expect(state.folders.src).toBeUndefined()
    expect(state.folders.docs).toEqual({ x: 5, y: 6 })
  })

  it('ignores a legacy collapsed flag', () => {
    const state = sanitizeCanvasState({
      ...VALID,
      folders: { src: { x: 1, y: 2, collapsed: false } },
    })
    expect(state.folders.src).toEqual({ x: 1, y: 2 })
  })

  it('treats a missing layoutVersion as 0 so it gets migrated', () => {
    const { layoutVersion: _ignored, ...withoutLayout } = VALID
    expect(sanitizeCanvasState(withoutLayout).layoutVersion).toBe(0)
  })

  it('caps the number of entries', () => {
    const folders: Record<string, unknown> = {}
    for (let index = 0; index < 6000; index++) folders[`f${index}`] = { x: 0, y: 0 }
    const state = sanitizeCanvasState({ ...VALID, folders, files: {} })
    expect(Object.keys(state.folders).length).toBe(5000)
  })
})

describe('migrateCanvasLayout', () => {
  it('旧布局版本 → v4：坐标整批丢掉，视口保留', () => {
    const legacy = sanitizeCanvasState({
      version: 1,
      layoutVersion: 3,
      zoom: 0.75,
      pan: { x: 12, y: 34 },
      folders: {
        src: { x: 320, y: 80 },
        'src/store': { x: 640, y: 80 },
      },
      files: { 'AGENTS.md': { x: 10, y: 20 } },
    })

    const migrated = migrateCanvasLayout(legacy)
    expect(migrated.layoutVersion).toBe(CANVAS_LAYOUT_VERSION)
    // 排版规则变了，旧坐标与新位置对不上 → 清空（重新按固定网格铺）
    expect(migrated.folders).toEqual({})
    expect(migrated.files).toEqual({})
    // 视口是视线不是布局，照旧恢复
    expect(migrated.zoom).toBeCloseTo(0.75, 5)
    expect(migrated.pan).toEqual({ x: 12, y: 34 })
  })

  it('is a no-op for the current layout version', () => {
    const state = sanitizeCanvasState(VALID)
    expect(migrateCanvasLayout(state)).toBe(state)
  })
})

describe('persistedPositionsFor', () => {
  it('only exposes entries with explicit coordinates', () => {
    const state = sanitizeCanvasState({
      ...VALID,
      folders: {
        src: { x: 10, y: 20, collapsed: false },
        docs: { collapsed: true },
      },
      files: { 'src/App.tsx': { x: 1, y: 2 } },
    })
    expect(persistedPositionsFor(state)).toEqual({
      folders: { src: { x: 10, y: 20 } },
      files: { 'src/App.tsx': { x: 1, y: 2 } },
    })
    expect(persistedPositionsFor(null)).toEqual({ folders: {}, files: {} })
  })
})

describe('pruneCanvasState', () => {
  it('drops entries for paths that no longer exist', () => {
    const pruned = pruneCanvasState(sanitizeCanvasState(VALID), {
      folders: ['src'],
      files: ['src/App.tsx'],
    })
    expect(Object.keys(pruned.folders)).toEqual(['src'])
    expect(Object.keys(pruned.files)).toEqual(['src/App.tsx'])
    expect(pruned.zoom).toBe(1.5)
  })

  it('keeps the viewport even when everything was removed', () => {
    const pruned = pruneCanvasState(sanitizeCanvasState(VALID), { folders: [], files: [] })
    expect(pruned.folders).toEqual({})
    expect(pruned.files).toEqual({})
    expect(pruned.pan).toEqual({ x: -120, y: 40 })
  })
})

describe('canvasStateEquals', () => {
  it('detects equality and per-field differences', () => {
    const left = sanitizeCanvasState(VALID)
    expect(canvasStateEquals(left, sanitizeCanvasState(VALID))).toBe(true)

    const zoomed = { ...left, zoom: 1.2 }
    expect(canvasStateEquals(left, zoomed)).toBe(false)

    const moved = { ...left, files: { 'src/App.tsx': { x: 1, y: 1 } } }
    expect(canvasStateEquals(left, moved)).toBe(false)

    const movedFolder = { ...left, folders: { ...left.folders, src: { x: 1, y: 2 } } }
    expect(canvasStateEquals(left, movedFolder)).toBe(false)

    const extraFolder = { ...left, folders: { ...left.folders, docs: { x: 0, y: 0 } } }
    expect(canvasStateEquals(left, extraFolder)).toBe(false)
  })
})
