/**
 * 云端数据 → 时间线片段。
 *
 * 两个来源：会话历史（`/api/sessions/{id}/messages`）与实时事件（SSE）。
 * 两者都映射到同一套 `CloudTracePart`，id 前缀区分来源：
 *   `h:` 历史（含序号，稳定）· `t:` 工具调用 · `s:` 流式产出。
 */

import type { CloudFrame, CloudRunStatus, CloudTracePart, CloudToolStatus } from './types.js'
import type { SseFrame } from './events.js'

const ARGS_MAX_CHARS = 240
const RESULT_MAX_CHARS = 1200

export interface RawMessage {
  id?: number | string
  role?: string
  content?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
  tool_call_id?: string | null
  tool_calls?:
    | Array<{
        id?: string
        call_id?: string
        function?: { name?: string; arguments?: string }
      }>
    | null
  tool_name?: string | null
  timestamp?: number
  display_kind?: string | null
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function flatten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** 保留换行的截断（工具输出按行阅读） */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 工具参数摘要：命令 / 路径 / 查询优先，其余回退成压缩后的 JSON */
export function summarizeArgs(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  if (!text.trim()) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return flatten(text, ARGS_MAX_CHARS)
  }
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    for (const key of ['command', 'cmd', 'path', 'file_path', 'query', 'pattern', 'url']) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.trim()) {
        return flatten(candidate, ARGS_MAX_CHARS)
      }
    }
    try {
      return flatten(JSON.stringify(parsed), ARGS_MAX_CHARS)
    } catch {
      return ''
    }
  }
  return flatten(text, ARGS_MAX_CHARS)
}

interface ToolResult {
  output: string
  exitCode?: number
  error: string | null
}

/** 工具返回体的实际形状：`{"output": "...", "exit_code": 0, "error": null}`，也可能是纯文本 */
export function parseToolResult(content: unknown): ToolResult {
  const text = textOf(content)
  if (!text.trim()) return { output: '', error: null }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const output =
        typeof parsed.output === 'string'
          ? parsed.output
          : typeof parsed.result === 'string'
            ? parsed.result
            : text
      return {
        output,
        exitCode: typeof parsed.exit_code === 'number' ? parsed.exit_code : undefined,
        error: typeof parsed.error === 'string' ? parsed.error : null,
      }
    }
  } catch {
    // 纯文本输出（非 JSON）
  }
  return { output: text, error: null }
}

function toolStatusOf(result: ToolResult): CloudToolStatus {
  if (result.error) return 'error'
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) return 'error'
  return 'success'
}

export interface MapMessagesOptions {
  /**
   * 历史默认视为已结束：没有返回结果的工具调用标成 error。
   * 会话仍在跑时不传（保持 running）。
   */
  settled?: boolean
}

/** 会话历史 → 时间线片段（顺序即后端返回顺序） */
export function mapMessages(rows: RawMessage[], options: MapMessagesOptions = {}): CloudTracePart[] {
  const settled = options.settled ?? true
  const parts: CloudTracePart[] = []
  const toolIndex = new Map<string, number>()

  const pushTool = (part: Extract<CloudTracePart, { type: 'tool' }>): number => {
    parts.push(part)
    return parts.length - 1
  }

  rows.forEach((row, index) => {
    const role = textOf(row.role)
    const key = String(row.id ?? index)

    if (role === 'session_meta') {
      parts.push({ type: 'divider', id: `h:${key}`, kind: 'session_meta' })
      return
    }

    if (role === 'user') {
      const text = textOf(row.content)
      if (text.trim()) parts.push({ type: 'text', id: `h:${key}`, role: 'user', text })
      return
    }

    if (role === 'assistant') {
      const reasoning = textOf(row.reasoning_content) || textOf(row.reasoning)
      if (reasoning.trim()) {
        parts.push({ type: 'thinking', id: `h:${key}:r`, text: reasoning })
      }
      const calls = Array.isArray(row.tool_calls) ? row.tool_calls : []
      calls.forEach((call, callOrder) => {
        const callId = textOf(call.call_id) || textOf(call.id) || `${key}:${callOrder}`
        toolIndex.set(callId, pushTool({
          type: 'tool',
          id: `t:${callId}`,
          toolCallId: callId,
          toolName: textOf(call.function?.name),
          argsSummary: summarizeArgs(call.function?.arguments),
          status: 'running',
        }))
      })
      const content = textOf(row.content)
      if (content.trim()) {
        parts.push({ type: 'text', id: `h:${key}`, role: 'assistant', text: content })
      }
      return
    }

    if (role === 'tool') {
      const callId = textOf(row.tool_call_id)
      const result = parseToolResult(row.content)
      const patch = {
        status: toolStatusOf(result),
        resultPreview: clip(result.output, RESULT_MAX_CHARS),
        exitCode: result.exitCode,
      }
      const target = callId ? toolIndex.get(callId) : undefined
      if (target !== undefined) {
        const existing = parts[target] as Extract<CloudTracePart, { type: 'tool' }>
        parts[target] = { ...existing, ...patch }
        return
      }
      pushTool({
        type: 'tool',
        id: `t:${callId || `h:${key}`}`,
        toolCallId: callId,
        toolName: textOf(row.tool_name),
        argsSummary: '',
        ...patch,
      })
    }
  })

  if (settled) {
    return parts.map((part) =>
      part.type === 'tool' && part.status === 'running'
        ? { ...part, status: 'error' as const }
        : part
    )
  }
  return parts
}

/** 把一次实时事件翻译成时间线增量与状态帧 */
export class RunMapper {
  readonly runId: string
  readonly parts: CloudTracePart[] = []
  private textId: string | null = null
  private textSeq = 0
  private toolSeq = 0
  /** 终态事件带回的未投递插话（pending_steer） */
  private lastPendingSteer = ''

  constructor(runId: string) {
    this.runId = runId
  }

  /** 找到文本相同的那条插话（后插的优先） */
  private findInterjection(text: string): number {
    for (let index = this.parts.length - 1; index >= 0; index -= 1) {
      const part = this.parts[index]
      if (part.type !== 'interjection') continue
      if (!text || part.text === text) return index
    }
    return -1
  }

  /**
   * 终态事件可能带回 `pending_steer`：这段插话没送进本轮。
   * 必须在收尾时显示出来，否则用户以为插进去了。
   */
  private takePendingSteer(frames: CloudFrame[]): void {
    const pending = this.lastPendingSteer
    this.lastPendingSteer = ''
    if (!pending) return
    const index = this.findInterjection(pending)
    if (index >= 0) {
      const existing = this.parts[index] as Extract<CloudTracePart, { type: 'interjection' }>
      const next = { ...existing, delivered: false, undelivered: true }
      this.parts[index] = next
      frames.push({ kind: 'part', part: next })
      return
    }
    const part: CloudTracePart = {
      type: 'interjection',
      id: `s:steer:${this.parts.length}`,
      text: pending,
      delivered: false,
      undelivered: true,
    }
    this.parts.push(part)
    frames.push({ kind: 'part', part })
  }

  private ensureText(delta: string): CloudTracePart | null {
    if (!delta) return null
    if (this.textId) {
      const index = this.parts.findIndex((part) => part.id === this.textId)
      if (index >= 0) {
        const current = this.parts[index] as Extract<CloudTracePart, { type: 'text' }>
        const next = { ...current, text: current.text + delta }
        this.parts[index] = next
        return next
      }
    }
    const part: CloudTracePart = {
      type: 'text',
      id: `s:text:${this.textSeq++}`,
      role: 'assistant',
      text: delta,
    }
    this.textId = part.id
    this.parts.push(part)
    return part
  }

  private findTool(callId: string): number {
    return this.parts.findIndex(
      (part) => part.type === 'tool' && part.toolCallId === callId
    )
  }

  handle(frame: SseFrame): CloudFrame[] {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(frame.data) as Record<string, unknown>
    } catch {
      return []
    }
    const name = String(payload.event ?? frame.event ?? '')
    const frames: CloudFrame[] = []
    // 终态（completed / failed / cancelled）可能带回没送进去的插话
    if (typeof payload.pending_steer === 'string' && payload.pending_steer) {
      this.lastPendingSteer = String(payload.pending_steer)
    }

    switch (name) {
      case 'message.delta': {
        const part = this.ensureText(textOf(payload.delta))
        if (part) frames.push({ kind: 'part', part })
        break
      }
      case 'message.interim': {
        // already_streamed=true 表示这段文字已经通过 delta 推过，避免重复
        if (payload.already_streamed === true) break
        const part = this.ensureText(textOf(payload.text))
        if (part) frames.push({ kind: 'part', part })
        break
      }
      case 'reasoning.available': {
        const text = textOf(payload.text)
        if (!text.trim()) break
        const part: CloudTracePart = {
          type: 'thinking',
          id: `s:thinking:${frame.id ?? this.parts.length}`,
          text,
        }
        this.parts.push(part)
        frames.push({ kind: 'part', part })
        break
      }
      case 'tool.started': {
        const callId = textOf(payload.tool_call_id) || `s:tool:${this.toolSeq++}`
        const part: CloudTracePart = {
          type: 'tool',
          id: `t:${callId}`,
          toolCallId: callId,
          toolName: textOf(payload.tool),
          argsSummary: flatten(textOf(payload.preview), ARGS_MAX_CHARS),
          status: 'running',
        }
        this.parts.push(part)
        // 工具之后的文字属于新的一段
        this.textId = null
        frames.push({ kind: 'part', part })
        break
      }
      case 'tool.completed': {
        const callId = textOf(payload.tool_call_id)
        const index = callId ? this.findTool(callId) : -1
        const patch = {
          status: payload.error === true ? ('error' as const) : ('success' as const),
          resultPreview: clip(textOf(payload.preview), RESULT_MAX_CHARS),
          durationMs:
            typeof payload.duration === 'number' ? Math.round(payload.duration * 1000) : undefined,
        }
        if (index >= 0) {
          const existing = this.parts[index] as Extract<CloudTracePart, { type: 'tool' }>
          const next = { ...existing, ...patch }
          this.parts[index] = next
          frames.push({ kind: 'part', part: next })
        } else {
          const part: CloudTracePart = {
            type: 'tool',
            id: `t:${callId || `s:tool:${this.toolSeq++}`}`,
            toolCallId: callId,
            toolName: textOf(payload.tool),
            argsSummary: '',
            ...patch,
          }
          this.parts.push(part)
          frames.push({ kind: 'part', part })
        }
        this.textId = null
        break
      }
      case 'approval.request': {
        const requestId = textOf(payload.request_id) || `s:approval:${frame.id ?? 0}`
        const part: CloudTracePart = {
          type: 'approval',
          id: `a:${requestId}`,
          requestId,
          generation: typeof payload.generation === 'number' ? payload.generation : 1,
          summary: flatten(
            textOf(payload.summary) || textOf(payload.preview) || textOf(payload.command),
            200
          ),
        }
        this.parts.push(part)
        frames.push({ kind: 'part', part })
        break
      }
      case 'approval.responded': {
        const requestId = textOf(payload.request_id)
        const index = this.parts.findIndex(
          (part) => part.type === 'approval' && part.requestId === requestId
        )
        if (index >= 0) {
          const existing = this.parts[index] as Extract<CloudTracePart, { type: 'approval' }>
          const decision =
            payload.choice === 'deny' || payload.choice === 'denied' ? 'deny' : 'allow'
          const next = { ...existing, decision: decision as 'allow' | 'deny' }
          this.parts[index] = next
          frames.push({ kind: 'part', part: next })
        }
        break
      }
      case 'run.completed': {
        const output = textOf(payload.output)
        if (output.trim()) {
          const streamed = this.parts
            .filter((part): part is Extract<CloudTracePart, { type: 'text' }> => part.type === 'text')
            .map((part) => part.text)
            .join('')
          if (!streamed.includes(output.trim())) {
            const part: CloudTracePart = {
              type: 'text',
              id: `s:final`,
              role: 'assistant',
              text: output,
            }
            this.parts.push(part)
            frames.push({ kind: 'part', part })
          }
        }
        frames.push({ kind: 'run', runId: this.runId, state: 'completed' })
        this.takePendingSteer(frames)
        break
      }
      case 'run.failed':
      case 'run.interrupted': {
        frames.push({
          kind: 'run',
          runId: this.runId,
          state: 'failed' as CloudRunStatus,
          error: textOf(payload.error) || '本轮执行失败',
        })
        this.takePendingSteer(frames)
        break
      }
      case 'run.steered': {
        // 插话已投递：把最后一条还挂着 interjection 的片段标成 delivered
        const text = textOf(payload.input) || textOf(payload.message) || textOf(payload.text)
        const index = this.findInterjection(text)
        if (index >= 0) {
          const existing = this.parts[index] as Extract<CloudTracePart, { type: 'interjection' }>
          const next = { ...existing, delivered: true }
          this.parts[index] = next
          frames.push({ kind: 'part', part: next })
        }
        break
      }
      case 'run.cancelled': {
        frames.push({ kind: 'run', runId: this.runId, state: 'cancelled' })
        this.takePendingSteer(frames)
        break
      }
      default:
        // run.queued / subagent.* 等不进入时间线
        break
    }

    return frames
  }
}
