/**
 * 派活轨迹：本地 Agent 在一条派活任务里**做过哪些步骤**（工具调用）。
 *
 * 用途只有一个：云端 Agent 事后**查**（`local_task_trace`）—— 用户问「它到底改了
 * 什么」、模型判断要不要重派时，需要看到步骤而不是只有一句摘要。
 *
 * 三条硬约束：
 * - **不推送**：轨迹不发事件、不进 SSE 帧，只在终态回报里带一份紧凑副本；
 * - **有上限**：最多 200 步 / 单文件 64KB，回报副本再压到 24KB，否则一条任务就能
 *   把云端上下文与数据库撑爆；
 * - **不留绝对路径**：文件一律记相对工作区的路径，摘要里的绝对路径做脱敏，
 *   轨迹是给「云端看的」，不该泄漏本机目录结构。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/** 单步：一次工具调用（成功或失败） */
export interface DispatchTraceStep {
  /** 开始时间（epoch ms） */
  at: number
  tool: string
  /** 参数摘要（已脱敏、已截断） */
  args: string
  ok: boolean
  ms: number
  /** 结果摘要（已脱敏、已截断） */
  result?: string
  /** 改到的文件（相对工作区路径） */
  file?: string
}

export interface DispatchTrace {
  steps: DispatchTraceStep[]
  /** 实际发生过的步数（可能大于 `steps.length`：超出上限后不再追加） */
  total: number
  truncated: boolean
  /** 从任务开始到结束的耗时 */
  ms: number
}

export const MAX_STEPS = 200
export const MAX_ARGS_CHARS = 200
export const MAX_RESULT_CHARS = 160
/** 回报里带的轨迹副本上限：超过就只带最近若干步 */
export const MAX_REPORT_CHARS = 24_000
/** 本地轨迹文件保留数量（缓存，不是审计） */
export const MAX_TRACE_FILES = 50

const FILE_MAX_BYTES = 64 * 1024

/** `{appDir}/cache/dispatch-traces` */
export function traceDir(appDir: string): string {
  return path.join(appDir, 'cache', 'dispatch-traces')
}

export function tracePath(dir: string, taskId: string): string {
  return path.join(dir, `${sanitize(taskId)}.json`)
}

function sanitize(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'task'
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/**
 * 摘要脱敏：把本机绝对路径压成相对工作区的写法。
 *
 * 参数与结果摘要里会出现 `D:\work\repo\src\a.ts` 这种路径，直接上报等于把本机
 * 目录结构送给云端；只保留工作区内相对路径，工作区外的写成 `<外部路径>`。
 */
export function redact(text: string, workspacePath: string): string {
  if (!text) return ''
  const root = workspacePath.replace(/[\\/]+$/, '')
  let out = text
  // 先按两种写法摘掉工作区根（原文可能用 / 也可能用反斜杠）
  const variants = [root, root.split('\\').join('/'), root.split('/').join('\\')]
  // git-bash 写法：`D:\work\repo` 也会被写成 `/d/work/repo`
  const drive = /^([A-Za-z]):[\\/]/.exec(root)
  if (drive) {
    const rest = root.slice(2).split('\\').join('/')
    variants.push(`/${drive[1].toLowerCase()}${rest}`)
  }
  for (const variant of new Set(variants)) {
    if (!variant || variant === '/' || variant === '\\') continue
    out = out.split(variant).join('')
  }
  // 其它盘符的绝对路径 → 只留文件名
  out = out.replace(/[A-Za-z]:[\\/][^\s"'`),;]+/g, (hit) =>
    path.basename(hit.replace(/[\\/]+$/, ''))
  )
  // Unix 绝对路径（家目录 / 临时目录 / 系统目录）→ 只留文件名
  out = out.replace(
    /(^|[\s"'(])\/(?:home|Users|root|tmp|var|etc)\/[^\s"'`),;]+/g,
    (hit: string, prefix: string) => {
      const base = path.basename(hit.slice(prefix.length).replace(/[\\/]+$/, ''))
      return `${prefix}${base}`
    }
  )
  // git-bash 的盘符挂载写法（`/d/tmp/x`）同理 — 工作区根已在上面摘掉，剩下的都是外面的
  out = out.replace(
    /(^|[\s"'(])\/[a-z]\/[^\s"'`),;]+/g,
    (hit: string, prefix: string) => {
      const base = path.basename(hit.slice(prefix.length).replace(/[\\/]+$/, ''))
      return `${prefix}${base}`
    }
  )
  return out
}

/**
 * 收集一条任务的步骤。
 *
 * 与 `AgentTraceEvent` 的对应关系：`tool_start` 落开始时间与参数摘要，`tool_end`
 * 收尾成一步。未收尾的调用（进程崩溃 / 取消）也补成一步并标失败，否则轨迹会
 * 「少最后一步」，读的人会以为任务是被截断的。
 */
export class TraceCollector {
  private readonly steps: DispatchTraceStep[] = []
  private readonly pending = new Map<string, { at: number; tool: string; args: string }>()
  private startedAt: number
  private total = 0
  private truncated = false

  constructor(
    private readonly taskId: string,
    private readonly workspacePath: string,
    private readonly now: () => number = () => Date.now()
  ) {
    this.startedAt = now()
  }

  note(event: {
    type: string
    toolCallId?: string
    toolName?: string
    argsSummary?: string
    status?: 'success' | 'error'
    durationMs?: number
    resultPreview?: string
    filePath?: string
  }): void {
    if (event.type === 'tool_start' && event.toolCallId) {
      this.pending.set(event.toolCallId, {
        at: this.now(),
        tool: event.toolName ?? 'tool',
        args: clip(redact(event.argsSummary ?? '', this.workspacePath), MAX_ARGS_CHARS),
      })
      return
    }
    if (event.type === 'tool_end' && event.toolCallId) {
      const started = this.pending.get(event.toolCallId)
      this.pending.delete(event.toolCallId)
      this.push({
        at: started?.at ?? this.now(),
        tool: event.toolName ?? started?.tool ?? 'tool',
        args: started?.args ?? '',
        ok: event.status !== 'error',
        ms: Math.max(0, Math.round(event.durationMs ?? 0)),
        result: clip(redact(event.resultPreview ?? '', this.workspacePath), MAX_RESULT_CHARS),
        file: event.filePath ? relativeFile(event.filePath, this.workspacePath) : undefined,
      })
    }
  }

  /** 收尾：把还没结束的调用补成失败步骤（取消 / 崩溃路径） */
  finish(): void {
    for (const [, open] of this.pending) {
      this.push({
        at: open.at,
        tool: open.tool,
        args: open.args,
        ok: false,
        ms: this.now() - open.at,
        result: '（没有等到结果：任务被取消或中断）',
      })
    }
    this.pending.clear()
  }

  snapshot(): DispatchTrace {
    return {
      steps: this.steps.map((step) => ({ ...step })),
      total: this.total,
      truncated: this.truncated,
      ms: Math.max(0, this.now() - this.startedAt),
    }
  }

  /** 落盘（缓存，供排查与「回报丢失后重放」使用）；失败只影响排查，不影响任务 */
  async flush(dir: string): Promise<string> {
    const file = tracePath(dir, this.taskId)
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, JSON.stringify(clampForDisk(this.snapshot()), null, 1), 'utf8')
      await pruneTraces(dir)
    } catch {
      // 缓存写不进去不影响任务结果
    }
    return file
  }

  private push(step: DispatchTraceStep): void {
    this.total += 1
    if (this.steps.length >= MAX_STEPS) {
      this.truncated = true
      return
    }
    this.steps.push(step)
  }
}

function relativeFile(filePath: string, workspacePath: string): string {
  const normalized = path.normalize(filePath)
  const root = path.normalize(workspacePath)
  const rel = path.relative(root, normalized)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return path.basename(normalized)
  return rel.split(path.sep).join('/')
}

/** 读回一条任务的轨迹（不存在的返回 null） */
export async function readTrace(dir: string, taskId: string): Promise<DispatchTrace | null> {
  try {
    const raw = await fs.readFile(tracePath(dir, taskId), 'utf8')
    const parsed = JSON.parse(raw) as DispatchTrace
    if (!parsed || !Array.isArray(parsed.steps)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 压缩成回报里带的副本：先去掉结果摘要，还超就只留最近若干步。
 * 保留**最近**的步骤 —— 卡在哪一步通常比开头更重要。
 */
export function compactTrace(trace: DispatchTrace, budget = MAX_REPORT_CHARS): DispatchTrace {
  const fit = (candidate: DispatchTrace): string => JSON.stringify(candidate)
  const lean: DispatchTrace = {
    ...trace,
    steps: trace.steps.map((step) => ({ ...step, result: undefined })),
  }
  if (fit(lean).length <= budget) return lean
  let steps = lean.steps
  while (steps.length > 1 && fit({ ...lean, steps }).length > budget) {
    steps = steps.slice(Math.ceil(steps.length / 8))
  }
  return { ...lean, steps, truncated: true }
}

/** 只保留最近 N 个轨迹文件（按 mtime） */
export async function pruneTraces(dir: string, keep = MAX_TRACE_FILES): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const files = names.filter((name) => name.endsWith('.json'))
  if (files.length <= keep) return
  const stats = await Promise.all(
    files.map(async (name) => {
      const full = path.join(dir, name)
      const stat = await fs.stat(full).catch(() => null)
      return { full, at: stat?.mtimeMs ?? 0 }
    })
  )
  stats.sort((a, b) => b.at - a.at)
  for (const item of stats.slice(keep)) await fs.rm(item.full, { force: true }).catch(() => undefined)
}

/** 落盘用的体积上限（写文件前截断步数，避免缓存文件无界） */
export function clampForDisk(trace: DispatchTrace): DispatchTrace {
  let steps = trace.steps
  while (steps.length > 1 && JSON.stringify({ ...trace, steps }).length > FILE_MAX_BYTES) {
    steps = steps.slice(0, Math.floor(steps.length / 2))
  }
  return { ...trace, steps, truncated: trace.truncated || steps.length < trace.steps.length }
}
