/**
 * 画布视图状态的落盘：`{workspace}/.pi-workbench/repo-map-canvas.json`。
 *
 * 只存「**底层地图**上把卡片摆到哪 / 视口在哪」，不存仓库内容（浮层状态不落盘）——
 * 扫描结果变了只剪枝，不整份丢。渲染层传来的一切都当不可信：坐标钳制、
 * 键做路径安全检查、条目数封顶，坏数据一律丢弃而不是抛错。
 */

import * as fs from 'fs'
import * as path from 'path'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-json.js'
import { isTrustedWorkspacePath } from './workspace-trust.js'

export const CANVAS_STATE_VERSION = 1
/** 布局算法版本：渲染层据此迁移旧坐标（这里只负责原样存取） */
export const CANVAS_LAYOUT_VERSION = 4
export const CANVAS_MAX_ENTRIES = 5000
export const CANVAS_MAX_COORD = 1_000_000
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2

export interface CanvasPoint {
  x: number
  y: number
}

export interface CanvasFolderState {
  /** 手动拖过的位置；缺省表示由布局决定 */
  x?: number
  y?: number
}

export interface RepoMapCanvasState {
  version: number
  layoutVersion: number
  zoom: number
  pan: CanvasPoint
  folders: Record<string, CanvasFolderState>
  files: Record<string, CanvasPoint>
}

export interface RepoMapCanvasReadResult {
  success: boolean
  /** 没有文件时返回空状态（不是错误） */
  state: RepoMapCanvasState
  error?: string
}

export interface RepoMapCanvasWriteResult {
  success: boolean
  error?: string
}

export function repoMapCanvasPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.pi-workbench', 'repo-map-canvas.json')
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampCoord(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(CANVAS_MAX_COORD, Math.max(-CANVAS_MAX_COORD, value))
}

function sanitizePoint(value: unknown): CanvasPoint | null {
  if (!isRecord(value)) return null
  const x = clampCoord(value.x)
  const y = clampCoord(value.y)
  return x === null || y === null ? null : { x, y }
}

function isSafeKey(key: string): boolean {
  if (!key || key.length > 512) return false
  if (key.startsWith('/') || key.includes('\\')) return false
  return !key.split('/').some((segment) => segment === '..' || segment === '')
}

/** 任意输入 → 合法状态；版本不符直接重置 */
export function sanitizeCanvasState(value: unknown): RepoMapCanvasState {
  const state = emptyCanvasState()
  if (!isRecord(value) || value.version !== CANVAS_STATE_VERSION) return state

  state.layoutVersion =
    typeof value.layoutVersion === 'number' && Number.isFinite(value.layoutVersion)
      ? Math.max(0, Math.floor(value.layoutVersion))
      : 0
  const zoom = typeof value.zoom === 'number' && Number.isFinite(value.zoom) ? value.zoom : 1
  state.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
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

export async function readRepoMapCanvas(workspaceDir: string): Promise<RepoMapCanvasReadResult> {
  if (!isTrustedWorkspacePath(workspaceDir)) {
    return { success: false, state: emptyCanvasState(), error: 'Workspace is not approved' }
  }
  const result = readJsonWithBackup<unknown>(repoMapCanvasPath(workspaceDir))
  if (result.data === null) {
    return { success: true, state: emptyCanvasState(), error: result.error }
  }
  return { success: true, state: sanitizeCanvasState(result.data) }
}

export async function writeRepoMapCanvas(
  workspaceDir: string,
  value: unknown
): Promise<RepoMapCanvasWriteResult> {
  if (!isTrustedWorkspacePath(workspaceDir)) {
    return { success: false, error: 'Workspace is not approved' }
  }
  try {
    const state = sanitizeCanvasState(value)
    fs.mkdirSync(path.dirname(repoMapCanvasPath(workspaceDir)), { recursive: true })
    await writeJsonAtomic(repoMapCanvasPath(workspaceDir), state)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
