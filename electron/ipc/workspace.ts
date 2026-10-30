/** 工作区选择、监听、最近列表、生命周期与编辑器标签 IPC */

import { existsSync, watch, type FSWatcher } from 'fs'
import * as fs from 'fs/promises'
import * as path from 'path'
import { dialog, type BrowserWindow } from 'electron'
import { handleIpc } from './register.js'
import { WatchBatcher } from '../watch-batcher.js'
import { isIgnoredWatchPath } from '../watch-filter.js'
import type { PluginManager } from '../plugin-manager.js'
import type { TerminalManager } from '../terminal-manager.js'
import type { WorkspaceStore } from '../workspace-store.js'
import {
  canonicalizePath,
  isPathInsideRoot,
  isTrustedWorkspacePath,
  normalizeForComparison,
  resolveWatchableRoot,
  trustWorkspace,
} from '../workspace-trust.js'
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.js'
import { disposeCoordinator } from '../worktree-coordinator.js'
import { repoSync } from '../repo-sync.js'

interface WorkspaceWatchEntry {
  watcher: FSWatcher
  batcher: WatchBatcher
}

const workspaceWatchers = new Map<string, WorkspaceWatchEntry>()

function workspaceWatchKey(workspacePath: string): string {
  return normalizeForComparison(canonicalizePath(workspacePath) ?? path.resolve(workspacePath))
}

function closeWorkspaceWatcher(workspacePath: string): void {
  const key = workspaceWatchKey(workspacePath)
  const entry = workspaceWatchers.get(key)
  if (!entry) return
  entry.batcher.cancel()
  entry.watcher.close()
  workspaceWatchers.delete(key)
}

export function closeAllWorkspaceWatchers(): void {
  for (const entry of workspaceWatchers.values()) {
    entry.batcher.cancel()
    entry.watcher.close()
  }
  workspaceWatchers.clear()
}

export interface WorkspaceIpcContext {
  getMainWindow: () => BrowserWindow | null
  pluginManager: PluginManager
  terminalManager: TerminalManager
  workspaceStore: WorkspaceStore
  /** 启动期的 SQLite 播种与配置落盘；最近工作区列表要等它完成 */
  waitForStartup?: () => Promise<void>
}

/** 最近工作区只列出仍然存在的目录：被删除或移走的目录不再出现在任何入口里 */
async function filterExistingDirectories(candidates: string[]): Promise<string[]> {
  const checks = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return (await fs.stat(candidate)).isDirectory() ? candidate : null
      } catch {
        return null
      }
    })
  )
  return checks.filter((candidate): candidate is string => candidate !== null)
}

export function registerWorkspaceIpc(context: WorkspaceIpcContext): void {
  const mainWindow = () => context.getMainWindow()

  handleIpc('dialog:openDirectory', async () => {
    const win = mainWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })

    const picked = result.filePaths[0]
    if (result.canceled || !picked) {
      return { success: true, canceled: true }
    }

    // 只有用户通过原生对话框明确选择的目录才会被批准为工作区
    const trusted = trustWorkspace(picked)
    if (!trusted) {
      return {
        success: false,
        canceled: false,
        error: 'Selected directory could not be approved as a workspace',
      }
    }

    return { success: true, canceled: false, path: trusted }
  })

  // 工作区文件监听（递归，忽略依赖/构建/应用数据目录）
  handleIpc('fs:watch', async (event, workspacePath: string) => {
    try {
      // 允许监听受信任根内的子目录（会话绑定的 Git 工作树），否则工作树里的改动到不了渲染层
      const trustedWorkspace = resolveWatchableRoot(workspacePath)
      if (!trustedWorkspace) {
        return { success: false, error: 'Workspace is not approved' }
      }

      const key = workspaceWatchKey(trustedWorkspace)
      // 同一工作区重复 watch 时先替换旧监听，其他工作区不受影响
      const previous = workspaceWatchers.get(key)
      if (previous) {
        previous.batcher.cancel()
        previous.watcher.close()
        workspaceWatchers.delete(key)
      }

      const sender = event.sender
      const batcher = new WatchBatcher((changes) => {
        if (sender.isDestroyed()) return
        for (const change of changes) {
          sender.send('fs:changed', change)
        }
      })

      const watcher = watch(trustedWorkspace, { recursive: true }, (eventType, filename) => {
        if (!filename || isIgnoredWatchPath(filename)) return
        const fullPath = path.join(trustedWorkspace, filename)
        const changeKey = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath
        batcher.add({ type: eventType, path: fullPath }, changeKey)
      })

      watcher.on('error', (error) => {
        console.error('[Main] Workspace watcher error:', error)
      })

      workspaceWatchers.set(key, { watcher, batcher })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('fs:unwatch', async (_event, workspacePath?: string) => {
    try {
      if (workspacePath) {
        closeWorkspaceWatcher(workspacePath)
      } else {
        closeAllWorkspaceWatchers()
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('app:getRecentWorkspaces', async () => {
    try {
      await context.waitForStartup?.()
      const recent = context.workspaceStore
        .listRecent(30)
        .filter((workspacePath) => isTrustedWorkspacePath(workspacePath))
      // 先过滤失效目录再截断，否则死条目会占掉 10 条名额
      const workspaces = (await filterExistingDirectories(recent)).slice(0, 10)
      return { success: true, workspaces }
    } catch (error) {
      return {
        success: false,
        workspaces: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  handleIpc('app:addRecentWorkspace', async (_event, workspacePath: string) => {
    try {
      if (!isTrustedWorkspacePath(workspacePath)) {
        return { success: false, workspaces: [], error: 'Workspace is not approved' }
      }
      context.workspaceStore.recordOpen(workspacePath)
      const recent = context.workspaceStore
        .listRecent(10)
        .filter((item) => isTrustedWorkspacePath(item))
      const workspaces = await filterExistingDirectories(recent)
      return { success: true, workspaces }
    } catch (error) {
      return {
        success: false,
        workspaces: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  // 工作区配置管理
  handleIpc('workspace:init', async (_event, workspacePath: string) => {
    try {
      // 工作区根必须由主进程批准（目录选择器或启动时的最近工作区）
      if (!isTrustedWorkspacePath(workspacePath)) {
        return {
          success: false,
          error: 'Workspace is not approved. Open it with the Open Project dialog.',
        }
      }

      const configDir = path.join(workspacePath, '.pi-workbench')
      const pluginsDir = path.join(configDir, 'plugins')

      await fs.mkdir(configDir, { recursive: true })
      await fs.mkdir(pluginsDir, { recursive: true })

      const configPath = path.join(configDir, 'config.json')
      if (!existsSync(configPath)) {
        await writeJsonAtomic(configPath, {
          version: '1.0',
          enabledPlugins: [],
        })
      }

      context.pluginManager.loadWorkspace(workspacePath)
      await context.pluginManager.emit(workspacePath, 'workspace:opened', {
        workspaceDir: workspacePath,
      })

      // Git 仓库：开始本地监听与定时 fetch（非 git 仓库自动跳过）。
      // 这里等探测完成，避免工作区刚打开就被关闭时仍有 git 进程占用目录。
      try {
        await repoSync.ensure(workspacePath)
      } catch (error) {
        console.warn('[Workspace] Failed to start repo sync:', error)
      }

      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 关闭工作区标签时释放该工作区的主进程资源（插件、监听）
  handleIpc('workspace:dispose', async (_event, workspacePath: string) => {
    try {
      if (!isTrustedWorkspacePath(workspacePath)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      closeWorkspaceWatcher(workspacePath)
      context.terminalManager.closeWorkspace(canonicalizePath(workspacePath) ?? workspacePath)
      context.pluginManager.unload(workspacePath)
      disposeCoordinator(workspacePath)
      repoSync.detachWorkspace(workspacePath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 编辑器标签固定状态（按工作区）：显式关闭后保留，重新打开该工作区时恢复
  handleIpc('workspace:editorTabs:get', async (_event, workspaceDir: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const workspaceRoot = canonicalizePath(workspaceDir)
      if (!workspaceRoot) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const file = path.join(workspaceRoot, '.pi-workbench', 'editor-tabs.json')
      const result = readJsonWithBackup<{
        open?: unknown
        active?: unknown
        root?: unknown
      }>(file)
      if (!result.data) {
        return { success: true, tabs: { open: [], active: null } }
      }
      const rawOpen = Array.isArray(result.data.open)
        ? result.data.open.filter((item): item is string => typeof item === 'string').slice(0, 50)
        : []
      const open: string[] = []
      for (const relative of rawOpen) {
        const target = canonicalizePath(path.resolve(workspaceRoot, relative))
        if (target && isPathInsideRoot(workspaceRoot, target) && !open.includes(target)) {
          open.push(target)
        }
      }
      const activeRelative = typeof result.data.active === 'string' ? result.data.active : null
      const activeTarget = activeRelative
        ? canonicalizePath(path.resolve(workspaceRoot, activeRelative))
        : null
      const active =
        activeTarget && open.includes(activeTarget) ? activeTarget : open[open.length - 1] ?? null
      const rawRoot = typeof result.data.root === 'string' ? result.data.root : null
      const rootTarget = rawRoot ? canonicalizePath(rawRoot) : null
      const root =
        rootTarget && isPathInsideRoot(workspaceRoot, rootTarget) ? rootTarget : undefined
      return { success: true, tabs: { open, active, root } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc(
    'workspace:editorTabs:set',
    async (
      _event,
      workspaceDir: string,
      tabs: { open?: unknown; active?: unknown; root?: unknown }
    ) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        const workspaceRoot = canonicalizePath(workspaceDir)
        if (!workspaceRoot) {
          return { success: false, error: 'Workspace is not approved' }
        }
        const rawOpen = Array.isArray(tabs?.open) ? tabs.open : []
        const open: string[] = []
        for (const candidate of rawOpen) {
          if (typeof candidate !== 'string' || !candidate) continue
          const target = canonicalizePath(candidate)
          if (!target || !isPathInsideRoot(workspaceRoot, target)) continue
          const relative = path.relative(workspaceRoot, target).split(path.sep).join('/')
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
          if (!open.includes(relative)) open.push(relative)
          if (open.length >= 50) break
        }
        const rawActive = typeof tabs?.active === 'string' ? tabs.active : null
        let active: string | null = null
        if (rawActive) {
          const target = canonicalizePath(rawActive)
          if (target && isPathInsideRoot(workspaceRoot, target)) {
            const relative = path.relative(workspaceRoot, target).split(path.sep).join('/')
            if (open.includes(relative)) active = relative
          }
        }
        const dir = path.join(workspaceRoot, '.pi-workbench')
        await fs.mkdir(dir, { recursive: true })
        const rawRoot = typeof tabs?.root === 'string' ? tabs.root : null
        const rootTarget = rawRoot ? canonicalizePath(rawRoot) : null
        const root =
          rootTarget && isPathInsideRoot(workspaceRoot, rootTarget) ? rootTarget : null
        await writeJsonAtomic(path.join(dir, 'editor-tabs.json'), {
          version: 1,
          open,
          active,
          root,
        })
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
