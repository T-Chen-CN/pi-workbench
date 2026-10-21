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

export interface WorktreeFileChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
  oldContent: string
  newContent: string
  binary?: boolean
  truncated?: boolean
}

export interface WorktreeDiffResult {
  success: boolean
  files?: WorktreeFileChange[]
  error?: string
  truncated?: boolean
}

export interface WorktreeCommitResult {
  success: boolean
  committed?: boolean
  commit?: string
  error?: string
}

export interface WorktreeMergeResult {
  success: boolean
  merged?: boolean
  committed?: boolean
  commit?: string
  conflictFiles?: string[]
  error?: string
}

/** 单次差异读取的上限，避免大仓库把主进程内存打满 */
const MAX_DIFF_FILES = 200
const MAX_FILE_BYTES = 1_000_000
const MAX_TOTAL_BYTES = 8_000_000

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

  /** 确认 worktree 位于工作区的 .pi-worktrees 下，避免对任意路径执行 git 操作 */
  private isManagedWorktree(workspaceDir: string, worktree: string): boolean {
    const root = path.resolve(workspaceDir, '.pi-worktrees')
    const target = path.resolve(worktree)
    const relative = path.relative(root, target)
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
  }

  private readWorktreeFile(
    worktree: string,
    relativePath: string
  ): { content: string; binary: boolean; truncated: boolean } {
    const target = path.resolve(worktree, relativePath)
    const relativeToRoot = path.relative(path.resolve(worktree), target)
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      return { content: '', binary: false, truncated: false }
    }

    try {
      const stats = fs.statSync(target)
      if (!stats.isFile()) return { content: '', binary: false, truncated: false }

      const truncated = stats.size > MAX_FILE_BYTES
      const length = Math.min(stats.size, MAX_FILE_BYTES)
      const buffer = Buffer.alloc(length)
      const fd = fs.openSync(target, 'r')
      try {
        fs.readSync(fd, buffer, 0, length, 0)
      } finally {
        fs.closeSync(fd)
      }
      const binary = buffer.includes(0)
      return {
        // 统一成 LF，避免 Windows 检出时的 CRLF 让整份文件都显示为改动
        content: binary ? '' : buffer.toString('utf-8').replace(/\r\n/g, '\n'),
        binary,
        truncated,
      }
    } catch {
      return { content: '', binary: false, truncated: false }
    }
  }

  private async readHeadFile(
    worktree: string,
    ref: string,
    relativePath: string
  ): Promise<{ content: string; truncated: boolean }> {
    try {
      const { stdout } = await this.exec('git', ['show', `${ref}:${relativePath}`], {
        cwd: worktree,
        maxBuffer: MAX_FILE_BYTES * 4,
        timeout: 30_000,
      })
      const truncated = stdout.length > MAX_FILE_BYTES
      return {
        content: stdout.slice(0, MAX_FILE_BYTES).replace(/\r\n/g, '\n'),
        truncated,
      }
    } catch {
      return { content: '', truncated: true }
    }
  }

  /** 列出 worktree 相对创建时 HEAD 的全部改动（含未跟踪文件） */
  async diff(workspaceDir: string, worktree: string): Promise<WorktreeDiffResult> {
    if (!this.isManagedWorktree(workspaceDir, worktree)) {
      return { success: false, error: 'Worktree is outside .pi-worktrees' }
    }
    if (!fs.existsSync(worktree)) {
      return { success: false, error: 'Worktree no longer exists' }
    }

    // 任务分支可能已有 Agent 自己产生的提交：以任务基点（与工作区 HEAD 的 merge-base）比较
    const workspaceHead = await this.git(workspaceDir, ['rev-parse', 'HEAD'])
    let baseRef = 'HEAD'
    if (workspaceHead.success && workspaceHead.output) {
      const mergeBase = await this.git(worktree, ['merge-base', 'HEAD', workspaceHead.output])
      if (mergeBase.success && mergeBase.output) baseRef = mergeBase.output
    }

    const tracked = await this.git(worktree, ['diff', '--name-status', baseRef])
    if (!tracked.success) {
      return { success: false, error: tracked.error || 'Failed to read worktree changes' }
    }
    const untracked = await this.git(worktree, ['ls-files', '--others', '--exclude-standard'])
    if (!untracked.success) {
      return { success: false, error: untracked.error || 'Failed to list untracked files' }
    }

    const changed = new Map<
      string,
      { path: string; status: WorktreeFileChange['status']; oldPath?: string }
    >()

    for (const line of (tracked.output || '').split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      const code = parts[0] || ''
      let filePath = parts[1] || ''
      let oldPath: string | undefined
      let status: WorktreeFileChange['status'] = 'modified'

      if (code.startsWith('R')) {
        oldPath = parts[1]
        filePath = parts[2] || parts[1] || ''
      } else if (code.startsWith('A')) {
        status = 'added'
      } else if (code.startsWith('D')) {
        status = 'deleted'
      }

      if (!filePath) continue
      if (filePath.startsWith('.pi-workbench/') || filePath.startsWith('.pi-worktrees/')) continue
      changed.set(filePath, { path: filePath, status, oldPath })
    }

    for (const filePath of (untracked.output || '').split('\n')) {
      if (!filePath.trim()) continue
      if (filePath.startsWith('.pi-workbench/') || filePath.startsWith('.pi-worktrees/')) continue
      if (!changed.has(filePath)) changed.set(filePath, { path: filePath, status: 'added' })
    }

    const files: WorktreeFileChange[] = []
    let totalBytes = 0
    let truncatedList = false

    for (const entry of [...changed.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      if (files.length >= MAX_DIFF_FILES) {
        truncatedList = true
        break
      }

      const current = entry.status === 'deleted'
        ? { content: '', binary: false, truncated: false }
        : this.readWorktreeFile(worktree, entry.path)
      const previous = entry.status === 'added'
        ? { content: '', truncated: false }
        : await this.readHeadFile(worktree, baseRef, entry.oldPath ?? entry.path)

      totalBytes += current.content.length + previous.content.length
      if (totalBytes > MAX_TOTAL_BYTES) {
        truncatedList = true
        break
      }

      files.push({
        path: entry.path,
        status: entry.status,
        oldContent: previous.content,
        newContent: current.content,
        binary: current.binary,
        truncated: current.truncated || previous.truncated,
      })
    }

    return { success: true, files, truncated: truncatedList }
  }

  /** 在 worktree 内提交 Agent 的全部改动 */
  async commit(
    workspaceDir: string,
    worktree: string,
    message: string
  ): Promise<WorktreeCommitResult> {
    if (!this.isManagedWorktree(workspaceDir, worktree)) {
      return { success: false, error: 'Worktree is outside .pi-worktrees' }
    }
    if (!fs.existsSync(worktree)) {
      return { success: false, error: 'Worktree no longer exists' }
    }

    const added = await this.git(worktree, ['add', '-A'])
    if (!added.success) {
      return { success: false, error: added.error || 'Failed to stage worktree changes' }
    }

    const status = await this.git(worktree, ['status', '--porcelain'])
    if (!status.success) {
      return { success: false, error: status.error || 'Failed to inspect worktree status' }
    }
    if (!status.output) {
      return { success: true, committed: false }
    }

    const commit = await this.git(worktree, [
      '-c',
      'user.name=Pi Workbench',
      '-c',
      'user.email=pi-workbench@local',
      'commit',
      '-m',
      message,
    ])
    if (!commit.success) {
      return { success: false, error: commit.error || 'Failed to commit worktree changes' }
    }

    const hash = await this.git(worktree, ['rev-parse', '--short', 'HEAD'])
    return { success: true, committed: true, commit: hash.output }
  }

  /**
   * 先把 worktree 的改动提交到 pi-fleet 分支，再合并回工作区当前分支。
   * 合并前要求工作区没有未提交的改动；冲突时自动 abort 并返回冲突文件。
   */
  async merge(
    workspaceDir: string,
    worktree: string,
    branch: string,
    message: string
  ): Promise<WorktreeMergeResult> {
    if (!this.isManagedWorktree(workspaceDir, worktree)) {
      return { success: false, error: 'Worktree is outside .pi-worktrees' }
    }
    if (!branch.startsWith('pi-fleet/')) {
      return { success: false, error: 'Refusing to merge a branch outside pi-fleet/' }
    }
    if (!fs.existsSync(worktree)) {
      return { success: false, error: 'Worktree no longer exists' }
    }

    const trackedStatus = await this.git(workspaceDir, ['status', '--porcelain', '--untracked-files=no'])
    if (!trackedStatus.success) {
      return { success: false, error: trackedStatus.error || 'Failed to inspect workspace status' }
    }
    if (trackedStatus.output) {
      return {
        success: false,
        error: 'Workspace has uncommitted changes. Commit or stash them before merging.',
      }
    }

    const untracked = await this.git(workspaceDir, ['ls-files', '--others', '--exclude-standard'])
    if (!untracked.success) {
      return { success: false, error: untracked.error || 'Failed to inspect untracked files' }
    }
    const dirtyUntracked = (untracked.output || '')
      .split('\n')
      .filter(
        (filePath) =>
          filePath &&
          !filePath.startsWith('.pi-worktrees/') &&
          !filePath.startsWith('.pi-workbench/')
      )
    if (dirtyUntracked.length > 0) {
      return {
        success: false,
        error: 'Workspace has untracked files. Commit or remove them before merging.',
      }
    }

    const committed = await this.commit(workspaceDir, worktree, message)
    if (!committed.success) {
      return { success: false, error: committed.error }
    }

    const mergeResult = await this.git(workspaceDir, [
      'merge',
      '--no-ff',
      '-m',
      message,
      branch,
    ])

    if (!mergeResult.success) {
      const conflicts = await this.git(workspaceDir, ['diff', '--name-only', '--diff-filter=U'])
      await this.git(workspaceDir, ['merge', '--abort'])
      return {
        success: false,
        error: mergeResult.error || 'Merge failed',
        conflictFiles: (conflicts.output || '').split('\n').filter(Boolean),
        committed: committed.committed,
        commit: committed.commit,
      }
    }

    return {
      success: true,
      merged: true,
      committed: committed.committed,
      commit: committed.commit,
    }
  }
}
