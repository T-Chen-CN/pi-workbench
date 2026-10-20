/**
 * Fleet 的 Git worktree 管理。
 *
 * Worktree 固定放在 {workspace}/.pi-worktrees/{name}-{taskId}，
 * 分支名为 pi-fleet/{name}-{taskId}；清理时只移除 worktree，保留分支，
 * 避免误删 Agent 产生的提交。
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'

const execFileAsync = promisify(execFile)

export type GitRunner = (
  file: string,
  args: string[],
  options: { cwd: string; maxBuffer?: number; timeout?: number }
) => Promise<{ stdout: string; stderr: string }>

export interface WorktreeResult {
  success: boolean
  worktree?: string
  branch?: string
  error?: string
}

export interface CommandResult {
  success: boolean
  output?: string
  error?: string
}

/** 任务名只允许字母、数字、点、下划线和中划线 */
export function sanitizeTaskName(name: string): string | null {
  const trimmed = name.trim().replace(/\s+/g, '-')
  if (!trimmed || trimmed.length > 40) return null
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null
  if (trimmed.includes('..')) return null
  return trimmed
}

export class FleetWorktree {
  private readonly exec: GitRunner

  constructor(exec: GitRunner = execFileAsync as unknown as GitRunner) {
    this.exec = exec
  }

  private async git(cwd: string, args: string[]): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await this.exec('git', args, {
        cwd,
        maxBuffer: 4 * 1024 * 1024,
        // 仓库异常时 git 可能卡住，限制单条命令的执行时间
        timeout: 60_000,
      })
      return { success: true, output: (stdout || stderr || '').trim() }
    } catch (error) {
      const detail = error as { stderr?: string; stdout?: string; message?: string }
      return {
        success: false,
        output: `${detail.stdout || ''}${detail.stderr || ''}`.trim() || undefined,
        error: detail.stderr?.trim() || detail.message || String(error),
      }
    }
  }

  async isGitRepo(workspaceDir: string): Promise<boolean> {
    const result = await this.git(workspaceDir, ['rev-parse', '--is-inside-work-tree'])
    return result.success && result.output === 'true'
  }

  async create(workspaceDir: string, name: string, taskId: string): Promise<WorktreeResult> {
    const safeName = sanitizeTaskName(name)
    if (!safeName) {
      return {
        success: false,
        error: 'Task name may only contain letters, digits, dots, dashes and underscores',
      }
    }

    if (!(await this.isGitRepo(workspaceDir))) {
      return { success: false, error: 'Workspace is not a git repository' }
    }

    const base = `${safeName}-${taskId.slice(-6)}`
    const worktree = path.join(workspaceDir, '.pi-worktrees', base)
    const branch = `pi-fleet/${base}`

    if (fs.existsSync(worktree)) {
      return { success: false, error: `Worktree already exists: ${worktree}` }
    }

    try {
      fs.mkdirSync(path.dirname(worktree), { recursive: true })
    } catch (error) {
      return { success: false, error: `Failed to create worktree directory: ${String(error)}` }
    }

    const result = await this.git(workspaceDir, ['worktree', 'add', '-b', branch, worktree, 'HEAD'])
    if (!result.success) {
      return {
        success: false,
        error: `Failed to create worktree (the repository needs at least one commit): ${result.error}`,
      }
    }

    return { success: true, worktree, branch }
  }

  async cleanup(workspaceDir: string, worktree: string): Promise<CommandResult> {
    if (!worktree) return { success: true }

    const result = await this.git(workspaceDir, ['worktree', 'remove', '--force', worktree])
    if (!result.success) {
      // 目录被外部删除时由 prune 清理登记信息
      await this.git(workspaceDir, ['worktree', 'prune'])
      return { success: false, error: result.error }
    }
    return { success: true }
  }

  async list(workspaceDir: string): Promise<CommandResult> {
    return this.git(workspaceDir, ['worktree', 'list', '--porcelain'])
  }
}
