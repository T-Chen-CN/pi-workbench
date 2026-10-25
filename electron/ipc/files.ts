/** 文件系统、工作区搜索与崩溃恢复草稿的 IPC */

import * as fs from 'fs/promises'
import * as path from 'path'
import { statSync } from 'fs'
import { handleIpc } from './register.js'
import type { DraftStore } from '../draft-store.js'
import {
  canonicalizePath,
  isProtectedRoot,
  isTrustedWorkspacePath,
  resolveAllowedFileTarget,
  resolveWorkspaceFile,
} from '../workspace-trust.js'

export interface FilesIpcContext {
  draftStore: DraftStore
  /** 文件保存后通知插件钩子 */
  onFileSaved?: (targetPath: string) => void
}

export function registerFilesIpc(context: FilesIpcContext): void {
  handleIpc('fs:readFile', async (_event, filePath: string) => {
    try {
      const target = resolveAllowedFileTarget(filePath)
      if (!target) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      const content = await fs.readFile(target, 'utf-8')
      return { success: true, content }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('fs:writeFile', async (_event, filePath: string, content: string) => {
    try {
      const target = resolveAllowedFileTarget(filePath)
      if (!target) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      await fs.writeFile(target, content, 'utf-8')
      context.onFileSaved?.(target)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('fs:listDirectory', async (_event, dirPath: string) => {
    try {
      const target = resolveAllowedFileTarget(dirPath)
      if (!target) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      const entries = await fs.readdir(target, { withFileTypes: true })
      const items = entries.map((entry) => ({
        name: entry.name,
        path: path.join(target, entry.name),
        isDirectory: entry.isDirectory(),
      }))
      return { success: true, items }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('fs:exists', async (_event, filePath: string) => {
    try {
      const target = resolveAllowedFileTarget(filePath)
      if (!target) return { success: true, exists: false }
      return { success: true, exists: statSync(target, { throwIfNoEntry: false }) !== undefined }
    } catch (error) {
      return { success: true, exists: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('fs:stat', async (_event, filePath: string) => {
    try {
      const target = resolveAllowedFileTarget(filePath)
      if (!target) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      const stats = statSync(target)
      return {
        success: true,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        size: stats.size,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('fs:delete', async (_event, targetPath: string) => {
    try {
      const target = resolveAllowedFileTarget(targetPath)
      if (!target) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      if (isProtectedRoot(target)) {
        return { success: false, error: 'Cannot delete a workspace root' }
      }
      await fs.rm(target, { recursive: true, force: false })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('fs:rename', async (_event, oldPath: string, newPath: string) => {
    try {
      const source = resolveAllowedFileTarget(oldPath)
      const destination = resolveAllowedFileTarget(newPath)
      if (!source || !destination) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      if (isProtectedRoot(source) || isProtectedRoot(destination)) {
        return { success: false, error: 'Cannot rename a workspace root' }
      }
      await fs.rename(source, destination)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 文件引用：在工作区内按文件名 / 路径片段搜索（跳过依赖与构建目录）
  handleIpc(
    'workspace:searchFiles',
    async (_event, workspaceDir: string, query: string, limit = 20) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        const needle = String(query ?? '').trim().toLowerCase()
        const maxResults = Math.min(50, Math.max(1, Number(limit) || 20))
        const ignored = new Set([
          'node_modules',
          '.git',
          '.pi-workbench',
          '.pi-worktrees',
          'dist',
          'dist-electron',
          'cache',
          'logs',
          'release',
        ])
        const results: string[] = []
        let visited = 0
        const maxVisited = 6000

        async function walk(dir: string, depth: number): Promise<void> {
          if (results.length >= maxResults || visited >= maxVisited || depth > 8) return
          let entries
          try {
            entries = await fs.readdir(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const entry of entries) {
            if (results.length >= maxResults || visited >= maxVisited) return
            if (entry.name.startsWith('.') && entry.name !== '.env') continue
            if (entry.isDirectory()) {
              if (ignored.has(entry.name)) continue
              await walk(path.join(dir, entry.name), depth + 1)
              continue
            }
            if (!entry.isFile()) continue
            visited++
            const relative = path
              .relative(workspaceDir, path.join(dir, entry.name))
              .split(path.sep)
              .join('/')
            if (!needle || relative.toLowerCase().includes(needle)) {
              results.push(relative)
            }
          }
        }

        await walk(workspaceDir, 0)
        return { success: true, files: results }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // ---- 崩溃恢复草稿 ----

  handleIpc('draft:save', async (_event, workspacePath: string, filePath: string, content: unknown) => {
    try {
      const target = resolveWorkspaceFile(workspacePath, filePath)
      if (!target) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      if (typeof content !== 'string') {
        return { success: false, error: 'Draft content must be a string' }
      }
      context.draftStore.save(target.workspace, target.file, content)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('draft:delete', async (_event, workspacePath: string, filePath: string) => {
    try {
      const target = resolveWorkspaceFile(workspacePath, filePath)
      if (!target) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      context.draftStore.remove(target.workspace, target.file)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('draft:list', async (_event, workspacePath: string) => {
    try {
      if (!isTrustedWorkspacePath(workspacePath)) {
        return { success: false, drafts: [], error: 'Workspace is not approved' }
      }
      const workspace = canonicalizePath(workspacePath) ?? workspacePath
      return { success: true, drafts: context.draftStore.list(workspace) }
    } catch (error) {
      return {
        success: false,
        drafts: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  handleIpc('draft:clear', async (_event, workspacePath: string) => {
    try {
      if (!isTrustedWorkspacePath(workspacePath)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      context.draftStore.clear(canonicalizePath(workspacePath) ?? workspacePath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
