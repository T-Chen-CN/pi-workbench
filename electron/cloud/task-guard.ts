/**
 * 工单会话的工具守卫（G8 / D-32）。
 *
 * 定位：**挡误伤与注入的主流路径，不是安全边界**。路径级完全隔离已被明确取消
 * （D-20）—— `bash` 能绕过任何路径检查，所以这里只做三件确定有用的事：
 * 1. `write` / `edit` 的绝对路径必须落在工作树内；
 * 2. `bash` / `powershell` 里 `git push`、`curl … | sh` 一类管道执行直接拒绝；
 * 3. `rm -rf` 的每个目标都必须落在工作树内。
 *
 * 约束：`tool_call` 的分发循环没有 try/catch，handler 自己抛错会掀掉整轮，
 * 所以任何异常都必须在这里 catch 掉并按拒绝处理（fail-closed）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

const WRITE_TOOLS = new Set(['write', 'edit'])
const SHELL_TOOLS = new Set(['bash', 'powershell'])

/** 管道执行：下载内容直接进 shell / 解释器，是把远端内容变成命令的标准注入手法 */
const PIPE_TO_SHELL =
  /(?:^|[^\w])(curl|wget|iwr|invoke-webrequest)\b[\s\S]*?(?:\||>\s*\S*\s*)[\s\S]*?\b(?:sudo\s+)?(?:(?:ba|z|k|da)?sh|pwsh|powershell|iex|invoke-expression|python3?|node|eval)\b/i
/** 提示词挡不住注入，推送必须硬拦（F-19）；pre-push hook 是第二道 */
const GIT_PUSH = /\bgit\b[\s\S]*?\bpush\b/i
const RM_COMMAND = /(?:^|[\s;&|(])(rm|del|rmdir|remove-item|ri)\s+([^\n;&|]*)/gi

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

/** 规范化真实路径（目标尚不存在时逐级向上 realpath 已存在祖先，阻断符号链接逃逸） */
function canonicalize(targetPath: string): string {
  let current = path.resolve(targetPath)
  const missing: string[] = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const resolved = fs.realpathSync.native(current)
      return missing.length > 0 ? path.join(resolved, ...missing.reverse()) : resolved
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(targetPath)
      missing.push(path.basename(current))
      current = parent
    }
  }
  return path.resolve(targetPath)
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  if (relative === '') return true
  if (relative.startsWith('..')) return false
  if (path.isAbsolute(relative)) return false
  return true
}

function normalizeForCompare(root: string, target: string): { root: string; target: string } {
  if (process.platform !== 'win32') return { root, target }
  return { root: root.toLowerCase(), target: target.toLowerCase() }
}

/** 解析工具参数里的路径；相对路径按会话 cwd 展开并用 realpath 防符号链接逃逸 */
function resolveToolPath(cwd: string, input: string): string {
  const resolved = path.isAbsolute(input) ? path.resolve(input) : path.resolve(cwd, input)
  return canonicalize(resolved)
}

/** 取出该次调用涉及的写入路径（不同工具参数名不一致） */
function writeTargets(input: Record<string, unknown>): string[] {
  const targets: string[] = []
  for (const key of ['path', 'file_path', 'filePath', 'target']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) targets.push(value.trim())
  }
  return targets
}

/** 折叠行续接（`\\\n`）以便多行命令无法绕过正则 */
function flattenCommand(command: string): string {
  return command.replace(/\\\r?\n/g, ' ')
}

/** 从 rm / del / rmdir / Remove-Item 段里取出目标路径；返回越界的那一个（有则拒绝） */
function escapingRmTarget(cwd: string, root: string, command: string): string | null {
  const flat = flattenCommand(command)
  const canonicalRoot = canonicalize(root)
  RM_COMMAND.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = RM_COMMAND.exec(flat)) !== null) {
    const cmd = (match[1] ?? '').toLowerCase()
    const args = match[2] ?? ''
    const hasRecursiveOrForce =
      cmd === 'del' || cmd === 'rmdir'
        ? /(^|\s)\/[sqf]\b/i.test(args) || /(^|\s)-[a-zA-Z]*(r|f)/i.test(args)
        : cmd === 'remove-item' || cmd === 'ri'
          ? /(^|\s)-(recurse|force|r|fo)\b/i.test(args)
          : /(^|\s)-[a-zA-Z]*(r|f)/.test(args) || /(^|\s)--(recursive|force)\b/i.test(args)
    if (!hasRecursiveOrForce) continue

    const tokens = args
      .split(/\s+/)
      .filter((token) => token && !token.startsWith('-') && !/^\/[a-zA-Z]$/i.test(token))
    if (tokens.length === 0) continue
    for (const token of tokens) {
      const cleaned = token.replace(/^['"]|['"]$/g, '')
      if (!cleaned) continue
      // 通配符、环境变量或家目录展开若可能逃出工作树（绝对路径、..、~、$），一律拦截
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
        continue
      }
      const target = resolveToolPath(cwd, cleaned)
      const { root: compareRoot, target: compareTarget } = normalizeForCompare(
        canonicalRoot,
        target
      )
      if (!isInside(compareRoot, compareTarget)) return target
    }
  }
  return null
}

export function createTaskGuardExtension(context: TaskGuardContext): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event: any, extensionCtx: any) => {
      try {
        const toolName = String(event?.toolName ?? '')
        const input = (event?.input ?? event?.args ?? {}) as Record<string, unknown>
        const guarded = WRITE_TOOLS.has(toolName) || SHELL_TOOLS.has(toolName)
        const cwd = String(extensionCtx?.cwd ?? '')
        if (!cwd) {
          if (!guarded) return undefined
          // fail-closed：写/命令工具缺失 cwd 时无法校验工作树边界，必须拒绝
          return {
            block: true,
            reason: 'Cannot determine task working directory; blocking tool call (fail-closed).',
          }
        }
        const root = canonicalize(cwd)

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
            const { root: compareRoot, target: compareTarget } = normalizeForCompare(root, resolved)
            if (!isInside(compareRoot, compareTarget)) {
              return block(
                `Refusing to write outside the task worktree: ${resolved}. Stay inside ${root}.`
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
              `Refusing a recursive delete outside the task worktree: ${escaping}. Stay inside ${root}.`
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

/** 给测试用的纯函数版本 */
export const taskGuardInternals = { isInside, escapingRmTarget, PIPE_TO_SHELL, GIT_PUSH }
