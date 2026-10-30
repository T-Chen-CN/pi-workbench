/**
 * 仓库地图 IPC：只读扫描 Git 跟踪的文件并返回「职责事实表」。
 *
 * 写盘只发生在受信任工作区的 `.pi-workbench/repo-map.json`（由 repo-map.ts 负责），
 * 这里只做参数收敛与信任校验，不额外碰文件系统。
 */

import { handleIpc } from './register.js'
import { isTrustedWorkspacePath } from '../workspace-trust.js'
import { scanRepoMap, type RepoMapResult, type RepoMapScanOptions } from '../repo-map.js'
import {
  emptyCanvasState,
  readRepoMapCanvas,
  writeRepoMapCanvas,
  type RepoMapCanvasReadResult,
  type RepoMapCanvasWriteResult
} from '../repo-map-canvas.js'

/** 降级模式下补描述时最多一次点名多少文件：防止渲染层误传整个仓库 */
const MAX_DESCRIBE_PATHS = 500

function failed(error: string): RepoMapResult {
  return {
    success: false,
    isRepo: false,
    total: 0,
    described: 0,
    truncated: false,
    files: [],
    error,
  }
}

/**
 * 收敛渲染层传来的选项：只放行 force / paths。
 * `limit` 是服务端测试与将来设置项的旋钮，不接受渲染层覆盖。
 */
function sanitizeOptions(value: unknown): RepoMapScanOptions {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const options: RepoMapScanOptions = {}
  if (record.force === true) options.force = true
  if (Array.isArray(record.paths)) {
    const paths = record.paths
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .slice(0, MAX_DESCRIBE_PATHS)
    if (paths.length > 0) options.paths = paths
  }
  return options
}

export function registerRepoMapIpc(): void {
  handleIpc(
    'repo-map:scan',
    async (_event, workspaceDir: string, options?: unknown): Promise<RepoMapResult> => {
      if (typeof workspaceDir !== 'string' || !isTrustedWorkspacePath(workspaceDir)) {
        return failed('Workspace is not approved')
      }
      try {
        return await scanRepoMap(workspaceDir, sanitizeOptions(options))
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error))
      }
    }
  )

  handleIpc(
    'repo-map:describe',
    async (_event, workspaceDir: string, paths?: unknown): Promise<RepoMapResult> => {
      if (typeof workspaceDir !== 'string' || !isTrustedWorkspacePath(workspaceDir)) {
        return failed('Workspace is not approved')
      }
      const options = sanitizeOptions({ paths })
      if (!options.paths) return failed('No paths requested')
      try {
        return await scanRepoMap(workspaceDir, options)
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error))
      }
    }
  )

  handleIpc(
    'repo-map:canvas:get',
    async (_event, workspaceDir: string): Promise<RepoMapCanvasReadResult> => {
      if (typeof workspaceDir !== 'string') {
        return { success: false, state: emptyCanvasState(), error: 'Workspace is not approved' }
      }
      return readRepoMapCanvas(workspaceDir)
    }
  )

  handleIpc(
    'repo-map:canvas:set',
    async (_event, workspaceDir: string, state?: unknown): Promise<RepoMapCanvasWriteResult> => {
      if (typeof workspaceDir !== 'string' || !isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      return writeRepoMapCanvas(workspaceDir, state)
    }
  )
}
