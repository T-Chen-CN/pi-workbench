/**
 * 仓库地图：把 Git 跟踪的文件整理成「文件 → 职责」的事实表，供工作区面板展示。
 *
 * 三条硬约束：
 * - **只读**：只在受信任工作区里读文件头，不写 Git（不动 index / .gitignore / info-exclude）；
 * - **离线**：不联网、不调模型，职责靠路径规则 + 文件首部注释 + 顶层导出符号推断；
 * - **增量**：按 `size + mtime` 指纹复用缓存，只有新增 / 改动的文件才重新读盘。
 *
 * 缓存落在 `{workspace}/.pi-workbench/repo-map.json`（工作区自己的运行期数据）。
 * 文案不落盘：缓存只存与语言无关的事实，渲染层按当前语言生成一句话。
 */

import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-json.js'
import { getRepoInfo } from './git-worktrees.js'
import { canonicalizePath, isPathInsideRoot } from './workspace-trust.js'

const execFileAsync = promisify(execFile)

/** 缓存结构版本：字段变化就自增，旧缓存整份丢弃重建 */
export const REPO_MAP_CACHE_VERSION = 3

/** 超过这个文件数不再全量生成描述，改为按需（展开目录 / 搜索命中）补齐 */
export const REPO_MAP_FULL_SCAN_LIMIT = 5000

/** 只读文件头这么多字节：注释与导出声明都在顶部，够用且对大文件无压力 */
const HEAD_BYTES = 4096

/** 首部注释压缩后的最大长度（事实层保留原话，渲染层再截断） */
const HEAD_COMMENT_MAX = 160

/** 每个文件最多保留几个导出名 */
const MAX_EXPORTS = 3

/** stat / 读盘并发：小仓库一次性铺开也不会打满句柄 */
const IO_CONCURRENCY = 32

const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024

/** 与界面分类标签一一对应（见 i18n 的 repoMapRole*） */
export type RepoMapRole =
  | 'component'
  | 'state'
  | 'ipc'
  | 'util'
  | 'type'
  | 'style'
  | 'test'
  | 'doc'
  | 'config'
  | 'asset'
  | 'other'

/** 缓存条目：与语言无关的事实 */
export interface RepoMapFacts {
  role: RepoMapRole
  binary: boolean
  size: number
  mtimeMs: number
  headComment?: string
  exports?: string[]
  symbol?: string
}

/** 返回给渲染层的条目：事实 + 相对路径 + 是否已生成描述 */
export interface RepoMapFile extends RepoMapFacts {
  /** 相对仓库根的 posix 路径 */
  path: string
  described: boolean
}

export interface RepoMapScanOptions {
  /** 忽略指纹缓存，全部重读（手动刷新用） */
  force?: boolean
  /** 需要确保已描述的路径（降级模式下展开目录 / 搜索命中时传入） */
  paths?: string[]
  /** 覆盖全量扫描上限（默认 REPO_MAP_FULL_SCAN_LIMIT，测试与将来的设置项用） */
  limit?: number
}

export interface RepoMapResult {
  success: boolean
  isRepo: boolean
  repoRoot?: string
  total: number
  described: number
  truncated: boolean
  files: RepoMapFile[]
  error?: string
}

interface RepoMapCacheFile {
  version: number
  repoRoot: string
  updatedAt: number
  files: Record<string, RepoMapFacts>
}

interface GitRunResult {
  ok: boolean
  stdout: string
  stderr: string
}

const ROLE_SET = new Set<string>([
  'component',
  'state',
  'ipc',
  'util',
  'type',
  'style',
  'test',
  'doc',
  'config',
  'asset',
  'other',
])

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

async function runGit(cwd: string, args: string[]): Promise<GitRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
    })
    return { ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
  } catch (error) {
    const value = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
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

/**
 * 路径 → 角色。纯规则，不读文件，因此降级模式下未描述的条目也有分类。
 * 顺序有意义：测试 / 文档 / 类型这些「位置或后缀更具体」的规则先命中。
 */
export function roleForPath(relPath: string): RepoMapRole {
  const posix = toPosix(relPath)
  const lower = posix.toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : ''

  if (
    /(^|\/)(tests?|__tests__|e2e)\//.test(lower) ||
    /\.(test|spec)\.[a-z0-9]+$/.test(base)
  ) {
    return 'test'
  }
  if (/(^|\/)docs?\//.test(lower) || ext === '.md' || ext === '.mdx' || ext === '.rst') {
    return 'doc'
  }
  if (base.endsWith('.d.ts') || /(^|\/)types?\//.test(lower)) return 'type'
  if (['.css', '.scss', '.sass', '.less'].includes(ext)) return 'style'
  if (
    ['package.json', 'package-lock.json', 'tsconfig.json'].includes(base) ||
    ['.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.env', '.lock'].includes(ext) ||
    base.startsWith('.') ||
    /(^|\/)(config|\.github|\.vscode|\.husky)\//.test(lower)
  ) {
    return 'config'
  }
  if (
    [
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
      '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.mp3', '.wav',
      '.pdf', '.zip', '.gz', '.wasm',
    ].includes(ext)
  ) {
    return 'asset'
  }
  if (/(^|\/)electron\//.test(lower)) return 'ipc'
  if (/(^|\/)src\/store\//.test(lower)) return 'state'
  if (ext === '.tsx' || ext === '.jsx') return 'component'
  if (
    ['.ts', '.js', '.mjs', '.cjs', '.py', '.rs', '.go', '.rb', '.sh', '.ps1', '.lua'].includes(ext)
  ) {
    return 'util'
  }
  return 'other'
}

/** 纯指令型注释（eslint / ts / prettier 开关）不是职责说明，跳过 */
const DIRECTIVE_COMMENT = /^(eslint|@ts-|prettier-|@vitest|@type|istanbul)/

/**
 * 文件首部注释：优先取文件开头那一段，其次取第一个**顶格**注释块。
 *
 * 很多文件的说明写在 import 之后（`/** … *\/` 紧跟 `export function`），所以「开头
 * 没有」不等于「没说明」。缩进的注释是字段 / 分支说明，不算文件职责，直接忽略。
 * 支持块注释、`//`、`#`；拿不到就返回 undefined（不是错误）。
 */
export function extractHeadComment(head: string): string | undefined {
  const lines = head.split(/\r?\n/)

  let start = 0
  while (start < lines.length && (!lines[start].trim() || lines[start].startsWith('#!'))) start++
  if (start < lines.length) {
    const first = lines[start].trim()
    if (first.startsWith('/*') || first.startsWith('//') || first.startsWith('#')) {
      const leading = extractBlock(lines, start)
      // 开头就是一串指令注释时，交给下面的逐行扫描跳过它们
      if (leading && !DIRECTIVE_COMMENT.test(leading)) return leading
    }
  }

  // 顶格注释（不缩进）：绕过 import 区，取第一段真正的文件 / 模块说明
  for (let index = start; index < lines.length && index < start + 160; index++) {
    const line = lines[index]
    if (!/^(\/\*|\/\/|#)/.test(line)) continue
    const body = line
      .replace(/^\/\*+/, '')
      .replace(/^\/\/+/, '')
      .replace(/^#+/, '')
      .trim()
    if (DIRECTIVE_COMMENT.test(body)) continue
    const block = extractBlock(lines, index)
    if (block) return block
  }

  return undefined
}

/** 从第 `start` 行开始取一个注释块（块注释或连续行注释），压成一行 */
function extractBlock(lines: string[], start: number): string | undefined {
  const first = lines[start].trim()
  const collected: string[] = []

  if (first.startsWith('/*')) {
    const single = first.match(/^\/\*+(.*?)\*+\/\s*$/)
    if (single) {
      collected.push(single[1])
    } else {
      collected.push(first.replace(/^\/\*+/, ''))
      for (let i = start + 1; i < lines.length && i < start + 40; i++) {
        const line = lines[i]
        const end = line.indexOf('*/')
        if (end >= 0) {
          collected.push(line.slice(0, end))
          break
        }
        collected.push(line)
      }
    }
  } else if (first.startsWith('//') || first.startsWith('#')) {
    const marker = first.startsWith('//') ? '//' : '#'
    for (let i = start; i < lines.length && i < start + 40; i++) {
      const line = lines[i].trim()
      if (!line.startsWith(marker)) break
      collected.push(line.slice(marker.length))
    }
  } else {
    return undefined
  }

  const text = collected
    .map((line) => line.replace(/^\s*\*+\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  return text.length > HEAD_COMMENT_MAX ? `${text.slice(0, HEAD_COMMENT_MAX)}…` : text
}

const EXPORT_PATTERNS: RegExp[] = [
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s*\{\s*([A-Za-z_$][\w$]*)/gm,
  /^module\.exports\s*=\s*\{?\s*([A-Za-z_$][\w$]*)/gm,
  /^module\.exports\s+([A-Za-z_$][\w$]*)/gm,
]

/** 顶层导出符号：只看文件头，够生成一句「它对外给什么」，不追求完备 */
export function extractExports(head: string): string[] {
  const found: string[] = []
  for (const pattern of EXPORT_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(head)) !== null) {
      const name = match[1]
      if (name && !found.includes(name)) found.push(name)
      if (found.length >= MAX_EXPORTS) return found
    }
  }
  return found
}

interface HeadRead {
  binary: boolean
  head: string
  size: number
  mtimeMs: number
}

async function statFile(
  absolutePath: string
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stats = await fs.promises.stat(absolutePath)
    if (!stats.isFile()) return null
    return { size: stats.size, mtimeMs: Math.round(stats.mtimeMs) }
  } catch {
    return null
  }
}

async function readHead(
  absolutePath: string,
  known?: { size: number; mtimeMs: number } | null
): Promise<HeadRead | null> {
  const stats = known ?? (await statFile(absolutePath))
  if (!stats) return null
  if (stats.size === 0) return { binary: false, head: '', ...stats }

  const length = Math.min(stats.size, HEAD_BYTES)
  const buffer = Buffer.alloc(length)
  let bytesRead = 0
  try {
    const handle = await fs.promises.open(absolutePath, 'r')
    try {
      const result = await handle.read(buffer, 0, length, 0)
      bytesRead = result.bytesRead
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  const slice = buffer.subarray(0, bytesRead)
  return { binary: slice.includes(0), head: slice.toString('utf8'), ...stats }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

export function repoMapCachePath(workspaceDir: string): string {
  return path.join(workspaceDir, '.pi-workbench', 'repo-map.json')
}

function sanitizeFacts(value: unknown): RepoMapFacts | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const role = typeof record.role === 'string' && ROLE_SET.has(record.role) ? record.role : 'other'
  const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : -1
  const mtimeMs =
    typeof record.mtimeMs === 'number' && Number.isFinite(record.mtimeMs) ? record.mtimeMs : -1
  // size / mtime 缺失的条目无法判断是否过期，直接丢掉重算
  if (size < 0 || mtimeMs < 0) return null
  const exports = Array.isArray(record.exports)
    ? record.exports.filter((item): item is string => typeof item === 'string').slice(0, MAX_EXPORTS)
    : undefined
  return {
    role: role as RepoMapRole,
    binary: record.binary === true,
    size,
    mtimeMs,
    ...(typeof record.headComment === 'string' && record.headComment
      ? { headComment: record.headComment }
      : {}),
    ...(exports && exports.length > 0 ? { exports } : {}),
    ...(typeof record.symbol === 'string' && record.symbol ? { symbol: record.symbol } : {}),
  }
}

function readCache(workspaceDir: string): {
  repoRoot: string
  files: Record<string, RepoMapFacts>
} {
  const { data } = readJsonWithBackup<RepoMapCacheFile>(repoMapCachePath(workspaceDir))
  if (!data || data.version !== REPO_MAP_CACHE_VERSION) return { repoRoot: '', files: {} }
  if (!data.files || typeof data.files !== 'object') return { repoRoot: '', files: {} }
  const files: Record<string, RepoMapFacts> = {}
  const entries = Object.entries(data.files)
  if (entries.length > 200_000) return { repoRoot: '', files: {} }
  for (const [key, value] of entries) {
    const facts = sanitizeFacts(value)
    if (facts) files[key] = facts
  }
  return { repoRoot: typeof data.repoRoot === 'string' ? data.repoRoot : '', files }
}

async function listTrackedFiles(repoRoot: string): Promise<string[] | null> {
  const result = await runGit(repoRoot, ['ls-files', '-z', '--cached'])
  if (!result.ok) return null
  return result.stdout
    .split('\0')
    .filter((entry) => entry.length > 0)
    .map(toPosix)
}

function emptyResult(overrides: Partial<RepoMapResult> = {}): RepoMapResult {
  return {
    success: true,
    isRepo: false,
    total: 0,
    described: 0,
    truncated: false,
    files: [],
    ...overrides,
  }
}

/** 同一工作区的扫描串行化：避免同时读盘 + 同时写缓存 */
const queues = new Map<string, Promise<unknown>>()

function serializeScan<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  queues.set(
    key,
    run.catch(() => undefined)
  )
  return run
}

async function scanUncached(
  workspaceDir: string,
  options: RepoMapScanOptions
): Promise<RepoMapResult> {
  const repo = await getRepoInfo(workspaceDir)
  if (!repo) return emptyResult()

  const trackedRaw = await listTrackedFiles(repo.root)
  if (!trackedRaw) {
    return emptyResult({
      success: false,
      isRepo: true,
      repoRoot: repo.root,
      error: 'git ls-files failed',
    })
  }

  // 只处理工作区内的文件：工作区可能是仓库的子目录，读盘一律不越出受信任根
  const tracked: string[] = []
  for (const rel of trackedRaw) {
    const absolute = path.resolve(repo.root, rel)
    if (!isPathInsideRoot(workspaceDir, absolute)) continue
    tracked.push(rel)
  }

  const cache = readCache(workspaceDir)
  const cacheValid = cache.repoRoot === repo.root
  const cachedFiles = cacheValid ? cache.files : {}
  const limit = options.limit && options.limit > 0 ? options.limit : REPO_MAP_FULL_SCAN_LIMIT
  const truncated = tracked.length > limit
  const requested = new Set((options.paths ?? []).map(toPosix))
  const force = options.force === true

  let dirty = !cacheValid && Object.keys(cachedFiles).length > 0

  const files = await mapLimit<string, RepoMapFile>(tracked, IO_CONCURRENCY, async (rel) => {
    const absolute = path.resolve(repo.root, rel)
    const role = roleForPath(rel)
    const cached = cachedFiles[rel]
    const stats = await statFile(absolute)

    if (!stats) {
      // 索引里有、盘上没有（删除未暂存）：照样列出，但不描述
      return { path: rel, role, binary: false, size: 0, mtimeMs: 0, described: false }
    }

    const reusable =
      !force && cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs
    if (reusable) {
      return { path: rel, ...cached, described: true }
    }

    // 降级模式下只补齐被点名的文件；其余先把路径与分类给出来
    const needed = !truncated || requested.has(rel)
    if (!needed) {
      return { ...stats, path: rel, role, binary: cached?.binary ?? false, described: false }
    }

    // 符号链接可能指向工作区之外：真实路径不在信任根里就不读内容
    const real = await fs.promises.realpath(absolute).catch(() => null)
    if (!real || !isPathInsideRoot(workspaceDir, real)) {
      return { ...stats, path: rel, role, binary: false, described: false }
    }

    const head = await readHead(absolute, stats)
    if (!head) {
      return { ...stats, path: rel, role, binary: false, described: false }
    }
    const exports = head.binary ? [] : extractExports(head.head)
    const comment = head.binary ? undefined : extractHeadComment(head.head)
    dirty = true
    return {
      path: rel,
      role,
      binary: head.binary,
      size: head.size,
      mtimeMs: head.mtimeMs,
      described: true,
      ...(comment ? { headComment: comment } : {}),
      ...(exports.length > 0 ? { exports, symbol: exports[0] } : {}),
    }
  })

  const nextCache: Record<string, RepoMapFacts> = {}
  for (const file of files) {
    if (!file.described) continue
    nextCache[file.path] = {
      role: file.role,
      binary: file.binary,
      size: file.size,
      mtimeMs: file.mtimeMs,
      ...(file.headComment ? { headComment: file.headComment } : {}),
      ...(file.exports && file.exports.length > 0
        ? { exports: file.exports, symbol: file.symbol }
        : {}),
    }
  }

  if (dirty || Object.keys(nextCache).length !== Object.keys(cachedFiles).length) {
    await writeJsonAtomic(repoMapCachePath(workspaceDir), {
      version: REPO_MAP_CACHE_VERSION,
      repoRoot: repo.root,
      updatedAt: Date.now(),
      files: nextCache,
    }).catch(() => undefined)
  }

  const described = files.reduce((count, file) => (file.described ? count + 1 : count), 0)

  return {
    success: true,
    isRepo: true,
    repoRoot: repo.root,
    total: files.length,
    described,
    truncated,
    files,
  }
}

/**
 * 扫描仓库。`force` 忽略指纹缓存；`paths` 在降级模式下点名补齐描述。
 * 同一工作区的并发调用排队执行，避免重复读盘。
 */
export async function scanRepoMap(
  workspaceDir: string,
  options: RepoMapScanOptions = {}
): Promise<RepoMapResult> {
  const root = canonicalizePath(workspaceDir)
  if (!root) {
    return emptyResult({ success: false, error: 'Workspace path is not valid' })
  }
  return serializeScan(root, () => scanUncached(root, options))
}

/** 降级模式下补齐指定文件的描述（复用同一份缓存与并发队列） */
export async function describeRepoPaths(
  workspaceDir: string,
  paths: string[]
): Promise<RepoMapResult> {
  return scanRepoMap(workspaceDir, { paths })
}
