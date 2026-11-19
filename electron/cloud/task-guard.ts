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

import * as path from 'node:path'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

const WRITE_TOOLS = new Set(['write', 'edit'])
const SHELL_TOOLS = new Set(['bash', 'powershell'])

/** 管道执行：下载内容直接进 shell，是把远端内容变成命令的标准注入手法 */
const PIPE_TO_SHELL = /(?:^|[^\w])(curl|wget|iwr|invoke-webrequest)\b[^\n]*(?:\||>\s*\S*\s*)[^\n]*\b(?:sudo\s+)?(?:ba|z|k|da)?sh\b/i
/** 提示词挡不住注入，推送必须硬拦（F-19）；pre-push hook 是第二道 */
const GIT_PUSH = /\bgit\b[^\n]*\bpush\b/i
const RM_COMMAND = /(?:^|[\s;&|(])(rm|del|rmdir)\s+([^\n]*)/gi

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

/** 解析工具参数里的路径；相对路径按会话 cwd 展开 */
function resolveToolPath(cwd: string, input: string): string {
  return path.isAbsolute(input) ? path.resolve(input) : path.resolve(cwd, input)
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

/** 从 rm 段里取出目标路径；返回越界的那一个（有则拒绝） */
function escapingRmTarget(cwd: string, root: string, command: string): string | null {
  RM_COMMAND.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = RM_COMMAND.exec(command)) !== null) {
    const args = match[2] ?? ''
    // 只有带递归或强制删除的参数才按本条规则处理；普通 rm 单文件交给 1/2 条
    if (!/(^|\s)-[a-zA-Z]*(r|f)/.test(args)) continue
    const tokens = args.split(/\s+/).filter((token) => token && !token.startsWith('-'))
    if (tokens.length === 0) continue
    for (const token of tokens) {
      const cleaned = token.replace(/^['"]|['"]$/g, '')
      // 通配符与变量展开无法静态判断，按危险处理
      if (/[$*?]/.test(cleaned)) {
        if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) return cleaned
        continue
      }
      const target = resolveToolPath(cwd, cleaned)
      const { root: compareRoot, target: compareTarget } = normalizeForCompare(root, target)
      if (!isInside(compareRoot, compareTarget)) return target
    }
  }
  return null
}

export function createTaskGuardExtension(context: TaskGuardContext): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event: any, extensionCtx: any) => {
      try {
        const cwd = String(extensionCtx?.cwd ?? '')
        if (!cwd) return undefined
        const root = path.resolve(cwd)
        const toolName = String(event?.toolName ?? '')
        const input = (event?.input ?? event?.args ?? {}) as Record<string, unknown>

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
          if (GIT_PUSH.test(command)) {
            return block(
              'Pushing to a remote is not allowed in a delegated task. Commit locally if needed and report the branch instead.'
            )
          }
          if (PIPE_TO_SHELL.test(command)) {
            return block(
              'Running downloaded content through a shell (curl | sh) is not allowed in a delegated task.'
            )
          }
          const escaping = escapingRmTarget(root, root, command)
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
