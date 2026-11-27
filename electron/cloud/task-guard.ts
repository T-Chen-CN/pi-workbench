/**
 * 工单会话的工具守卫（G8 / D-32 / D4）。
 *
 * 约束：
 * 1. `write` / `edit` 以及 `read` / `ls` / `grep` / `find` 的显式目标路径必须落在工单工作树内（省略路径时默认工作树 cwd 放行）；
 * 2. `bash` / `powershell` 里 `git push`、`curl … | sh` 一类管道执行直接拒绝；
 * 3. `rm` / `del` / `rmdir` / `Remove-Item`（无论是否带递归/强制参数）的每个目标都必须落在工作树内。
 *
 * `tool_call` 的分发循环没有 try/catch，handler 自己抛错会掀掉整轮，
 * 所以任何异常都必须在这里 catch 掉并按拒绝处理（fail-closed）。
 */

import { execFile } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { canonicalizePath, isPathInsideRoot, normalizeForComparison } from '../path-safety.js'
import { sanitizeTerminalEnv } from '../terminal-manager.js'

const execFileAsync = promisify(execFile)
const HOOK_GIT_TIMEOUT_MS = 10_000
const PRE_PUSH_SCRIPT =
  '#!/bin/sh\necho "[pi-workbench] git push is blocked in delegated task worktrees." >&2\nexit 1\n'

const WRITE_TOOLS = new Set(['write', 'edit'])
const READ_TOOLS = new Set(['read', 'ls', 'grep', 'find'])
const SHELL_TOOLS = new Set(['bash', 'powershell'])
const WRITE_PATH_KEYS = ['path', 'file_path', 'filePath', 'target'] as const
const READ_PATH_KEYS = ['path', 'file_path', 'filePath', 'target', 'dir', 'directory', 'cwd'] as const
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/** 管道执行：下载内容直接进 shell / 解释器，或下载落地后直接执行 */
const PIPE_TO_SHELL =
  /(?:^|[^\w])(curl|wget|iwr|invoke-webrequest)\b[\s\S]*?(?:\||>\s*\S*\s*|(?:-o|--output|-O|--output-document|-OutFile)\s+\S+[\s\S]*?(?:&&|;|\n))[\s\S]*?\b(?:sudo\s+)?(?:(?:ba|z|k|da)?sh|pwsh|powershell|iex|invoke-expression|python3?|node|eval)\b/i
/** 提示词挡不住注入，推送必须硬拦（F-19）；只拦截 git 子命令位置的 push，避免误杀 commit message */
const GIT_PUSH =
  /(?:^|[;&|\n`($]\s*|\s)(?:(?:\/[^\s"']*\/)?g['"]*i['"]*t(?:\.exe)?)(?:\s+(?:-[Cc]\s+\S+|-[^\s]+|--[a-z-]+(?:=\S+)?))*\s+p['"]*u['"]*s['"]*h\b/i
const RM_COMMAND =
  /(?:^|[\s;&|(])(?:(?:\/[^\s;&|]*\/)?(rm|del|rmdir|remove-item|ri))(?:\.exe)?\s+([^\n;&|]*)/gi
const CD_COMMAND = /(?:^|[;&|\n]\s*)(?:cd|set-location|sl|chdir)\s+([^\n;&|]+)/i

export interface TaskGuardInfo {
  toolName: string
  reason: string
  cwd: string
}

export interface TaskGuardContext {
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
  /** 被拦下时上报给 device agent，便于在工单进度里展示（不阻塞） */
  onBlocked?: (info: TaskGuardInfo) => void
}

function isInside(root: string, target: string): boolean {
  return isPathInsideRoot(root, target)
}

/**
 * 解析工具参数里的路径，与 Pi SDK `resolveToCwd` 对齐：
 * 剥离前导 `@`、归一化 Unicode 空格、展开 `~` / `~/`，再按 cwd 解析并经 fail-closed `canonicalizePath` 规范化。
 * 遇到符号链接循环或超深路径时返回 `null`（绝不 fail-open 回落到未解析的 `path.resolve`）。
 */
function resolveToolPath(cwd: string, input: string): string | null {
  let normalized = input.replace(UNICODE_SPACES, ' ')
  if (normalized.startsWith('@')) normalized = normalized.slice(1)
  if (normalized === '~') {
    normalized = os.homedir()
  } else if (normalized.startsWith('~/') || normalized.startsWith('~\\')) {
    normalized = path.join(os.homedir(), normalized.slice(2))
  }
  const resolved = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized)
  return canonicalizePath(resolved)
}

/** 取出该次调用涉及的写入路径（不同工具参数名不一致） */
function writeTargets(input: Record<string, unknown>): string[] {
  const targets: string[] = []
  for (const key of WRITE_PATH_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) targets.push(value.trim())
  }
  return targets
}

/** 取出该次读/列/搜工具显式指定的路径；省略路径参数时默认落在工作树 cwd，返回空数组 */
function readTargets(input: Record<string, unknown>): string[] {
  const targets: string[] = []
  for (const key of READ_PATH_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) targets.push(value.trim())
  }
  if (Array.isArray(input.paths)) {
    for (const item of input.paths) {
      if (typeof item === 'string' && item.trim()) targets.push(item.trim())
    }
  }
  return targets
}

/** 折叠行续接（`\\\n` 与 PowerShell `` `\n ``）以便多行命令无法绕过正则 */
function flattenCommand(command: string): string {
  return command.replace(/(?:\\|`)\r?\n/g, ' ')
}

/** 简单按 shell 引号切分参数，保留含空格的带引号路径 */
function tokenizeShellArgs(args: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(args)) !== null) {
    const val = m[1] ?? m[2] ?? m[3] ?? ''
    if (val) tokens.push(val)
  }
  return tokens
}

/** 从 rm / del / rmdir / Remove-Item 段里取出目标路径；返回越界的那一个（有则拒绝） */
function escapingRmTarget(cwd: string, root: string, command: string): string | null {
  const flat = flattenCommand(command)
  const canonicalRoot = canonicalizePath(root)
  // 若命令前段含 cd/Set-Location 切目录，跟踪有效工作目录避免 `cd .. && rm -rf dir` 绕过
  let effectiveCwd: string | null = canonicalizePath(cwd)
  const segments = flat.split(/(?:&&|\|\||[;\n|])+/)
  for (const segment of segments) {
    const cdMatch = CD_COMMAND.exec(segment)
    if (cdMatch) {
      const cdTarget = tokenizeShellArgs(cdMatch[1] ?? '')[0]
      if (!cdTarget || cdTarget === '-' || cdTarget.includes('$')) {
        effectiveCwd = canonicalizePath(os.homedir())
      } else {
        effectiveCwd = effectiveCwd ? resolveToolPath(effectiveCwd, cdTarget) : null
      }
      continue
    }

    RM_COMMAND.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = RM_COMMAND.exec(segment)) !== null) {
      const cmd = (match[1] ?? '').toLowerCase()
      const args = match[2] ?? ''
      const isWindowsCmd = cmd === 'del' || cmd === 'rmdir'

      const rawTokens = tokenizeShellArgs(args)
      const targets: string[] = []
      let afterDoubleDash = false
      for (let i = 0; i < rawTokens.length; i += 1) {
        const token = rawTokens[i]
        if (!afterDoubleDash) {
          if (token === '--') {
            afterDoubleDash = true
            continue
          }
          // 处理 PowerShell `-Path=...` / `-LiteralPath=...` 与 `-Path <val>`
          const psPathEq = /^-(?:literal)?path=(.+)$/i.exec(token)
          if (psPathEq) {
            targets.push(psPathEq[1])
            continue
          }
          if (/^-(?:literal)?path$/i.test(token) && i + 1 < rawTokens.length) {
            targets.push(rawTokens[++i])
            continue
          }
          if (token.startsWith('-') || (isWindowsCmd && /^\/[a-zA-Z]$/i.test(token))) continue
        }
        targets.push(token)
      }
      if (targets.length === 0) continue

      // fail-closed：无法解析工作树根或当前工作目录（如符号链接循环）时一律拒绝删除
      if (!canonicalRoot || !effectiveCwd) return targets[0]

      for (const raw of targets) {
        const cleaned = raw.replace(/^['"]|['"]$/g, '')
        if (!cleaned) continue
        // 通配符、环境变量或家目录展开：先检查静态前缀（阻断 `rm -rf link/*` 符号链接父目录）
        if (/[$*?~]/.test(cleaned)) {
          if (
            cleaned.startsWith('/') ||
            cleaned.startsWith('~') ||
            cleaned.includes('$') ||
            cleaned.includes('..') ||
            /^[A-Za-z]:/.test(cleaned)
          ) {
            return cleaned
          }
          const staticPrefix = cleaned.split(/[*?]/)[0].replace(/[\\/]+$/, '')
          const prefixTarget = resolveToolPath(effectiveCwd, staticPrefix || '.')
          if (!prefixTarget || !isPathInsideRoot(canonicalRoot, prefixTarget)) return cleaned
          continue
        }
        const target = resolveToolPath(effectiveCwd, cleaned)
        if (!target || !isPathInsideRoot(canonicalRoot, target)) return target ?? cleaned
      }
    }
  }
  return null
}

export function createTaskGuardExtension(context: TaskGuardContext): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event, extensionCtx) => {
      try {
        const eventRecord = event as unknown as Record<string, unknown>
        const toolName = String(eventRecord?.toolName ?? '')
        const input = (eventRecord?.input ?? eventRecord?.args ?? {}) as Record<string, unknown>
        const guarded =
          WRITE_TOOLS.has(toolName) || READ_TOOLS.has(toolName) || SHELL_TOOLS.has(toolName)
        const cwd = String((extensionCtx as { cwd?: unknown } | undefined)?.cwd ?? '')
        if (!cwd) {
          if (!guarded) return undefined
          // fail-closed：读写/命令工具缺失 cwd 时无法校验工作树边界，必须拒绝
          return {
            block: true,
            reason: 'Cannot determine task working directory; blocking tool call (fail-closed).',
          }
        }
        const root = canonicalizePath(cwd)
        if (!root) {
          if (!guarded) return undefined
          return {
            block: true,
            reason: 'Cannot resolve task working directory; blocking tool call (fail-closed).',
          }
        }

        const block = (reason: string) => {
          try {
            context.logger.info(`[Cloud Task] Blocked ${toolName}: ${reason}`)
            context.onBlocked?.({ toolName, reason, cwd: root })
          } catch {
            // 上报失败不影响拦截结论
          }
          return { block: true, reason }
        }

        if (WRITE_TOOLS.has(toolName)) {
          for (const raw of writeTargets(input)) {
            const resolved = resolveToolPath(root, raw)
            if (!resolved) {
              return block(
                `Refusing to write to unresolvable path (possible symlink loop): ${raw}.`
              )
            }
            if (!isPathInsideRoot(root, resolved)) {
              return block(
                `Refusing to write outside the task worktree: ${resolved}. Stay inside ${root}.`
              )
            }
          }
          return undefined
        }

        if (READ_TOOLS.has(toolName)) {
          for (const raw of readTargets(input)) {
            const resolved = resolveToolPath(root, raw)
            if (!resolved) {
              return block(
                `Refusing to read unresolvable path (possible symlink loop): ${raw}.`
              )
            }
            if (!isPathInsideRoot(root, resolved)) {
              return block(
                `Refusing to read outside the task worktree: ${resolved}. Stay inside ${root}.`
              )
            }
          }
          return undefined
        }

        if (SHELL_TOOLS.has(toolName)) {
          const command = String(input.command ?? input.script ?? input.cmd ?? '')
          if (!command) return undefined
          const flat = flattenCommand(command)
          if (GIT_PUSH.test(flat)) {
            return block(
              'Pushing to a remote is not allowed in a delegated task. Commit locally if needed and report the branch instead.'
            )
          }
          if (PIPE_TO_SHELL.test(flat)) {
            return block(
              'Running downloaded content through a shell (curl | sh) is not allowed in a delegated task.'
            )
          }
          const escaping = escapingRmTarget(root, root, flat)
          if (escaping) {
            return block(
              `Refusing to delete outside the task worktree: ${escaping}. Stay inside ${root}.`
            )
          }
          return undefined
        }

        return undefined
      } catch (error) {
        // fail-closed：守卫自己出错时不允许调用通过，但绝不能把异常抛给分发循环
        try {
          context.logger.warn('[Cloud Task] Task guard failed, blocking call:', error)
        } catch {
          // ignore
        }
        return {
          block: true,
          reason: 'The task guard could not evaluate this tool call, so it was blocked.',
        }
      }
    })
  }
}

/**
 * 为工单工作树安装专属 `pre-push` hook（D-32 / A-44）。
 *
 * 必须通过 `extensions.worktreeConfig` + `git config --worktree core.hooksPath`
 * 把钩子限定在工单工作树私有的 `.git/worktrees/<name>/cloud-hooks` 里，
 * 绝不写入共享的 `.git/hooks`——否则会把用户自己在主工作树的正常推送一起拦掉。
 * 随 `git worktree remove` 自动清理。
 */
export async function installWorktreePrePushHook(
  repoPath: string,
  worktreePath: string
): Promise<{ ok: boolean; hookPath?: string; error?: string }> {
  const runGit = (cwd: string, args: string[]): Promise<string> =>
    execFileAsync('git', ['-C', cwd, ...args], {
      timeout: HOOK_GIT_TIMEOUT_MS,
      windowsHide: true,
      env: sanitizeTerminalEnv(process.env),
    }).then((result) => result.stdout.trim())

  try {
    const rawGitDir = await runGit(worktreePath, ['rev-parse', '--git-dir'])
    const rawCommonDir = await runGit(worktreePath, ['rev-parse', '--git-common-dir'])
    const gitDir = canonicalizePath(path.resolve(worktreePath, rawGitDir))
    const commonDir = canonicalizePath(path.resolve(worktreePath, rawCommonDir))
    if (!gitDir || !commonDir) {
      return { ok: false, error: 'Cannot resolve git directory paths for worktree' }
    }
    if (normalizeForComparison(commonDir) === normalizeForComparison(gitDir)) {
      return { ok: false, error: 'Refusing to install pre-push hook on the main worktree' }
    }

    const hooksDir = path.join(gitDir, 'cloud-hooks')
    const hookPath = path.join(hooksDir, 'pre-push')
    await fsp.mkdir(hooksDir, { recursive: true })
    await fsp.writeFile(hookPath, PRE_PUSH_SCRIPT, { encoding: 'utf-8', mode: 0o755 })
    await fsp.chmod(hookPath, 0o755).catch(() => undefined)

    await runGit(repoPath, ['config', 'extensions.worktreeConfig', 'true'])
    await runGit(worktreePath, [
      'config',
      '--worktree',
      'core.hooksPath',
      hooksDir.replace(/\\/g, '/'),
    ])
    return { ok: true, hookPath }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 给测试用的纯函数版本 */
export const taskGuardInternals = { isInside, escapingRmTarget, PIPE_TO_SHELL, GIT_PUSH }
