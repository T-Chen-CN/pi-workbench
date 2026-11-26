/**
 * 工单改动清单分类与疑似密钥扫描（F-36 / A-29）。
 *
 * 定位：**只做信息提示，不做拦截**（D-20）。
 * 两条硬规则：
 * 1. `classifyAttentionPath` 为 `.env*`、依赖锁、CI 工作流、git hooks、发布配置打上 `attention` 原因；
 * 2. 密钥扫描**绝不返回或记录原始密钥值**，只输出 `{ path, line, kind }`。
 */

import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'
import {
  CLOUD_DEFAULT_DIFF_LIMIT_BYTES,
  CLOUD_MAX_DIFF_LIMIT_BYTES,
  type CloudChangedFile,
  type CloudSecretHit,
  type CloudTaskResult,
} from 'pi-bridge'
import { sanitizeTerminalEnv } from '../terminal-manager.js'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 15_000
const MAX_SECRET_HITS = 50
const MAX_UNTRACKED_FILES = 50
const MAX_UNTRACKED_BYTES = 256 * 1024

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'gemfile.lock',
  'go.sum',
  'composer.lock',
  'uv.lock',
  'npm-shrinkwrap.json',
])

const RELEASE_CONFIG_NAMES = new Set([
  'dockerfile',
  'electron-builder.yml',
  'electron-builder.yaml',
  'electron-builder.json',
  'electron-builder.json5',
  'release.config.js',
  'release.config.cjs',
  'release.config.mjs',
  '.releaserc',
  '.releaserc.json',
  '.releaserc.yml',
  '.releaserc.yaml',
])

const SECRET_FILE_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.envrc',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])

const SECRET_FILE_EXTS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'])

const GIT_HOOK_CONFIG_NAMES = new Set([
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.lefthook.yaml',
  '.pre-commit-config.yaml',
  '.pre-commit-config.yml',
])

function normalizePosix(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/** 解码 git C-quoted 路径（如 `"a/dir with spaces/.env"` 或八进制 UTF-8 转义） */
function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim()
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)) {
    return trimmed
  }
  const inner = trimmed.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch !== '\\' || i + 1 >= inner.length) {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b)
      continue
    }
    const next = inner[i + 1]
    if (next >= '0' && next <= '7' && i + 3 < inner.length) {
      const oct = inner.slice(i + 1, i + 4)
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(Number.parseInt(oct, 8))
        i += 3
        continue
      }
    }
    i += 1
    switch (next) {
      case 'n': bytes.push(0x0a); break
      case 'r': bytes.push(0x0d); break
      case 't': bytes.push(0x09); break
      case 'b': bytes.push(0x08); break
      case 'f': bytes.push(0x0c); break
      case '"': bytes.push(0x22); break
      case '\\': bytes.push(0x5c); break
      default:
        for (const b of Buffer.from(next, 'utf8')) bytes.push(b)
        break
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** 解析 `diff --git <a-side> <b-side>` 行（支持引号与空格）返回双侧相对路径 */
function parseDiffGitPaths(line: string): { aPath: string; bPath: string } | null {
  const rest = line.slice('diff --git '.length).trim()
  if (!rest) return null
  const parts: string[] = []
  let i = 0
  while (i < rest.length && parts.length < 2) {
    while (i < rest.length && rest[i] === ' ') i += 1
    if (i >= rest.length) break
    if (rest[i] === '"') {
      let end = i + 1
      while (end < rest.length) {
        if (rest[end] === '\\' && end + 1 < rest.length) {
          end += 2
          continue
        }
        if (rest[end] === '"') {
          end += 1
          break
        }
        end += 1
      }
      parts.push(unquoteGitPath(rest.slice(i, end)))
      i = end
    } else if (parts.length === 0) {
      // 无引号时找下一个 ` b/` 分隔符（兼容无引号但带空格的旧 diff）
      const splitIdx = rest.indexOf(' b/', i)
      if (splitIdx > i) {
        parts.push(rest.slice(i, splitIdx))
        i = splitIdx + 1
      } else {
        const spaceIdx = rest.indexOf(' ', i)
        if (spaceIdx === -1) {
          parts.push(rest.slice(i))
          i = rest.length
        } else {
          parts.push(rest.slice(i, spaceIdx))
          i = spaceIdx + 1
        }
      }
    } else {
      parts.push(rest.slice(i).trim())
      i = rest.length
    }
  }
  if (parts.length < 2) return null
  return {
    aPath: normalizePosix(parts[0].replace(/^a\//, '')),
    bPath: normalizePosix(parts[1].replace(/^b\//, '')),
  }
}

/**
 * 判断改动路径是否属于需要点名的敏感/高影响类别（F-36）。
 * 返回简短稳定标识，供云端与两端 UI 按「注意 / 普通」分组。
 */
export function classifyAttentionPath(filePath: string): string | undefined {
  const normalized = normalizePosix(filePath)
  if (!normalized) return undefined
  const lower = normalized.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  const ext = path.extname(base)

  if (base === '.env' || base.startsWith('.env.')) return 'env-file'
  if (
    SECRET_FILE_NAMES.has(base) ||
    SECRET_FILE_EXTS.has(ext) ||
    base.startsWith('secrets.')
  ) {
    return 'secret-file'
  }
  if (LOCKFILE_NAMES.has(base)) return 'lockfile'
  if (
    lower.startsWith('.github/workflows/') ||
    lower.startsWith('.circleci/') ||
    lower.startsWith('.buildkite/') ||
    lower === '.gitlab-ci.yml' ||
    lower === 'azure-pipelines.yml' ||
    base === 'jenkinsfile'
  ) {
    return 'ci-workflow'
  }
  if (
    lower.startsWith('.husky/') ||
    lower.startsWith('.githooks/') ||
    lower.startsWith('.git/hooks/') ||
    GIT_HOOK_CONFIG_NAMES.has(base)
  ) {
    return 'git-hook'
  }
  if (
    RELEASE_CONFIG_NAMES.has(base) ||
    base.startsWith('dockerfile.') ||
    base.startsWith('docker-compose.') ||
    lower.startsWith('build/installer.') ||
    lower.startsWith('scripts/release')
  ) {
    return 'release-config'
  }
  return undefined
}

/** 给改动清单逐条补上 `attention`（已有原因时保留） */
export function annotateChangedFiles(files: CloudChangedFile[]): CloudChangedFile[] {
  return files.map((file) => {
    const attention = file.attention ?? classifyAttentionPath(file.path)
    return attention ? { ...file, attention } : { path: file.path, kind: file.kind }
  })
}

interface SecretRule {
  kind: string
  pattern: RegExp
}

const PRIVATE_KEY_BEGIN_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/
const PRIVATE_KEY_END_RE = /-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/

const SECRET_RULES: readonly SecretRule[] = [
  { kind: 'private-key', pattern: PRIVATE_KEY_BEGIN_RE },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'stripe-key', pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { kind: 'api-key', pattern: /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'npm-token', pattern: /(?:^|\s)\/\/[^/\s]+.*:_authToken\s*=\s*(\S{8,})/i },
  {
    kind: 'database-url',
    pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^:\s/]+:([^@\s/]{6,})@[^\s'"]+/i,
  },
  {
    kind: 'jwt-token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    kind: 'bearer-token',
    pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{24,})\b/,
  },
  {
    kind: 'secret-assignment',
    pattern:
      /(?:api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key|client[_-]?secret|auth[_-]?token|password|passwd|db[_-]?pass)\s*[:=]\s*['"]?([A-Za-z0-9/+=._-]{16,})['"]?/i,
  },
]

const PLACEHOLDER_RE = /(?:example|placeholder|your[_-]?|changeme|dummy|sample|fake|mock|test[_-]?key|xxxx|0000|123456)/i

function detectSecretKind(line: string): string | null {
  for (const rule of SECRET_RULES) {
    const match = rule.pattern.exec(line)
    if (!match) continue
    // 泛化赋值与凭据规则要跳过明显的占位符示例，减少误报
    if (
      rule.kind === 'secret-assignment' ||
      rule.kind === 'bearer-token' ||
      rule.kind === 'database-url' ||
      rule.kind === 'npm-token'
    ) {
      const value = match[1] ?? ''
      if (PLACEHOLDER_RE.test(value) || /^([a-z0-9])\1{7,}$/i.test(value)) continue
    }
    return rule.kind
  }
  return null
}

/** 扫描单个纯文本内容（用于未跟踪的新文件）；只返回位置与类型 */
export function scanTextForSecrets(filePath: string, content: string): CloudSecretHit[] {
  const normalized = normalizePosix(filePath)
  if (!normalized || content.includes('\0')) return []
  const hits: CloudSecretHit[] = []
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const kind = detectSecretKind(lines[index] ?? '')
    if (!kind) continue
    hits.push({ path: normalized, line: index + 1, kind })
    if (hits.length >= MAX_SECRET_HITS) break
  }
  return hits
}

/** 扫描 unified diff 的新增行（`+` 开头，不含 `+++` 头）；只返回位置与类型，绝不返回原值 */
export function scanDiffForSecrets(diffText: string): CloudSecretHit[] {
  const hits: CloudSecretHit[] = []
  const seen = new Set<string>()
  let currentPath = ''
  let currentLine = 0

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith('+++ ')) {
      const target = unquoteGitPath(rawLine.slice(4).trim())
      currentPath =
        target === '/dev/null'
          ? ''
          : normalizePosix(target.replace(/^b\//, ''))
      currentLine = 0
      continue
    }
    if (rawLine.startsWith('@@ ')) {
      const match = /\+(\d+)/.exec(rawLine)
      currentLine = match ? Number.parseInt(match[1], 10) : 0
      continue
    }
    if (!currentPath || currentLine <= 0) continue
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      const kind = detectSecretKind(rawLine.slice(1))
      if (kind) {
        const key = `${currentPath}:${currentLine}:${kind}`
        if (!seen.has(key)) {
          seen.add(key)
          hits.push({ path: currentPath, line: currentLine, kind })
          if (hits.length >= MAX_SECRET_HITS) break
        }
      }
      currentLine += 1
    } else if (rawLine.startsWith(' ')) {
      currentLine += 1
    }
  }
  return hits
}

/**
 * 扫描工单工作树里的全部新增改动（已提交 + 已暂存 + 未暂存 + 未跟踪新文件）。
 * 任何 git / 读取异常都静默降级，绝不阻断工单结单。
 */
export async function scanWorktreeSecrets(
  base: string | undefined,
  worktreePath: string
): Promise<CloudSecretHit[]> {
  const hits: CloudSecretHit[] = []
  const seen = new Set<string>()
  const push = (incoming: CloudSecretHit[]) => {
    for (const hit of incoming) {
      if (hits.length >= MAX_SECRET_HITS) return
      const key = `${hit.path}:${hit.line}:${hit.kind}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push(hit)
    }
  }

  const runGit = (args: string[]): Promise<string> =>
    execFileAsync('git', ['-C', worktreePath, ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: sanitizeTerminalEnv(process.env),
    }).then((result) => result.stdout)

  // 1. 相对 base 的全部 diff（含已提交 + 工作区修改）；没有 base 时退回 HEAD 与工作区
  const diffSpecs: string[][] = base
    ? [['diff', '--no-color', '-U0', base]]
    : [
        ['diff', '--no-color', '-U0', 'HEAD'],
        ['diff', '--no-color', '-U0'],
      ]
  for (const args of diffSpecs) {
    try {
      const diff = await runGit(args)
      if (diff) push(scanDiffForSecrets(diff))
      if (base) break
    } catch {
      // base 不可用时继续尝试回退 diff
    }
  }

  // 2. 未跟踪的新文件（git diff 看不到它们）
  if (hits.length < MAX_SECRET_HITS) {
    try {
      const output = await runGit(['ls-files', '--others', '--exclude-standard'])
      const untracked = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, MAX_UNTRACKED_FILES)
      for (const relPath of untracked) {
        if (hits.length >= MAX_SECRET_HITS) break
        const fullPath = path.join(worktreePath, unquoteGitPath(relPath))
        try {
          // 必须使用 lstat 拒绝符号链接，防止工单通过软链读取宿主机敏感文件
          const stat = await fs.lstat(fullPath)
          if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) continue
          const content = await fs.readFile(fullPath, 'utf-8')
          push(scanTextForSecrets(unquoteGitPath(relPath), content))
        } catch {
          // 跳过不可读或已删文件
        }
      }
    } catch {
      // 非 git 目录时忽略
    }
  }

  return hits
}

const EXCLUDED_DIFF_ATTENTION = new Set(['env-file', 'lockfile', 'secret-file'])
const MAX_UNTRACKED_DIFF_BYTES = 64 * 1024

function shouldSkipDiffPath(filePath: string): boolean {
  const attention = classifyAttentionPath(filePath)
  return attention !== undefined && EXCLUDED_DIFF_ATTENTION.has(attention)
}

function redactDiffLine(line: string, state: { inPrivateKeyBlock: boolean }): string {
  // diff 文件头（+++ / --- / @@）不含密钥载荷，进入新 hunk 时复位多行私钥状态
  if (
    line.startsWith('diff --git ') ||
    line.startsWith('+++ ') ||
    line.startsWith('--- ') ||
    line.startsWith('@@ ') ||
    line.startsWith('index ')
  ) {
    if (line.startsWith('diff --git ') || line.startsWith('@@ ')) {
      state.inPrivateKeyBlock = false
    }
    return line
  }
  const prefix = line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') ? line[0] : ''
  const body = prefix ? line.slice(1) : line
  if (PRIVATE_KEY_BEGIN_RE.test(body)) {
    state.inPrivateKeyBlock = !PRIVATE_KEY_END_RE.test(body)
    return `${prefix}[REDACTED: private-key]`
  }
  if (state.inPrivateKeyBlock) {
    if (PRIVATE_KEY_END_RE.test(body)) {
      state.inPrivateKeyBlock = false
    }
    return `${prefix}[REDACTED: private-key]`
  }
  const kind = detectSecretKind(body)
  if (!kind) return line
  return `${prefix}[REDACTED: ${kind}]`
}

function clampDiffLimit(limitBytes?: number): number {
  if (typeof limitBytes !== 'number' || !Number.isFinite(limitBytes) || limitBytes <= 0) {
    return CLOUD_DEFAULT_DIFF_LIMIT_BYTES
  }
  return Math.max(512, Math.min(CLOUD_MAX_DIFF_LIMIT_BYTES, Math.floor(limitBytes)))
}

/**
 * 清洗并截断 unified diff（C-03b）：
 * - 跳过 `.env*`、密钥文件、依赖锁文件与二进制块（只保留一句省略提示）；
 * - 命中疑似密钥或处于多行 PEM 私钥块内的任意行全部替换为 `[REDACTED: <kind>]`；
 * - 按 UTF-8 字节预算在行边界截断。
 */
export function sanitizeDiffExcerpt(
  rawDiff: string,
  limitBytes?: number
): NonNullable<CloudTaskResult['diff']> | undefined {
  const maxBytes = clampDiffLimit(limitBytes)
  const trimmed = rawDiff.trim()
  if (!trimmed) return undefined

  const rawLines = rawDiff.split(/\r?\n/)
  const filtered: string[] = []
  let skippingFile = false
  const redactState = { inPrivateKeyBlock: false }

  for (const line of rawLines) {
    if (line.startsWith('diff --git ')) {
      redactState.inPrivateKeyBlock = false
      const parsed = parseDiffGitPaths(line)
      const aPath = parsed?.aPath ?? ''
      const bPath = parsed?.bPath ?? ''
      // 同时检查 a/ 与 b/ 双侧，防止将 .env 重命名为普通文件名绕过过滤
      const skipPath = (aPath && shouldSkipDiffPath(aPath))
        ? aPath
        : (bPath && shouldSkipDiffPath(bPath))
          ? bPath
          : ''
      if (skipPath) {
        skippingFile = true
        filtered.push(`diff --git a/${aPath || skipPath} b/${bPath || skipPath}`)
        filtered.push(`[omitted: ${classifyAttentionPath(skipPath)}]`)
        continue
      }
      skippingFile = false
      filtered.push(line)
      continue
    }
    if (skippingFile) continue
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      filtered.push(line)
      skippingFile = true
      redactState.inPrivateKeyBlock = false
      continue
    }
    filtered.push(redactDiffLine(line, redactState))
  }

  const fullText = filtered.join('\n').trim()
  if (!fullText) return undefined
  const totalBytes = Buffer.byteLength(fullText, 'utf8')
  if (totalBytes <= maxBytes) {
    return { bytes: totalBytes, excerpt: fullText }
  }

  const notice = `\n... [truncated, total ${totalBytes} bytes > limit ${maxBytes} bytes]`
  const budget = Math.max(128, maxBytes - Buffer.byteLength(notice, 'utf8'))
  const kept: string[] = []
  let used = 0
  for (const line of fullText.split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0)
    if (used + lineBytes > budget) {
      if (kept.length === 0) {
        kept.push(Buffer.from(line, 'utf8').subarray(0, budget).toString('utf8'))
      }
      break
    }
    kept.push(line)
    used += lineBytes
  }
  return {
    bytes: totalBytes,
    excerpt: kept.join('\n') + notice,
    truncated: true,
  }
}

/**
 * 采集工单工作树里的脱敏 diff（含相对 base 的已提交 + 未提交改动 + 未跟踪文本文件）。
 * 任何 git / 读取异常静默降级为 undefined，绝不阻断工单结单。
 */
export async function collectTaskDiff(
  base: string | undefined,
  worktreePath: string,
  limitBytes?: number
): Promise<NonNullable<CloudTaskResult['diff']> | undefined> {
  const runGit = (args: string[]): Promise<string> =>
    execFileAsync('git', ['-C', worktreePath, ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: sanitizeTerminalEnv(process.env),
    }).then((result) => result.stdout)

  const parts: string[] = []
  const diffSpecs: string[][] = base
    ? [['diff', '--no-color', '-U3', base]]
    : [
        ['diff', '--no-color', '-U3', 'HEAD'],
        ['diff', '--no-color', '-U3'],
      ]
  for (const args of diffSpecs) {
    try {
      const diff = await runGit(args)
      if (diff.trim()) parts.push(diff.trimEnd())
      if (base) break
    } catch {
      // base 不可用时继续尝试回退 diff
    }
  }

  // 未跟踪新文件：构造标准 unified diff 片段，排除 .env* / lockfile / 二进制 / 超大文件
  try {
    const output = await runGit(['ls-files', '--others', '--exclude-standard'])
    const untracked = output
      .split(/\r?\n/)
      .map((line) => normalizePosix(unquoteGitPath(line.trim())))
      .filter(Boolean)
      .slice(0, MAX_UNTRACKED_FILES)
    for (const relPath of untracked) {
      if (shouldSkipDiffPath(relPath)) {
        parts.push(`diff --git a/${relPath} b/${relPath}\n[omitted: ${classifyAttentionPath(relPath)}]`)
        continue
      }
      const fullPath = path.join(worktreePath, relPath)
      try {
        // 必须使用 lstat 拒绝符号链接，防止未跟踪软链将工作树外敏感文件打包进 diff
        const stat = await fs.lstat(fullPath)
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_UNTRACKED_DIFF_BYTES) continue
        const content = await fs.readFile(fullPath, 'utf-8')
        if (content.includes('\0')) continue
        const lines = content.split(/\r?\n/)
        const body = lines.map((line) => `+${line}`).join('\n')
        parts.push(
          `diff --git a/${relPath} b/${relPath}\nnew file\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}`
        )
      } catch {
        // 跳过不可读或已删文件
      }
    }
  } catch {
    // 非 git 目录时忽略
  }

  if (parts.length === 0) return undefined
  return sanitizeDiffExcerpt(parts.join('\n'), limitBytes)
}
