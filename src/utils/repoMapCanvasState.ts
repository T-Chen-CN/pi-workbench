/**
 * 画布视图状态的形状、清洗与迁移（纯函数）。
 *
 * 这份状态落盘到 `<workspace>/.pi-workbench/repo-map-canvas.json`，只描述
 * 「**底层地图**上手摆过的卡片在哪、视口在哪」——
 * 浮层的栈、层内位置、层内视口都只在内存里，重启即清空（不落盘）。
 */

import type { Point } from './repoMapLayout'
import { MAX_ZOOM, MIN_ZOOM } from './repoMapLayout'

export const CANVAS_STATE_VERSION = 1
/** 底层布局的版本：算法变了就自增，旧坐标整批作废 */
export const CANVAS_LAYOUT_VERSION = 4
export const CANVAS_MAX_ENTRIES = 5000
export const CANVAS_MAX_COORD = 1_000_000

/** 顶层文件夹：只记手动拖过的位置；缺省 = 用布局算出来的位置 */
export interface CanvasFolderState {
  x?: number
  y?: number
}

export interface RepoMapCanvasState {
  version: number
  layoutVersion: number
  zoom: number
  pan: Point
  /** 键是顶层目录相对路径（无尾斜杠） */
  folders: Record<string, CanvasFolderState>
  /** 键是文件相对路径；只有手动拖过的文件才在这里 */
  files: Record<string, Point>
}

export function emptyCanvasState(): RepoMapCanvasState {
  return {
    version: CANVAS_STATE_VERSION,
    layoutVersion: CANVAS_LAYOUT_VERSION,
    zoom: 1,
    pan: { x: 0, y: 0 },
    folders: {},
    files: {},
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clampCoord(value: unknown): number | null {
  const number = finiteOr(value, Number.NaN)
  if (!Number.isFinite(number)) return null
  return Math.min(CANVAS_MAX_COORD, Math.max(-CANVAS_MAX_COORD, number))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 路径键必须是干净的相对 posix 路径，避免 `../` 之类的东西进状态 */
function isSafeKey(key: string): boolean {
  if (!key || key.length > 512) return false
  if (key.startsWith('/') || key.includes('\\')) return false
  return !key.split('/').some((segment) => segment === '..' || segment === '')
}

function sanitizePoint(value: unknown): Point | null {
  if (!isRecord(value)) return null
  const x = clampCoord(value.x)
  const y = clampCoord(value.y)
  if (x === null || y === null) return null
  return { x, y }
}

/**
 * 任意输入（旧文件、手改过的 JSON）→ 合法状态；不抛错。
 * 版本不符整份重置；`layoutVersion` 缺失按 0 处理，交给迁移函数。
 */
export function sanitizeCanvasState(value: unknown): RepoMapCanvasState {
  const state = emptyCanvasState()
  if (!isRecord(value)) return state
  if (value.version !== CANVAS_STATE_VERSION) return state

  state.layoutVersion =
    typeof value.layoutVersion === 'number' && Number.isFinite(value.layoutVersion)
      ? Math.max(0, Math.floor(value.layoutVersion))
      : 0
  state.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, finiteOr(value.zoom, 1)))
  state.pan = sanitizePoint(value.pan) ?? { x: 0, y: 0 }

  if (isRecord(value.folders)) {
    let count = 0
    for (const [key, entry] of Object.entries(value.folders)) {
      if (count >= CANVAS_MAX_ENTRIES) break
      if (!isSafeKey(key) || !isRecord(entry)) continue
      const point = sanitizePoint(entry)
      if (!point) continue
      state.folders[key] = point
      count++
    }
  }

  if (isRecord(value.files)) {
    let count = 0
    for (const [key, entry] of Object.entries(value.files)) {
      if (count >= CANVAS_MAX_ENTRIES) break
      if (!isSafeKey(key)) continue
      const point = sanitizePoint(entry)
      if (!point) continue
      state.files[key] = point
      count++
    }
  }

  return state
}

/**
 * 布局版本迁移（v3 → v4）。
 *
 * v3 是「按高度分栏 + 根文件 8 行折列」，v4 是「固定列数（每行 4 个）的行优先网格」。
 * 两套规则的坐标系对不上，旧的手摆坐标继续用会和新位置重叠（看起来像随手堆的），
 * 所以**整批丢掉**，只保留视口（zoom / pan）。用户想保留自己的摆法时不要随手改算法 ——
 * 改了就必须升版本，这是「布局版本」存在的意义。
 */
export function migrateCanvasLayout(state: RepoMapCanvasState): RepoMapCanvasState {
  if (state.layoutVersion >= CANVAS_LAYOUT_VERSION) return state
  return {
    ...state,
    layoutVersion: CANVAS_LAYOUT_VERSION,
    folders: {},
    files: {},
  }
}

/** 布局需要的「已手动摆放」坐标：只有存了 x/y 的条目才算 */
export function persistedPositionsFor(state: RepoMapCanvasState | null): {
  folders: Record<string, Point>
  files: Record<string, Point>
} {
  const folders: Record<string, Point> = {}
  const files: Record<string, Point> = {}
  if (!state) return { folders, files }
  for (const [key, entry] of Object.entries(state.folders)) {
    if (typeof entry.x === 'number' && typeof entry.y === 'number') {
      folders[key] = { x: entry.x, y: entry.y }
    }
  }
  for (const [key, entry] of Object.entries(state.files)) {
    files[key] = { x: entry.x, y: entry.y }
  }
  return { folders, files }
}

/** 剪枝：只保留仍然存在的顶层目录 / 根文件坐标 */
export function pruneCanvasState(
  state: RepoMapCanvasState,
  known: { folders: Iterable<string>; files: Iterable<string> }
): RepoMapCanvasState {
  const folders = new Set(known.folders)
  const files = new Set(known.files)
  const next: RepoMapCanvasState = {
    ...state,
    folders: {},
    files: {},
  }
  for (const [key, entry] of Object.entries(state.folders)) {
    if (folders.has(key)) next.folders[key] = entry
  }
  for (const [key, entry] of Object.entries(state.files)) {
    if (files.has(key)) next.files[key] = entry
  }
  return next
}

/** 判断两份状态是否等价（用于跳过无意义的落盘） */
export function canvasStateEquals(
  left: RepoMapCanvasState,
  right: RepoMapCanvasState
): boolean {
  if (left.layoutVersion !== right.layoutVersion) return false
  if (left.zoom !== right.zoom) return false
  if (left.pan.x !== right.pan.x || left.pan.y !== right.pan.y) return false

  const leftFolderKeys = Object.keys(left.folders)
  const rightFolderKeys = Object.keys(right.folders)
  if (leftFolderKeys.length !== rightFolderKeys.length) return false
  if (leftFolderKeys.some((key) => !right.folders[key])) return false
  for (const key of leftFolderKeys) {
    const a = left.folders[key]
    const b = right.folders[key]
    if (a.x !== b.x || a.y !== b.y) return false
  }

  const leftFileKeys = Object.keys(left.files)
  const rightFileKeys = Object.keys(right.files)
  if (leftFileKeys.length !== rightFileKeys.length) return false
  if (leftFileKeys.some((key) => !right.files[key])) return false
  for (const key of leftFileKeys) {
    const a = left.files[key]
    const b = right.files[key]
    if (a.x !== b.x || a.y !== b.y) return false
  }
  return true
}
