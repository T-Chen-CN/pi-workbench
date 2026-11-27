/** 文件系统、工作区搜索与崩溃恢复草稿的 IPC */

import * as fs from 'fs/promises'
import { open as openFile } from 'fs/promises'
import * as path from 'path'
import { statSync } from 'fs'
import { shell } from 'electron'
import { handleIpc } from './register.js'
import {
  draftDeleteSchema,
  draftSaveSchema,
  fsCreateFileSchema,
  fsRenameSchema,
  fsWriteFileSchema,
  parseIpcInput,
  safePathSchema,
} from './schemas.js'
import { mimeForPath } from '../file-protocol.js'
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

/** 探测头部多少字节判断是否二进制 */
const BINARY_PROBE_BYTES = 8192
/** 文本文件读取上限：防止超大单文件一次读入主进程内存造成 OOM */
const MAX_TEXT_FILE_BYTES = 32 * 1024 * 1024
/** 允许直接交给 shell.openPath 打开的安全文档与媒体白名单；其余后缀退回文件管理器定位，避免触发任意程序/脚本执行 */
export const SAFE_EXTERNAL_OPEN_EXTENSIONS = new Set([
  '.pdf',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a',
  '.mp4', '.webm', '.mov', '.mkv',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.epub',
  '.txt', '.md', '.csv', '.json', '.log',
])

let atomicWriteSeq = 0

async function renameWithWindowsRetry(from: string, to: string): Promise<void> {
  const retries = process.platform === 'win32' ? 5 : 1
  let lastError: unknown
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException)?.code
      if (
        process.platform !== 'win32' ||
        (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')
      ) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)))
    }
  }
  throw lastError
}

/** 同目录临时文件 + rename 原子写，防止崩溃截断用户源文件；POSIX 上尽量保留原文件权限位 */
async function writeTextFileAtomic(target: string, content: string): Promise<void> {
  let existingMode: number | undefined
  try {
    const existing = await fs.stat(target)
    existingMode = existing.mode & 0o777
  } catch {
    // 目标文件尚不存在
  }

  const tmpPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${++atomicWriteSeq}.tmp`
  )
  try {
    await fs.writeFile(tmpPath, content, 'utf-8')
    if (existingMode !== undefined && process.platform !== 'win32') {
      await fs.chmod(tmpPath, existingMode).catch(() => undefined)
    }
    await renameWithWindowsRetry(tmpPath, target)
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined)
    throw error
  }
}

/** 头部出现 NUL 字节即视为二进制：文本文件不会包含它 */
async function looksBinary(targetPath: string, size: number): Promise<boolean> {
  if (size === 0) return false
  const handle = await openFile(targetPath, 'r')
  try {
    const length = Math.min(BINARY_PROBE_BYTES, size)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

export function registerFilesIpc(context: FilesIpcContext): void {
  handleIpc('fs:readFile', async (_event, filePath: string) => {
    try {
      const target = resolveAllowedFileTarget(filePath)
      if (!target) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      const stats = await fs.stat(target)
      // 二进制文件不返回文本：图片 / 音视频 / PDF 由 pw-file:// 协议渲染
      if (await looksBinary(target, stats.size)) {
        return {
          success: true,
          binary: true,
          mime: mimeForPath(target),
          size: stats.size,
        }
      }
      if (stats.size > MAX_TEXT_FILE_BYTES) {
        return {
          success: false,
          error: `File exceeds the ${MAX_TEXT_FILE_BYTES / 1024 / 1024} MB text preview limit`,
        }
      }
      const content = await fs.readFile(target, 'utf-8')
      return { success: true, binary: false, content }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 用系统默认程序打开：仅白名单安全文档与媒体走 shell.openPath，其余类型安全在文件管理器中定位
  handleIpc('fs:openExternally', async (_event, filePath: string) => {
    try {
      const parsedPath = parseIpcInput(safePathSchema, filePath)
      if (!parsedPath.ok) return { success: false, error: parsedPath.error }
      const target = resolveAllowedFileTarget(parsedPath.data)
      if (!target) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      const stats = await fs.stat(target)
      if (!stats.isFile()) {
        return { success: false, error: 'Target is not a regular file' }
      }
      const ext = path.extname(target).toLowerCase()
      if (!SAFE_EXTERNAL_OPEN_EXTENSIONS.has(ext)) {
        shell.showItemInFolder(target)
        return { success: true, revealed: true }
      }
      const error = await shell.openPath(target)
      return error ? { success: false, error } : { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('fs:createFile', async (_event, filePath: string) => {
    try {
      const parsed = parseIpcInput(fsCreateFileSchema, { filePath })
      if (!parsed.ok) return { success: false, error: parsed.error }
      const target = resolveAllowedFileTarget(parsed.data.filePath)
      if (!target) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      await fs.writeFile(target, '', { encoding: 'utf-8', flag: 'wx' })
      return { success: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
        return { success: false, code: 'EEXIST', error: 'File already exists' }
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('fs:writeFile', async (_event, filePath: string, content: string) => {
    try {
      const parsed = parseIpcInput(fsWriteFileSchema, { filePath, content })
      if (!parsed.ok) return { success: false, error: parsed.error }
      const target = resolveAllowedFileTarget(parsed.data.filePath)
      if (!target) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      await writeTextFileAtomic(target, parsed.data.content)
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
      const parsedPath = parseIpcInput(safePathSchema, targetPath)
      if (!parsedPath.ok) return { success: false, error: parsedPath.error }
      const target = resolveAllowedFileTarget(parsedPath.data)
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
      const parsed = parseIpcInput(fsRenameSchema, { oldPath, newPath })
      if (!parsed.ok) return { success: false, error: parsed.error }
      const source = resolveAllowedFileTarget(parsed.data.oldPath)
      const destination = resolveAllowedFileTarget(parsed.data.newPath)
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
      const parsed = parseIpcInput(draftSaveSchema, { workspacePath, filePath, content })
      if (!parsed.ok) return { success: false, error: parsed.error }
      const target = resolveWorkspaceFile(parsed.data.workspacePath, parsed.data.filePath)
      if (!target) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      await context.draftStore.save(target.workspace, target.file, parsed.data.content)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('draft:delete', async (_event, workspacePath: string, filePath: string) => {
    try {
      const parsed = parseIpcInput(draftDeleteSchema, { workspacePath, filePath })
      if (!parsed.ok) return { success: false, error: parsed.error }
      const target = resolveWorkspaceFile(parsed.data.workspacePath, parsed.data.filePath)
      if (!target) {
        return { success: false, error: 'Path is outside the open workspace' }
      }
      await context.draftStore.removeAsync(target.workspace, target.file)
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
      return { success: true, drafts: await context.draftStore.listAsync(workspace) }
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
      await context.draftStore.clearAsync(canonicalizePath(workspacePath) ?? workspacePath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
