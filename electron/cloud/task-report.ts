/**
 * 工单改动清单分类与疑似密钥扫描（F-36 / A-29）。
 *
 * 定位：**只做信息提示，不做拦截**（D-20）。
 * 两条硬规则：
 * 1. `classifyAttentionPath` 为 `.env*`、依赖锁、CI 工作流、git hooks、发布配置打上 `attention` 原因；
 * 2. 密钥扫描**绝不返回或记录原始密钥值**，只输出 `{ path, line, kind }`。
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  CLOUD_DEFAULT_DIFF_LIMIT_BYTES,
  CLOUD_MAX_DIFF_LIMIT_BYTES,
  type CloudChangedFile,
  type CloudSecretHit,
  type CloudTaskResult,
} from 'pi-bridge'
import { sanitizeTerminalEnv } from '../terminal-manager.js'

const GIT_TIMEOUT_MS = 15_000
const DEFAULT_GIT_STREAM_MAX_BYTES = 16 * 1024 * 1024
const MAX_STREAM_LINE_CHARS = 512 * 1024
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

const ENV_TEMPLATE_NAMES = new Set(['.env.example', '.env.template', '.env.sample'])

const SECRET_FILE_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.envrc',
  'credentials.json',
  'service-account.json',
  'terraform.tfvars',
  'terraform.tfvars.json',
  'kubeconfig',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])

const SECRET_FILE_EXTS = new Set(['.pem', '.key', '.p8', '.p12', '.pfx', '.jks', '.keystore'])

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

  if (base === '.env' || base.startsWith('.env.')) {
    if (ENV_TEMPLATE_NAMES.has(base)) return undefined
    return 'env-file'
  }
  if (
    SECRET_FILE_NAMES.has(base) ||
    SECRET_FILE_EXTS.has(ext) ||
    base.startsWith('secrets.') ||
    base.endsWith('.tfvars') ||
    base.endsWith('service-account.json') ||
    (ext === '.json' && base.includes('credentials')) ||
    lower === '.kube/config' ||
    lower.endsWith('/.kube/config')
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
  {
    kind: 'aws-secret-key',
    pattern: /\baws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*['"]?([A-Za-z0-9/+=]{20,})['"]?/i,
  },
  { kind: 'pi-cloud-token', pattern: /\bpk_[A-Za-z0-9_-]{32,}\b/ },
  { kind: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'stripe-key', pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
  { kind: 'api-key', pattern: /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'npm-token', pattern: /(?:^|\s)\/\/[^/\s]+.*:_authToken\s*=\s*(\S{8,})/i },
  {
    kind: 'database-url',
    pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^:\s/]+:([^@\s/]{6,})@[A-Za-z0-9._~:/?#[\]@!$&*+;=%-]+/i,
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
      /(?:api[_-]?key|secret[_-]?key|secret[_-]?access[_-]?key|access[_-]?token|private[_-]?key|client[_-]?secret|auth[_-]?token|password|passwd|db[_-]?pass)["']?\s*[:=]\s*['"]?([A-Za-z0-9/+=._-]{16,})['"]?/i,
  },
]

const PLACEHOLDER_RE = /(?:example|placeholder|your[_-]?|changeme|dummy|sample|fake|mock|test[_-]?key|xxxx|0000|123456)/i
const PLACEHOLDER_EXEMPT_KINDS = new Set([
  'secret-assignment',
  'aws-secret-key',
  'bearer-token',
  'database-url',
  'npm-token',
])

const INLINE_SECRET_RULES = SECRET_RULES.filter((rule) => rule.kind !== 'private-key').map((rule) => ({
  kind: rule.kind,
  pattern: new RegExp(
    rule.pattern.source,
    rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`
  ),
}))

function detectSecretKind(line: string): string | null {
  for (const rule of SECRET_RULES) {
    const match = rule.pattern.exec(line)
    if (!match) continue
    // 泛化赋值与凭据规则要跳过明显的占位符示例，减少误报
    if (PLACEHOLDER_EXEMPT_KINDS.has(rule.kind)) {
      const value = match[1] ?? ''
      if (PLACEHOLDER_RE.test(value) || /^([a-z0-9])\1{7,}$/i.test(value)) continue
    }
    return rule.kind
  }
  return null
}

function redactInlineRules(
  segment: string,
  lineNo: number,
  sourcePath: string,
  hits: CloudSecretHit[]
): string {
  let output = segment
  for (const rule of INLINE_SECRET_RULES) {
    rule.pattern.lastIndex = 0
    output = output.replace(rule.pattern, (...args) => {
      const fullMatch = String(args[0] ?? '')
      if (PLACEHOLDER_EXEMPT_KINDS.has(rule.kind)) {
        const value = typeof args[1] === 'string' ? args[1] : ''
        if (PLACEHOLDER_RE.test(value) || /^([a-z0-9])\1{7,}$/i.test(value)) {
          return fullMatch
        }
      }
      if (hits.length < MAX_SECRET_HITS) {
        hits.push({ path: sourcePath, line: lineNo, kind: rule.kind })
      }
      const leadingWs = rule.kind === 'npm-token' ? /^\s+/.exec(fullMatch)?.[0] ?? '' : ''
      return `${leadingWs}[REDACTED: ${rule.kind}]`
    })
  }
  return output
}

/**
 * 扫描并就地脱敏任意纯文本（里程碑预览、命令输出、工单总结等）。
 * 命中单行密钥、多行 PEM 私钥或被折成单行的 PEM 私钥时一律替换为 `[REDACTED: <kind>]`，绝不保留原值。
 */
export function redactTextSecrets(
  text: string,
  sourcePath = '<text>'
): { text: string; hits: CloudSecretHit[] } {
  if (!text) return { text, hits: [] }
  const hits: CloudSecretHit[] = []
  const lines = text.split(/\r?\n/)
  const outputLines: string[] = []
  let inPrivateKeyBlock = false

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1
    let cursor = lines[index] ?? ''
    let built = ''

    while (cursor.length > 0) {
      if (inPrivateKeyBlock) {
        const endMatch = PRIVATE_KEY_END_RE.exec(cursor)
        if (!endMatch) {
          built += '[REDACTED: private-key]'
          cursor = ''
          break
        }
        inPrivateKeyBlock = false
        built += '[REDACTED: private-key]'
        cursor = cursor.slice(endMatch.index + endMatch[0].length)
        continue
      }

      const beginMatch = PRIVATE_KEY_BEGIN_RE.exec(cursor)
      if (!beginMatch) {
        built += redactInlineRules(cursor, lineNo, sourcePath, hits)
        cursor = ''
        break
      }

      if (hits.length < MAX_SECRET_HITS) {
        hits.push({ path: sourcePath, line: lineNo, kind: 'private-key' })
      }
      const before = cursor.slice(0, beginMatch.index)
      if (before) built += redactInlineRules(before, lineNo, sourcePath, hits)
      built += '[REDACTED: private-key]'
      const afterBegin = cursor.slice(beginMatch.index + beginMatch[0].length)
      const endMatch = PRIVATE_KEY_END_RE.exec(afterBegin)
      if (endMatch) {
        cursor = afterBegin.slice(endMatch.index + endMatch[0].length)
      } else {
        // 跨行私钥或被截断到行尾的私钥：本行剩余内容整段丢弃，后续行继续吞到 END 为止
        inPrivateKeyBlock = true
        cursor = ''
      }
    }

    outputLines.push(built)
  }

  return { text: outputLines.join('\n'), hits }
}

/** 便捷脱敏包装：直接返回脱敏后的文本 */
export function redactSecrets(text: string): string {
  return redactTextSecrets(text).text
}

interface GitStreamResult {
  ok: boolean
  truncated: boolean
  bytesRead: number
}

/**
 * 流式执行 git 子进程并逐行回调：读取期间实时强制字节上限并在超限时终止子进程，
 * 避免 `execFile` 命中 `maxBuffer` 后整段抛错导致密钥扫描静默返回 0 条命中或丢失 diff。
 */
function streamGitLines(
  worktreePath: string,
  args: string[],
  options: {
    maxBytes?: number
    timeoutMs?: number
    onLine: (line: string) => boolean | void
  }
): Promise<GitStreamResult> {
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_GIT_STREAM_MAX_BYTES)
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS

  return new Promise<GitStreamResult>((resolve) => {
    let settled = false
    let stoppedEarly = false
    let truncated = false
    let timedOut = false
    let bytesRead = 0
    let pending = ''
    const decoder = new StringDecoder('utf8')

    const child = spawn('git', ['-C', worktreePath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: sanitizeTerminalEnv(process.env),
    })

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, truncated, bytesRead })
    }

    const stopChild = (markTruncated: boolean) => {
      stoppedEarly = true
      if (markTruncated) truncated = true
      try {
        child.stdout?.destroy()
      } catch {
        // ignore
      }
      try {
        child.stderr?.destroy()
      } catch {
        // ignore
      }
      try {
        child.kill()
      } catch {
        // ignore
      }
    }

    const emitLine = (rawLine: string): boolean => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (options.onLine(line) === false) {
        stopChild(false)
        return false
      }
      return true
    }

    const timer = setTimeout(() => {
      timedOut = true
      stopChild(false)
      finish(false)
    }, timeoutMs)
    timer.unref?.()

    // 排空 stderr，防止子进程因 stderr 缓冲区满而阻塞退出
    child.stderr?.resume()

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled || stoppedEarly) return
      let slice = chunk
      let hitLimit = false
      if (bytesRead + chunk.length > maxBytes) {
        const remaining = Math.max(0, maxBytes - bytesRead)
        slice = chunk.subarray(0, remaining)
        bytesRead = maxBytes
        hitLimit = true
      } else {
        bytesRead += chunk.length
      }

      if (slice.length > 0) {
        pending += decoder.write(slice)
      }

      let nlIdx = pending.indexOf('\n')
      while (nlIdx !== -1) {
        const line = pending.slice(0, nlIdx)
        pending = pending.slice(nlIdx + 1)
        if (!emitLine(line)) return
        nlIdx = pending.indexOf('\n')
      }

      while (pending.length > MAX_STREAM_LINE_CHARS) {
        const part = pending.slice(0, MAX_STREAM_LINE_CHARS)
        pending = pending.slice(MAX_STREAM_LINE_CHARS)
        if (!emitLine(part)) return
      }

      if (hitLimit) {
        // 不调用 decoder.end()，直接丢弃可能落在截断边界上的残缺 UTF-8 多字节尾序列，避免产生 \uFFFD
        if (pending.length > 0) {
          const tail = pending
          pending = ''
          emitLine(tail)
        }
        stopChild(true)
      }
    })

    child.stdout?.on('end', () => {
      if (settled || stoppedEarly) return
      pending += decoder.end()
      if (pending.length > 0) {
        const tail = pending
        pending = ''
        emitLine(tail)
      }
    })

    child.on('error', () => {
      finish(false)
    })

    child.on('close', (code) => {
      if (timedOut) {
        finish(false)
        return
      }
      finish(stoppedEarly || code === 0)
    })
  })
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

/** 增量 unified diff 密钥扫描器：供内存字符串扫描与流式 git diff 复用 */
function createDiffSecretScanner(
  hits: CloudSecretHit[],
  seen: Set<string>
): { feedLine: (rawLine: string) => boolean } {
  let currentPath = ''
  let currentLine = 0

  return {
    feedLine(rawLine: string): boolean {
      if (hits.length >= MAX_SECRET_HITS) return false
      if (rawLine.startsWith('+++ ')) {
        const target = unquoteGitPath(rawLine.slice(4).trim())
        currentPath =
          target === '/dev/null'
            ? ''
            : normalizePosix(target.replace(/^b\//, ''))
        currentLine = 0
        return true
      }
      if (rawLine.startsWith('@@ ')) {
        const match = /\+(\d+)/.exec(rawLine)
        currentLine = match ? Number.parseInt(match[1], 10) : 0
        return true
      }
      if (!currentPath || currentLine <= 0) return true
      if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
        const kind = detectSecretKind(rawLine.slice(1))
        if (kind) {
          const key = `${currentPath}:${currentLine}:${kind}`
          if (!seen.has(key)) {
            seen.add(key)
            hits.push({ path: currentPath, line: currentLine, kind })
            if (hits.length >= MAX_SECRET_HITS) return false
          }
        }
        currentLine += 1
      } else if (rawLine.startsWith(' ')) {
        currentLine += 1
      }
      return true
    },
  }
}

/** 扫描 unified diff 的新增行（`+` 开头，不含 `+++` 头）；只返回位置与类型，绝不返回原值 */
export function scanDiffForSecrets(diffText: string): CloudSecretHit[] {
  const hits: CloudSecretHit[] = []
  const seen = new Set<string>()
  const scanner = createDiffSecretScanner(hits, seen)
  for (const rawLine of diffText.split(/\r?\n/)) {
    if (!scanner.feedLine(rawLine)) break
  }
  return hits
}

/**
 * 扫描工单工作树里的全部新增改动（已提交 + 已暂存 + 未暂存 + 未跟踪新文件）。
 * 流式读取 git diff 并在达到字节上限或命中上限时主动终止子进程，绝不因超大 diff 静默丢失命中。
 */
export async function scanWorktreeSecrets(
  base: string | undefined,
  worktreePath: string,
  options?: { maxDiffBytes?: number }
): Promise<CloudSecretHit[]> {
  const hits: CloudSecretHit[] = []
  const seen = new Set<string>()
  const maxDiffBytes = options?.maxDiffBytes ?? DEFAULT_GIT_STREAM_MAX_BYTES

  const push = (incoming: CloudSecretHit[]) => {
    for (const hit of incoming) {
      if (hits.length >= MAX_SECRET_HITS) return
      const key = `${hit.path}:${hit.line}:${hit.kind}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push(hit)
    }
  }

  const scanGitDiff = async (args: string[]): Promise<boolean> => {
    const scanner = createDiffSecretScanner(hits, seen)
    const res = await streamGitLines(worktreePath, args, {
      maxBytes: maxDiffBytes,
      onLine: (line) => scanner.feedLine(line),
    })
    return res.ok
  }

  // 1. 相对 base 的全部 diff（含已提交 + 工作区修改）；没有 base 时退回 HEAD（已含暂存与未暂存），
  // 仅当 HEAD 不可用（unborn 分支）时再退回暂存/工作区 diff，避免重复扫描
  let diffResolved = false
  if (base) {
    diffResolved = await scanGitDiff(['diff', '--no-color', '-U0', base])
  }
  if (!diffResolved) {
    diffResolved = await scanGitDiff(['diff', '--no-color', '-U0', 'HEAD'])
  }
  if (!diffResolved) {
    for (const args of [
      ['diff', '--no-color', '-U0', '--cached'],
      ['diff', '--no-color', '-U0'],
    ]) {
      if (hits.length >= MAX_SECRET_HITS) break
      await scanGitDiff(args)
    }
  }

  // 2. 未跟踪的新文件（git diff 看不到它们）
  if (hits.length < MAX_SECRET_HITS) {
    const untracked: string[] = []
    const listed = await streamGitLines(
      worktreePath,
      ['ls-files', '--others', '--exclude-standard'],
      {
        maxBytes: 1024 * 1024,
        onLine: (line) => {
          const trimmed = line.trim()
          if (trimmed) untracked.push(trimmed)
          return untracked.length < MAX_UNTRACKED_FILES
        },
      }
    )
    if (listed.ok) {
      for (const relPath of untracked) {
        if (hits.length >= MAX_SECRET_HITS) break
        const unquoted = unquoteGitPath(relPath)
        const fullPath = path.join(worktreePath, unquoted)
        try {
          // 必须使用 lstat 拒绝符号链接，防止工单通过软链读取宿主机敏感文件
          const stat = await fs.lstat(fullPath)
          if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) continue
          const content = await fs.readFile(fullPath, 'utf-8')
          push(scanTextForSecrets(unquoted, content))
        } catch {
          // 跳过不可读或已删文件
        }
      }
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

/** UTF-8 安全按字节上限截断，避免切在多字节字符（如中文）中间产生 \uFFFD */
export function sliceUtf8ByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1
  }
  return buf.subarray(0, end).toString('utf8')
}

function clampDiffLimit(limitBytes?: number): number {
  if (typeof limitBytes !== 'number' || !Number.isFinite(limitBytes) || limitBytes <= 0) {
    return CLOUD_DEFAULT_DIFF_LIMIT_BYTES
  }
  return Math.max(512, Math.min(CLOUD_MAX_DIFF_LIMIT_BYTES, Math.floor(limitBytes)))
}

/**
 * 增量脱敏收集器：按流式逐行过滤 `.env*` / 密钥文件 / 依赖锁 / 二进制块并脱敏密钥行，
 * 仅在内存中保留 `maxBytes` 预算窗口内的行，防止超大 diff 占满堆内存。
 */
function createDiffSanitizer(limitBytes?: number) {
  const maxBytes = clampDiffLimit(limitBytes)
  // 留一点余量用于 finalize 时精确核算 notice 长度；超出窗口的后续行只累计 totalBytes 不占数组
  const keepWindowBytes = maxBytes + 1024
  const keptLines: string[] = []
  let keptBytes = 0
  let totalBytes = 0
  let lineCount = 0
  let started = false
  let trailingEmptyLines = 0
  let skippingFile = false
  const redactState = { inPrivateKeyBlock: false }

  const appendSanitized = (line: string) => {
    if (!started) {
      if (line.trim().length === 0) return
      started = true
    }
    if (line.length === 0) {
      trailingEmptyLines += 1
      return
    }
    while (trailingEmptyLines > 0) {
      trailingEmptyLines -= 1
      const emptyBytes = lineCount > 0 ? 1 : 0
      totalBytes += emptyBytes
      lineCount += 1
      if (keptBytes < keepWindowBytes) {
        keptLines.push('')
        keptBytes += emptyBytes
      }
    }
    const lineBytes = Buffer.byteLength(line, 'utf8') + (lineCount > 0 ? 1 : 0)
    totalBytes += lineBytes
    lineCount += 1
    if (keptBytes < keepWindowBytes) {
      keptLines.push(line)
      keptBytes += lineBytes
    }
  }

  const pushRawLine = (line: string) => {
    if (line.startsWith('diff --git ')) {
      redactState.inPrivateKeyBlock = false
      const parsed = parseDiffGitPaths(line)
      const aPath = parsed?.aPath ?? ''
      const bPath = parsed?.bPath ?? ''
      // 同时检查 a/ 与 b/ 双侧，防止将 .env 重命名为普通文件名绕过过滤
      const skipPath =
        aPath && shouldSkipDiffPath(aPath)
          ? aPath
          : bPath && shouldSkipDiffPath(bPath)
            ? bPath
            : ''
      if (skipPath) {
        skippingFile = true
        appendSanitized(`diff --git a/${aPath || skipPath} b/${bPath || skipPath}`)
        appendSanitized(`[omitted: ${classifyAttentionPath(skipPath)}]`)
        return
      }
      skippingFile = false
      appendSanitized(line)
      return
    }
    if (skippingFile) return
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      appendSanitized(line)
      skippingFile = true
      redactState.inPrivateKeyBlock = false
      return
    }
    appendSanitized(redactDiffLine(line, redactState))
  }

  const resetFileState = () => {
    skippingFile = false
    redactState.inPrivateKeyBlock = false
  }

  const finalize = (streamTruncated = false): NonNullable<CloudTaskResult['diff']> | undefined => {
    if (lineCount === 0 || keptLines.length === 0) return undefined
    if (!streamTruncated && totalBytes <= maxBytes) {
      const fullText = keptLines.join('\n').trim()
      if (!fullText) return undefined
      return { bytes: Buffer.byteLength(fullText, 'utf8'), excerpt: fullText }
    }

    const notice =
      totalBytes > maxBytes
        ? `\n... [truncated, total ${totalBytes}${streamTruncated ? '+' : ''} bytes > limit ${maxBytes} bytes]`
        : '\n... [truncated, diff stream exceeded limit]'
    const budget = Math.max(128, maxBytes - Buffer.byteLength(notice, 'utf8'))
    const kept: string[] = []
    let used = 0
    for (const line of keptLines) {
      const lineBytes = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0)
      if (used + lineBytes > budget) {
        if (kept.length === 0) {
          kept.push(sliceUtf8ByBytes(line, budget))
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

  return { pushRawLine, resetFileState, finalize }
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
  if (!rawDiff.trim()) return undefined
  const sanitizer = createDiffSanitizer(limitBytes)
  for (const line of rawDiff.split(/\r?\n/)) {
    sanitizer.pushRawLine(line)
  }
  return sanitizer.finalize(false)
}

/**
 * 采集工单工作树里的脱敏 diff（含相对 base 的已提交 + 未提交改动 + 未跟踪文本文件）。
 * 使用流式 `spawn` 强制 raw 字节上限，超大 diff 截断后正常返回脱敏摘要而非静默丢弃。
 */
export async function collectTaskDiff(
  base: string | undefined,
  worktreePath: string,
  limitBytes?: number,
  options?: { maxRawBytes?: number }
): Promise<NonNullable<CloudTaskResult['diff']> | undefined> {
  const maxRawBytes = options?.maxRawBytes ?? DEFAULT_GIT_STREAM_MAX_BYTES
  const sanitizer = createDiffSanitizer(limitBytes)
  let streamTruncated = false

  const streamDiff = async (args: string[]): Promise<boolean> => {
    sanitizer.resetFileState()
    const res = await streamGitLines(worktreePath, args, {
      maxBytes: maxRawBytes,
      onLine: (line) => {
        sanitizer.pushRawLine(line)
      },
    })
    if (res.truncated) streamTruncated = true
    return res.ok
  }

  let diffResolved = false
  if (base) {
    diffResolved = await streamDiff(['diff', '--no-color', '-U3', base])
  }
  if (!diffResolved) {
    // `git diff HEAD` 已包含相对 HEAD 的已暂存 + 未暂存改动，成功后绝不能再追加 `git diff` 否则重复
    diffResolved = await streamDiff(['diff', '--no-color', '-U3', 'HEAD'])
  }
  if (!diffResolved) {
    for (const args of [
      ['diff', '--no-color', '-U3', '--cached'],
      ['diff', '--no-color', '-U3'],
    ]) {
      await streamDiff(args)
    }
  }

  // 未跟踪新文件：构造标准 unified diff 片段，排除 .env* / lockfile / 二进制 / 超大文件
  const untracked: string[] = []
  const listed = await streamGitLines(
    worktreePath,
    ['ls-files', '--others', '--exclude-standard'],
    {
      maxBytes: 1024 * 1024,
      onLine: (line) => {
        const normalized = normalizePosix(unquoteGitPath(line.trim()))
        if (normalized) untracked.push(normalized)
        return untracked.length < MAX_UNTRACKED_FILES
      },
    }
  )
  if (listed.ok) {
    for (const relPath of untracked) {
      sanitizer.resetFileState()
      if (shouldSkipDiffPath(relPath)) {
        sanitizer.pushRawLine(`diff --git a/${relPath} b/${relPath}`)
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
        sanitizer.pushRawLine(`diff --git a/${relPath} b/${relPath}`)
        sanitizer.pushRawLine('new file')
        sanitizer.pushRawLine('--- /dev/null')
        sanitizer.pushRawLine(`+++ b/${relPath}`)
        sanitizer.pushRawLine(`@@ -0,0 +1,${lines.length} @@`)
        for (const line of lines) {
          sanitizer.pushRawLine(`+${line}`)
        }
      } catch {
        // 跳过不可读或已删文件
      }
    }
  }

  return sanitizer.finalize(streamTruncated)
}
