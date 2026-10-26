/** Git 工作树、分支、只读历史与 GitHub 状态的 IPC */

import { BrowserWindow } from 'electron'
import { handleIpc } from './register.js'
import { isTrustedWorkspacePath } from '../workspace-trust.js'
import type { AgentRegistry } from '../agent-registry.js'
import { getCoordinator } from '../worktree-coordinator.js'
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
  checkout,
  commitDetail,
  fetchGithubStatus,
  fileDiffBetween,
  getRepoInfo,
  getStatus,
  isPathInWorkspace,
  listBranches,
  listWorktrees,
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

export function registerGitIpc(context: GitIpcContext): void {
  const cleanedWorkspaces = new Set<string>()

  handleIpc('git:repoInfo', async (_event, workspaceDir: string) => {
    try {
      if (!isTrustedWorkspacePath(workspaceDir)) {
        return { success: false, error: 'Workspace is not approved' }
      }
      const repo = await getRepoInfo(workspaceDir)
      if (!repo) return { success: true, repo: null, worktrees: [] }
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
        const bound = await coordinator.bind(sessionId, target, base, sessionId)
        if (!bound.success || !bound.worktree) return bound
        const agent = context.agentRegistry.get(workspaceDir)
        const switched = agent?.requestSessionRoot
          ? await agent.requestSessionRoot(sessionId, bound.worktree.path)
          : { success: true as const, scheduled: false }
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
      if (!coordinator) return { success: true, removed: [], dirty: [], external: [] }
      return { success: true, ...(await coordinator.cleanupOrphans()) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('git:log', async (_event, workspaceDir: string, limit?: number, branch?: string) => {
    try {
      const root = await resolveRepoRoot(workspaceDir)
      if (!root) return { success: false, error: 'Not a git repository' }
      return {
        success: true,
        commits: await logCommits(root, limit ?? 80, branch),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

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
