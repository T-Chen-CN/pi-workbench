/** Git 工作树、分支、只读历史与 GitHub 状态的 IPC */

import { BrowserWindow } from 'electron'
import * as path from 'path'
import { handleIpc } from './register.js'
import { isTrustedWorkspacePath } from '../workspace-trust.js'
import type { AgentRegistry } from '../agent-registry.js'
import { configureWorktreeLogging, getCoordinator, type WorktreeCoordinator } from '../worktree-coordinator.js'
import { repoSync } from '../repo-sync.js'
import {
  clearGithubToken,
  fetchGithubUser,
  readGithubAuth,
  saveGithubToken,
} from '../github-auth.js'
import {
  readGithubOAuthConfig,
  startGithubOAuth,
} from '../github-oauth.js'
import {
  cancelGithubDeviceLogin,
  openGithubDeviceVerification,
  startGithubDeviceLogin,
} from '../github-device-login.js'
import {
  checkout,
  commitDetail,
  createBranch,
  fetchGithubStatus,
  fileDiffBetween,
  getRepoInfo,
  getStatus,
  isPathInWorkspace,
  listBranches,
  listWorktrees,
  logCommitStats,
  logCommits,
  mergeBranch,
  type GitRepoInfo,
} from '../git-worktrees.js'
import { cachedCommitDetail, cachedRepoRoot } from '../git-cache.js'

interface LoggerLike {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

export interface GitIpcContext {
  agentRegistry: AgentRegistry
  getMainWindow: () => BrowserWindow | null
  logger: LoggerLike
}

async function resolveRepo(workspaceDir: string): Promise<GitRepoInfo | null> {
  if (!isTrustedWorkspacePath(workspaceDir)) return null
  return getRepoInfo(workspaceDir)
}

/** 只读查询只需要仓库根：探测一次后复用，避免每次点击都重启 9 个 git 进程 */
async function resolveRepoRoot(workspaceDir: string): Promise<string | null> {
  if (!isTrustedWorkspacePath(workspaceDir)) return null
  return cachedRepoRoot(workspaceDir, async () => (await getRepoInfo(workspaceDir))?.root ?? null)
}

async function resolveWorktreePath(
  workspaceDir: string,
  requested?: string
): Promise<string | null> {
  if (!isTrustedWorkspacePath(workspaceDir)) return null
  if (!requested) return workspaceDir
  if (!isPathInWorkspace(workspaceDir, requested)) return null
  return requested
}

/** 把会话绑定改回切换之前的位置；未绑定过的会话直接解绑，不回退到主工作树 */
async function restoreWorktreeBinding(
  coordinator: WorktreeCoordinator,
  sessionId: string,
  wasBound: boolean,
  previousRoot: string
): Promise<void> {
  if (!wasBound) {
    await coordinator.unbind(sessionId)
    return
  }
  const target =
    path.resolve(previousRoot) === path.resolve(coordinator.repo.root) ? 'main' : previousRoot
  await coordinator.bind(sessionId, target)
}

export function registerGitIpc(context: GitIpcContext): void {
  const cleanedWorkspaces = new Set<string>()
  configureWorktreeLogging(context.logger)

  repoSync.configure({
    getMainWindow: context.getMainWindow,
    logger: context.logger,
  })

  handleIpc('git:repoInfo', async (_event, workspaceDir: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const repo = await getRepoInfo(workspaceDir)
      if (!repo) return { success: true, repo: null, worktrees: [] }
      // 打开面板 / 切换会话时补一次远端同步（受最小间隔限制）
      void repoSync.touch(workspaceDir).catch((error) =>
        context.logger.warn('[Git] Failed to start repo sync:', error)
      )
      const coordinator = await getCoordinator(workspaceDir)
      if (coordinator && !cleanedWorkspaces.has(coordinator.workspaceDir)) {
        cleanedWorkspaces.add(coordinator.workspaceDir)
        await coordinator
          .cleanupOrphans()
          .catch((error) =>
            context.logger.warn('[Git] Failed to clean orphan worktrees:', error)
          )
      }
      const worktrees = coordinator ? await coordinator.listWorktrees() : []
      return { success: true, repo, worktrees }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 远端同步：手动刷新传 force；面板打开用默认参数，受最小间隔与退避限制
  handleIpc(
    'git:fetch',
    async (_event, workspaceDir: string, options?: { force?: boolean }) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        return await repoSync.fetchNow(workspaceDir, {
          force: options?.force === true,
          // 面板打开等非手动触发保持静默；手动刷新允许系统凭据助手接管
          interactive: options?.force === true,
        })
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc(
    'git:listWorktrees',
    async (_event, workspaceDir: string, activeSessionId?: string) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        const coordinator = await getCoordinator(workspaceDir)
        if (!coordinator) return { success: true, worktrees: [] }
        return {
          success: true,
          worktrees: await coordinator.listWorktrees(activeSessionId ?? null),
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc(
    'git:forgetWorktree',
    async (_event, workspaceDir: string, id: string, activeSessionId?: string) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        if (typeof id !== 'string' || id === '') {
          return { success: false, error: 'Unknown worktree' }
        }
        const coordinator = await getCoordinator(workspaceDir)
        if (!coordinator) return { success: false, error: 'Not a git repository' }
        const result = await coordinator.forget(id, activeSessionId ?? null)
        if (result.success) context.logger.info('[Git] Forgot stale worktree record:', id)
        return result
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc('git:branches', async (_event, workspaceDir: string) => {
    try {
      const root = await resolveRepoRoot(workspaceDir)
      if (!root) return { success: false, error: 'Not a git repository' }
      return { success: true, branches: await listBranches(root) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('git:status', async (_event, workspaceDir: string, worktreePath?: string) => {
    try {
      const target = await resolveWorktreePath(workspaceDir, worktreePath)
      if (!target) return { success: false, error: 'Path is outside the workspace' }
      return { success: true, status: await getStatus(target) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('git:sessionBinding', async (_event, workspaceDir: string, sessionId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const coordinator = await getCoordinator(workspaceDir)
      if (!coordinator) return { success: false, error: 'Not a git repository' }
      const binding = coordinator.getSessionBinding(sessionId)
      return { success: true, binding }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc(
    'git:bindWorktree',
    async (
      _event,
      workspaceDir: string,
      sessionId: string,
      target: string,
      base?: string
    ) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir)) {
          return { success: false, error: 'Workspace is not approved' }
        }
        const coordinator = await getCoordinator(workspaceDir)
        if (!coordinator) return { success: false, error: 'Not a git repository' }
        const wasBound = coordinator.hasBinding(sessionId)
        const previousRoot = coordinator.getSessionRoot(sessionId)
        const bound = await coordinator.bind(sessionId, target, base, sessionId)
        if (!bound.success || !bound.worktree) return bound
        const agent = context.agentRegistry.get(workspaceDir)
        const switched = agent?.requestSessionRoot
          ? await agent.requestSessionRoot(sessionId, bound.worktree.path)
          : { success: true as const, scheduled: false }
        if (switched.success === false) {
          // 运行时没有换根：绑定回滚，避免文件视图落在新工作树而 Agent 仍在旧根
          try {
            await restoreWorktreeBinding(coordinator, sessionId, wasBound, previousRoot)
          } catch (error) {
            context.logger.warn('[Git] Failed to restore worktree binding:', error)
          }
          return {
            success: false,
            error: switched.error ?? 'Failed to switch the session worktree.',
          }
        }
        return {
          ...bound,
          switched,
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc('git:releaseSession', async (_event, workspaceDir: string, sessionId: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const coordinator = await getCoordinator(workspaceDir)
      if (!coordinator) return { success: true, removed: false, dirty: false }
      return await coordinator.release(sessionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('git:cleanupOrphans', async (_event, workspaceDir: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const coordinator = await getCoordinator(workspaceDir)
      if (!coordinator) return { success: true, removed: [], dirty: [], external: [], pruned: [] }
      const result = await coordinator.cleanupOrphans()
      if (result.pruned.length > 0) {
        context.logger.info('[Git] Pruned worktree records:', result.pruned.join(', '))
      }
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc(
    'git:log',
    async (_event, workspaceDir: string, limit?: number, branch?: string, all?: boolean) => {
      try {
        const root = await resolveRepoRoot(workspaceDir)
        if (!root) return { success: false, error: 'Not a git repository' }
        return {
          success: true,
          commits: await logCommits(root, limit ?? 80, branch, all === true),
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc(
    'git:commitStats',
    async (_event, workspaceDir: string, limit?: number, branch?: string, all?: boolean) => {
      try {
        const root = await resolveRepoRoot(workspaceDir)
        if (!root) return { success: false, error: 'Not a git repository' }
        return {
          success: true,
          stats: await logCommitStats(root, limit ?? 80, branch, all === true),
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc(
    'git:createBranch',
    async (_event, workspaceDir: string, sha: string, name: string) => {
      try {
        const root = await resolveRepoRoot(workspaceDir)
        if (!root) return { success: false, error: 'Not a git repository' }
        await createBranch(root, name, sha)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc('git:commitDetail', async (_event, workspaceDir: string, sha: string) => {
    try {
      const root = await resolveRepoRoot(workspaceDir)
      if (!root) return { success: false, error: 'Not a git repository' }
      const detail = await cachedCommitDetail(root, sha, () => commitDetail(root, sha))
      return detail
        ? { success: true, detail }
        : { success: false, error: 'Commit not found' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc(
    'git:diff',
    async (_event, workspaceDir: string, from: string, to: string) => {
      try {
        const root = await resolveRepoRoot(workspaceDir)
        if (!root) return { success: false, error: 'Not a git repository' }
        return { success: true, patch: await fileDiffBetween(root, from, to) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc(
    'git:checkout',
    async (_event, workspaceDir: string, worktreePath: string, branch: string) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir) || !isPathInWorkspace(workspaceDir, worktreePath)) {
          return { success: false, error: 'Path is outside the workspace' }
        }
        await checkout(worktreePath, branch)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc(
    'git:merge',
    async (
      _event,
      workspaceDir: string,
      worktreePath: string,
      branch: string,
      strategy?: 'merge' | 'squash' | 'rebase'
    ) => {
      try {
        if (!isTrustedWorkspacePath(workspaceDir) || !isPathInWorkspace(workspaceDir, worktreePath)) {
          return { success: false, error: 'Path is outside the workspace' }
        }
        await mergeBranch(worktreePath, branch, strategy ?? 'merge')
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc('git:githubTokenStatus', async () => {
    const { token } = await readGithubAuth()
    return { success: true, configured: Boolean(token) }
  })

  handleIpc('git:setGithubToken', async (_event, token: string) => {
    try {
      await saveGithubToken(typeof token === 'string' && token.trim() ? token.trim() : null)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // GitHub 授权码登录（设置页“关联 GitHub”）
  handleIpc('github:auth:config', async () => {
    const [config, auth] = await Promise.all([
      readGithubOAuthConfig(),
      readGithubAuth(),
    ])
    return {
      success: true,
      appConfigured: Boolean(config),
      linked: Boolean(auth.token),
    }
  })

  handleIpc('github:auth:start', async () => startGithubOAuth())

  // GitHub 设备码登录：clientId 内置，所有设备零配置
  handleIpc('github:auth:device:start', async () => {
    const window = context.getMainWindow()
    return startGithubDeviceLogin({
      onEvent: (event) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('github:auth:device:event', event)
        }
      },
      onComplete: (result) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('github:auth:complete', result)
        }
      },
    })
  })

  handleIpc('github:auth:device:cancel', async () => ({
    success: true,
    cancelled: cancelGithubDeviceLogin(),
  }))

  handleIpc('github:auth:device:open', async () => ({
    success: await openGithubDeviceVerification(),
  }))

  handleIpc('github:auth:status', async () => {
    try {
      const { token } = await readGithubAuth()
      if (!token) return { success: true, configured: false }
      const user = await fetchGithubUser(token)
      return { success: true, configured: true, user }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('github:auth:logout', async () => {
    try {
      cancelGithubDeviceLogin()
      await clearGithubToken()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('git:prStatus', async (_event, workspaceDir: string, worktreePath?: string) => {
    try {
      const repo = await resolveRepo(workspaceDir)
      if (!repo) return { success: false, error: 'Not a git repository' }
      let target = repo
      if (typeof worktreePath === 'string' && worktreePath) {
        if (!isPathInWorkspace(workspaceDir, worktreePath)) {
          return { success: false, error: 'Path is outside the workspace' }
        }
        const info = await getRepoInfo(worktreePath)
        if (!info) return { success: false, error: 'Not a git worktree' }
        target = info
      }
      if (!target.github || !target.head) {
        return { success: true, status: { available: false, reason: 'No GitHub remote' } }
      }
      const token = (await readGithubAuth()).token
      return {
        success: true,
        status: await fetchGithubStatus(target.github, target.head, token),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 供渲染层启动时清理无主托管工作树
  handleIpc('git:listAllWorktrees', async (_event, workspaceDir: string) => {
    try {
      const root = await resolveRepoRoot(workspaceDir)
      if (!root) return { success: true, worktrees: [] }
      return { success: true, worktrees: await listWorktrees(root) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
