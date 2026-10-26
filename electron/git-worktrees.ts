/**
 * Git 工作树层：在主进程用系统 git 执行只读查询与工作树操作。
 *
 * 约定：
 * - 只接受受信任工作区内的路径；工作树统一放在 {workspace}/.pi-workbench/worktrees 下。
 * - 所有命令通过 execFile 传参数组，不拼接 shell 字符串。
 * - 应用不缓存 git 状态，调用方按需重新查询。
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs/promises'
import { existsSync } from 'fs'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-json.js'
import { canonicalizePath, isPathInsideRoot } from './workspace-trust.js'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000
const MAX_BUFFER = 32 * 1024 * 1024

export const MAIN_WORKTREE_KEY = 'main'
export const WORKTREE_DIR = '.pi-workbench/worktrees'

export interface GitCommandResult {
  ok: boolean
  stdout: string
  stderr: string
}

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
    })
    return { ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
  } catch (error) {
    const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown }
    return {
      ok: false,
      stdout: typeof value.stdout === 'string' ? value.stdout : '',
      stderr:
        typeof value.stderr === 'string' && value.stderr
          ? value.stderr
          : typeof value.message === 'string'
            ? value.message
            : String(error),
    }
  }
}

export interface GithubRepoRef {
  owner: string
  repo: string
}

export interface GitRepoInfo {
  root: string
  gitDir: string
  commonDir: string
  bare: boolean
  linkedWorktree: boolean
  branch: string | null
  head: string | null
  detached: boolean
  remoteUrl: string | null
  github: GithubRepoRef | null
}

export interface GitWorktreeInfo {
  path: string
  head: string | null
  branch: string | null
  bare: boolean
  detached: boolean
  locked: boolean
  prunable: boolean
  isMain: boolean
}

export interface GitBranchInfo {
  name: string
  fullName: string
  sha: string
  upstream: string | null
  current: boolean
  remote: boolean
}

export interface GitStatusFile {
  status: string
  path: string
}

export interface GitStatusInfo {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
  clean: boolean
  files: GitStatusFile[]
}

export interface GitCommitInfo {
  sha: string
  shortSha: string
  author: string
  email: string
  date: string
  subject: string
  refs: string
  parents: string[]
}

export interface GitCommitFile {
  status: string
  path: string
}

export interface GitCommitDetail {
  commit: GitCommitInfo
  /** 提交信息中标题之后的正文（%b），可能为空 */
  body: string
  files: GitCommitFile[]
  patch: string
  truncated: boolean
}

export interface GitWorktreeRecord {
  /** 相对工作区根的路径；主工作树不写记录 */
  path: string
  managed: boolean
  branch: string
  base: string
  createdBySession: string
  createdAt: string
  installedLockfileHash?: string | null
}

export interface SessionGitFile {
  version: 1
  worktrees: Record<string, GitWorktreeRecord>
  sessions: Record<string, { worktree: string }>
}

function emptySessionGit(): SessionGitFile {
  return { version: 1, worktrees: {}, sessions: {} }
}

export function sessionGitPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.pi-workbench', 'session-git.json')
}

export function loadSessionGit(workspaceDir: string): SessionGitFile {
  const file = sessionGitPath(workspaceDir)
  const result = readJsonWithBackup<Partial<SessionGitFile>>(file)
  const raw = result.data
  if (!raw || typeof raw !== 'object') return emptySessionGit()
  const worktrees: Record<string, GitWorktreeRecord> = {}
  if (raw.worktrees && typeof raw.worktrees === 'object') {
    for (const [id, value] of Object.entries(raw.worktrees)) {
      if (!value || typeof value !== 'object') continue
      const record = value as Partial<GitWorktreeRecord>
      if (typeof record.path !== 'string' || !record.path) continue
      worktrees[id] = {
        path: record.path,
        managed: record.managed === true,
        branch: typeof record.branch === 'string' ? record.branch : '',
        base: typeof record.base === 'string' ? record.base : '',
        createdBySession:
          typeof record.createdBySession === 'string' ? record.createdBySession : '',
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
        installedLockfileHash:
          typeof record.installedLockfileHash === 'string'
            ? record.installedLockfileHash
            : null,
      }
    }
  }
  const sessions: Record<string, { worktree: string }> = {}
  if (raw.sessions && typeof raw.sessions === 'object') {
    for (const [sessionId, value] of Object.entries(raw.sessions)) {
      if (!value || typeof value !== 'object') continue
      const key = (value as { worktree?: unknown }).worktree
      if (typeof key === 'string' && key) sessions[sessionId] = { worktree: key }
    }
  }
  return { version: 1, worktrees, sessions }
}

export async function saveSessionGit(
  workspaceDir: string,
  data: SessionGitFile
): Promise<void> {
  await fs.mkdir(path.join(workspaceDir, '.pi-workbench'), { recursive: true })
  await writeJsonAtomic(sessionGitPath(workspaceDir), data)
}

export async function getRepoInfo(workspaceDir: string): Promise<GitRepoInfo | null> {
  const inside = await git(workspaceDir, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') return null

  const rootResult = await git(workspaceDir, ['rev-parse', '--show-toplevel'])
  if (!rootResult.ok) return null
  const root = canonicalizePath(rootResult.stdout.trim())
  if (!root) return null

  const gitDirResult = await git(root, ['rev-parse', '--absolute-git-dir'])
  const commonDirResult = await git(root, ['rev-parse', '--git-common-dir'])
  const bareResult = await git(root, ['rev-parse', '--is-bare-repository'])
  const branchResult = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const headResult = await git(root, ['rev-parse', 'HEAD'])
  const remoteResult = await git(root, ['remote', 'get-url', 'origin'])

  const gitDir = gitDirResult.ok ? canonicalizePath(gitDirResult.stdout.trim()) : null
  const commonDirRaw = commonDirResult.ok ? commonDirResult.stdout.trim() : ''
  const commonDir = commonDirRaw
    ? canonicalizePath(path.isAbsolute(commonDirRaw) ? commonDirRaw : path.join(root, commonDirRaw))
    : null
  const bare = bareResult.ok && bareResult.stdout.trim() === 'true'
  const branch = branchResult.ok && branchResult.stdout.trim() ? branchResult.stdout.trim() : null
  const head = headResult.ok && headResult.stdout.trim() ? headResult.stdout.trim() : null
  const remoteUrl = remoteResult.ok && remoteResult.stdout.trim() ? remoteResult.stdout.trim() : null
  const linkedWorktree = Boolean(gitDir && commonDir && gitDir !== commonDir)

  return {
    root,
    gitDir: gitDir ?? '',
    commonDir: commonDir ?? '',
    bare,
    linkedWorktree,
    branch,
    head,
    detached: !branch && Boolean(head),
    remoteUrl,
    github: parseGithubRemote(remoteUrl),
  }
}

export function parseGithubRemote(remoteUrl: string | null): GithubRepoRef | null {
  if (!remoteUrl) return null
  const match = remoteUrl.match(
    /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[/\s]|$)/i
  )
  if (!match) return null
  return { owner: match[1], repo: match[2] }
}

export async function listWorktrees(repoRoot: string): Promise<GitWorktreeInfo[]> {
  const result = await git(repoRoot, ['worktree', 'list', '--porcelain'])
  if (!result.ok) return []
  const blocks = result.stdout.split(/\r?\n\r?\n/).map((block) => block.trim()).filter(Boolean)
  const entries: GitWorktreeInfo[] = []
  for (const block of blocks) {
    const info: GitWorktreeInfo = {
      path: '',
      head: null,
      branch: null,
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
      isMain: false,
    }
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) info.path = line.slice('worktree '.length).trim()
      else if (line.startsWith('HEAD ')) info.head = line.slice('HEAD '.length).trim()
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim()
        info.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
      } else if (line === 'bare') info.bare = true
      else if (line === 'detached') info.detached = true
      else if (line === 'locked' || line.startsWith('locked ')) info.locked = true
      else if (line === 'prunable' || line.startsWith('prunable ')) info.prunable = true
    }
    if (info.path) {
      info.path = canonicalizePath(info.path) ?? info.path
      entries.push(info)
    }
  }
  const main = entries.find((entry) => !entry.bare) ?? entries[0]
  if (main) main.isMain = true
  return entries
}

export async function listBranches(repoRoot: string): Promise<GitBranchInfo[]> {
  const format = [
    '%(refname)',
    '%(refname:short)',
    '%(objectname)',
    '%(upstream:short)',
    '%(HEAD)',
  ].join('%00')
  const result = await git(repoRoot, [
    'for-each-ref',
    `--format=${format}`,
    'refs/heads',
    'refs/remotes',
  ])
  if (!result.ok) return []
  const currentResult = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const current = currentResult.ok ? currentResult.stdout.trim() : ''
  const branches: GitBranchInfo[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [fullName, name, sha, upstream, headMark] = line.split('\u0000')
    if (!fullName || !name) continue
    if (fullName.endsWith('/HEAD')) continue
    const remote = fullName.startsWith('refs/remotes/')
    branches.push({
      name,
      fullName,
      sha: (sha ?? '').slice(0, 12),
      upstream: upstream || null,
      current: headMark === '*' || name === current,
      remote,
    })
  }
  return branches.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    if (a.remote !== b.remote) return a.remote ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}

export async function getStatus(worktreePath: string): Promise<GitStatusInfo> {
  const result = await git(worktreePath, ['status', '--porcelain=v1', '-b', '-uall'])
  const status: GitStatusInfo = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    clean: true,
    files: [],
  }
  if (!result.ok) return status
  const lines = result.stdout.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line) continue
    if (index === 0 && line.startsWith('## ')) {
      parseStatusHeader(line.slice(3), status)
      continue
    }
    if (line.length < 3) continue
    const code = line.slice(0, 2)
    let filePath = line.slice(3).trim()
    const renamed = filePath.indexOf(' -> ')
    if (renamed >= 0 && (code.includes('R') || code.includes('C'))) {
      filePath = filePath.slice(renamed + 4).trim()
    }
    if (filePath) status.files.push({ status: code.trim() || '?', path: filePath })
  }
  status.clean = status.files.length === 0
  return status
}

function parseStatusHeader(header: string, status: GitStatusInfo): void {
  if (header.startsWith('HEAD (no branch)') || header === 'HEAD') {
    status.detached = true
    return
  }
  const bracket = header.indexOf(' [')
  const main = bracket >= 0 ? header.slice(0, bracket) : header
  const meta = bracket >= 0 ? header.slice(bracket + 2, -1) : ''
  const dots = main.indexOf('...')
  status.branch = dots >= 0 ? main.slice(0, dots) : main.replace(/^No commits yet on /, '')
  status.upstream = dots >= 0 ? main.slice(dots + 3) : null
  const ahead = meta.match(/ahead (\d+)/)
  const behind = meta.match(/behind (\d+)/)
  status.ahead = ahead ? Number(ahead[1]) : 0
  status.behind = behind ? Number(behind[1]) : 0
}

export async function createWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  base: string
): Promise<void> {
  await fs.mkdir(path.dirname(worktreePath), { recursive: true })
  const add = await git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, base])
  if (!add.ok) {
    // 分支已存在时退化为直接检出该分支
    const fallback = await git(repoRoot, ['worktree', 'add', worktreePath, branch])
    if (!fallback.ok) {
      throw new Error(fallback.stderr.trim() || add.stderr.trim() || 'git worktree add failed')
    }
  }
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  const result = await git(repoRoot, ['worktree', 'remove', worktreePath])
  if (!result.ok) throw new Error(result.stderr.trim() || 'git worktree remove failed')
  await git(repoRoot, ['worktree', 'prune'])
}

export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await git(repoRoot, ['worktree', 'prune'])
}

export async function branchHasNewCommits(
  repoRoot: string,
  branch: string,
  base: string
): Promise<boolean> {
  if (!branch || !base) return false
  const result = await git(repoRoot, ['rev-list', '--count', `${base}..${branch}`])
  return result.ok && Number(result.stdout.trim()) > 0
}

export async function deleteBranch(repoRoot: string, branch: string): Promise<void> {
  if (!branch || branch === 'main' || branch === 'master') return
  await git(repoRoot, ['branch', '-D', branch])
}

export async function checkout(worktreePath: string, branch: string): Promise<void> {
  const result = await git(worktreePath, ['checkout', branch])
  if (!result.ok) throw new Error(result.stderr.trim() || 'git checkout failed')
}

export async function mergeBranch(
  worktreePath: string,
  branch: string,
  strategy: 'merge' | 'squash' | 'rebase' = 'merge'
): Promise<void> {
  const args =
    strategy === 'squash'
      ? ['merge', '--squash', branch]
      : strategy === 'rebase'
        ? ['rebase', branch]
        : ['merge', '--no-ff', branch]
  const result = await git(worktreePath, args)
  if (!result.ok) throw new Error(result.stderr.trim() || 'git merge failed')
}

export async function logCommits(
  worktreePath: string,
  limit = 80,
  branch?: string
): Promise<GitCommitInfo[]> {
  const format = ['%H', '%h', '%an', '%ae', '%aI', '%s', '%D', '%P'].join('%x00')
  const args = ['log', `--format=${format}`, '-n', String(Math.max(1, Math.min(500, limit)))]
  if (branch) args.push(branch)
  const result = await git(worktreePath, args)
  if (!result.ok) return []
  const commits: GitCommitInfo[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [sha, shortSha, author, email, date, subject, refs, parents] =
      line.split('\u0000')
    if (!sha) continue
    commits.push({
      sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      author: author ?? '',
      email: email ?? '',
      date: date ?? '',
      subject: subject ?? '',
      refs: refs ?? '',
      parents: (parents ?? '').split(/\s+/).filter(Boolean),
    })
  }
  return commits
}

export async function commitDetail(
  worktreePath: string,
  sha: string
): Promise<GitCommitDetail | null> {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return null
  const format = ['%H', '%h', '%an', '%ae', '%aI', '%s', '%D', '%P', '%b'].join('%x00')
  // 三条查询互不依赖，并行执行可省掉约一半的进程等待
  const [meta, filesResult, patchResult] = await Promise.all([
    git(worktreePath, ['show', '-s', `--format=${format}`, sha]),
    git(worktreePath, ['show', '--name-status', '--format=', sha]),
    git(worktreePath, ['show', '--format=', '--patch', '--no-ext-diff', sha]),
  ])
  if (!meta.ok) return null
  const fields = meta.stdout.split('\u0000')
  const [fullSha, shortSha, author, email, date, subject, refs, parents] = fields
  const body = (fields[8] ?? '').trim()
  const files: GitCommitFile[] = []
  if (filesResult.ok) {
    for (const line of filesResult.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      if (parts.length >= 2) files.push({ status: parts[0], path: parts[parts.length - 1] })
    }
  }
  const patch = patchResult.ok ? patchResult.stdout : ''
  const max = 400_000
  return {
    commit: {
      sha: fullSha ?? sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      author: author ?? '',
      email: email ?? '',
      date: date ?? '',
      subject: subject ?? '',
      refs: refs ?? '',
      parents: (parents ?? '').split(/\s+/).filter(Boolean),
    },
    body,
    files,
    patch: patch.length > max ? patch.slice(0, max) : patch,
    truncated: patch.length > max,
  }
}

export async function fileDiffBetween(
  worktreePath: string,
  from: string,
  to: string
): Promise<string> {
  const result = await git(worktreePath, ['diff', '--no-ext-diff', `${from}..${to}`])
  return result.ok ? result.stdout.slice(0, 400_000) : ''
}

export async function getLockfileHash(repoDir: string): Promise<string | null> {
  const candidates = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'uv.lock']
  for (const name of candidates) {
    const file = path.join(repoDir, name)
    if (!existsSync(file)) continue
    try {
      const content = await fs.readFile(file)
      const { createHash } = await import('crypto')
      return `${name}:${createHash('sha1').update(content).digest('hex')}`
    } catch {
      return null
    }
  }
  return null
}

export interface GithubPrStatus {
  available: boolean
  reason?: string
  pull?: {
    number: number
    title: string
    url: string
    state: string
    draft: boolean
  }
  checks?: {
    state: 'success' | 'failure' | 'pending' | 'none'
    total: number
    failing: string[]
  }
}

export async function fetchGithubStatus(
  repo: GithubRepoRef,
  sha: string,
  token: string | null
): Promise<GithubPrStatus> {
  if (!token) return { available: false, reason: 'GitHub token is not configured' }
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) return { available: false, reason: 'Invalid commit' }
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'pi-workbench',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  try {
    const pullsResponse = await fetch(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${sha}/pulls`,
      { headers, signal: AbortSignal.timeout(10_000) }
    )
    if (!pullsResponse.ok) {
      return { available: false, reason: `GitHub API ${pullsResponse.status}` }
    }
    const pulls = (await pullsResponse.json()) as Array<{
      number: number
      title: string
      html_url: string
      state: string
      draft?: boolean
    }>
    const pull = Array.isArray(pulls) ? pulls[0] : undefined

    let checks: GithubPrStatus['checks'] = { state: 'none', total: 0, failing: [] }
    const statusResponse = await fetch(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${sha}/status`,
      { headers, signal: AbortSignal.timeout(10_000) }
    )
    if (statusResponse.ok) {
      const body = (await statusResponse.json()) as {
        state?: string
        statuses?: Array<{ state?: string; context?: string }>
      }
      const list = Array.isArray(body.statuses) ? body.statuses : []
      const failing = list
        .filter((item) => item.state === 'failure' || item.state === 'error')
        .map((item) => item.context ?? 'check')
      const pending = list.some((item) => item.state === 'pending')
      const state =
        failing.length > 0
          ? 'failure'
          : pending
            ? 'pending'
            : list.length > 0
              ? 'success'
              : 'none'
      checks = { state, total: list.length, failing }
    }

    if (!pull) {
      return { available: true, checks }
    }
    return {
      available: true,
      pull: {
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
        state: pull.state,
        draft: Boolean(pull.draft),
      },
      checks,
    }
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function ensureWorktreeIgnored(repoRoot: string): Promise<void> {
  const excludeResult = await git(repoRoot, ['rev-parse', '--git-path', 'info/exclude'])
  if (!excludeResult.ok) return
  const raw = excludeResult.stdout.trim()
  if (!raw) return
  const excludeFile = path.isAbsolute(raw) ? raw : path.join(repoRoot, raw)
  await fs.mkdir(path.dirname(excludeFile), { recursive: true })
  let content = ''
  try {
    content = await fs.readFile(excludeFile, 'utf8')
  } catch {
    content = ''
  }
  const entries = content.split(/\r?\n/).map((line) => line.trim())
  if (entries.includes('.pi-workbench/')) return
  const next = `${content}${content && !content.endsWith('\n') ? '\n' : ''}.pi-workbench/\n`
  await fs.writeFile(excludeFile, next, 'utf8')
}

export function resolveWorktreePath(workspaceDir: string, worktreeId: string): string | null {
  const safeId = worktreeId.replace(/[^a-zA-Z0-9_-]/g, '')
  if (!safeId) return null
  const target = path.join(workspaceDir, WORKTREE_DIR, safeId)
  const canonical = canonicalizePath(target)
  if (!canonical) return null
  const root = canonicalizePath(workspaceDir)
  if (!root || !isPathInsideRoot(root, canonical)) return null
  return canonical
}

export function isPathInWorkspace(workspaceDir: string, target: string): boolean {
  const root = canonicalizePath(workspaceDir)
  const canonical = canonicalizePath(target)
  return Boolean(root && canonical && isPathInsideRoot(root, canonical))
}
