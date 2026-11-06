/**
 * 云端数据 → 时间线片段。
 *
 * 两个来源：会话历史（`/api/sessions/{id}/messages`）与实时事件（SSE）。
 * 两者都映射到同一套 `CloudTracePart`，id 前缀区分来源：
 *   `h:` 历史（含序号，稳定）· `t:` 工具调用 · `s:` 流式产出。
 */

import type {
  CloudApprovalChoice,
  CloudFrame,
  CloudRunStatus,
  CloudSubagentStatus,
  CloudToolStatus,
  CloudTracePart,
} from './types.js'
import type { SseFrame } from './events.js'

const ARGS_MAX_CHARS = 240
const RESULT_MAX_CHARS = 1200

/**
 * 我们允许回执的三个选项。
 * `always` 不在其中：它会把命令写进服务端永久白名单（`S-08` 禁止），
 * 所以**在映射层就丢掉**，渲染层拿不到也就发不出去。
 */
const APPROVAL_CHOICES: CloudApprovalChoice[] = ['once', 'session', 'deny']

function approvalChoicesOf(raw: unknown): CloudApprovalChoice[] {
  const list = Array.isArray(raw) ? raw.map((item) => String(item ?? '')) : []
  const kept = APPROVAL_CHOICES.filter((choice) => list.includes(choice))
  // 服务端没给 choices（旧版本 / 局部实现）时按标准三项给
  return kept.length > 0 ? kept : [...APPROVAL_CHOICES]
}

function approvalChoiceOf(raw: unknown): CloudApprovalChoice | null {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'once' || value === 'approved' || value === 'approve' || value === 'allow') {
    return 'once'
  }
  if (value === 'session') return 'session'
  if (value === 'deny' || value === 'denied' || value === 'cancel' || value === 'no') return 'deny'
  return null
}

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
function numOf(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

const SUBAGENT_STATUS: Record<string, CloudSubagentStatus> = {
  running: 'running',
  queued: 'running',
  completed: 'completed',
  ok: 'completed',
  failed: 'failed',
  error: 'failed',
  cancelled: 'failed',
  timeout: 'timeout',
}

function subagentStatusOf(value: unknown): CloudSubagentStatus {
  return SUBAGENT_STATUS[String(value ?? '').toLowerCase()] ?? 'running'
}

/** `output_tail` 是 [{tool, preview}] 之类的字典数组，压成一段可读文本 */
function tailTextOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : undefined
  const lines = value
    .map((item) => {
      if (typeof item === 'string') return item
      if (!item || typeof item !== 'object') return ''
      const row = item as Record<string, unknown>
      const name = textOf(row.tool) || textOf(row.name) || textOf(row.command)
      const body = textOf(row.output) || textOf(row.preview) || textOf(row.text)
      return [name, body].filter(Boolean).join(': ')
    })
    .filter(Boolean)
  return lines.length > 0 ? lines.join('\n').slice(-1200) : undefined
}

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
        // 被审批拦下的调用 `output` 是空的，真正的原因在 `error` 里
        // （"BLOCKED: Command denied by user…"）：不兜住的话卡片和审计都是一片空白
        resultPreview: clip(result.output || result.error || '', RESULT_MAX_CHARS),
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

  /** 收尾帧的可观测字段，缺哪个就不写哪个 */
  private subagentResult(
    payload: Record<string, unknown>
  ): Partial<Extract<CloudTracePart, { type: 'subagent' }>> {
    const seconds = numOf(payload.duration_seconds)
    const filesRead = Array.isArray(payload.files_read) ? payload.files_read.length : undefined
    const filesWritten = Array.isArray(payload.files_written)
      ? payload.files_written.length
      : undefined
    const result: Partial<Extract<CloudTracePart, { type: 'subagent' }>> = {
      status: subagentStatusOf(payload.status),
      summary: textOf(payload.summary) || undefined,
      durationMs: seconds === undefined ? undefined : Math.round(seconds * 1000),
      toolCount: numOf(payload.tool_count),
      inputTokens: numOf(payload.input_tokens),
      outputTokens: numOf(payload.output_tokens),
      reasoningTokens: numOf(payload.reasoning_tokens),
      apiCalls: numOf(payload.api_calls),
      costUsd: numOf(payload.cost_usd),
      filesRead,
      filesWritten,
      outputTail: tailTextOf(payload.output_tail),
      failureReason: textOf(payload.failure_reason) || undefined,
    }
    // 收尾帧不一定带 goal：缺了就别把 start 帧的 goal 覆盖成 undefined
    if (textOf(payload.goal)) result.goal = textOf(payload.goal)
    for (const key of Object.keys(result) as Array<keyof typeof result>) {
      if (result[key] === undefined) delete result[key]
    }
    return result
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

  /**
   * clarify 提问片段的唯一构造点：SSE 的 `clarify.request` 和
   * `GET /v1/runs/{id}` 的 `pending_controls` 两条路都走这里，按 prompt_id 去重。
   */
  ensureClarify(payload: Record<string, unknown>): CloudFrame[] {
    const promptId = textOf(payload.prompt_id) || textOf(payload.request_id)
    if (!promptId) return []
    if (this.parts.some((part) => part.type === 'clarify' && part.promptId === promptId)) return []
    const rawChoices = Array.isArray(payload.choices) ? payload.choices : []
    const generation = numOf(payload.execution_generation) ?? numOf(payload.generation) ?? 1
    const part: CloudTracePart = {
      type: 'clarify',
      id: `c:${promptId}`,
      promptId,
      generation,
      question: flatten(textOf(payload.question), 500) || '（没有给出问题）',
      choices: rawChoices.map((choice) => String(choice ?? '')).filter(Boolean),
      multiSelect: payload.multi_select === true,
      timeoutSeconds: numOf(payload.timeout_s),
    }
    this.parts.push(part)
    return [{ kind: 'part', part }]
  }

  /**
   * 审批请求片段的唯一构造点：SSE 的 `approval.request` 与 `GET /v1/runs/{id}`
   * 的 `pending_controls` 两条路都走这里。
   *
   * 去重键：服务端 `prompt_id` / `request_id`；两者都没有时退化为 **runId**
   * （一轮里同时只会有一个待决审批，runId 够用）。绝不用合成序号：
   * 那样 `approval.responded` 永远匹配不上，卡片会停在未决。
   */
  ensureApproval(payload: Record<string, unknown>): CloudFrame[] {
    const requestId = textOf(payload.prompt_id) || textOf(payload.request_id) || this.runId
    if (this.parts.some((part) => part.type === 'approval' && part.requestId === requestId)) {
      return []
    }
    const command =
      textOf(payload.command) || textOf(payload.summary) || textOf(payload.preview) || ''
    const patternKeys = Array.isArray(payload.pattern_keys)
      ? payload.pattern_keys.map((key) => String(key ?? '')).filter(Boolean)
      : textOf(payload.pattern_key)
        ? [textOf(payload.pattern_key)]
        : // 实机只给 `description`（例如 `delete in root path`），没有 pattern_keys
          textOf(payload.description)
          ? [textOf(payload.description)]
          : []
    const generation = numOf(payload.execution_generation) ?? numOf(payload.generation)
    const timeoutSeconds = numOf(payload.timeout_s) ?? numOf(payload.timeout_seconds)
    const part: CloudTracePart = {
      type: 'approval',
      id: `a:${requestId}`,
      requestId,
      command,
      patternKeys,
      choices: approvalChoicesOf(payload.choices),
      requestedAt: Date.now(),
    }
    // 审批总是在那次 `tool.started` 之后才来的：记下它拦的是哪个调用，
    // 审计的「真实结果」才能对号（工具卡后来才终态，可能来自实时流也可能来自历史）
    const guarded = this.lastRunningToolCallId()
    if (guarded) part.toolCallId = guarded
    if (generation !== undefined) part.generation = generation
    if (timeoutSeconds !== undefined) {
      part.timeoutSeconds = timeoutSeconds
      // 绝对截止时刻：断流重开后卡片还在，倒计时应该接着走而不是从头数
      if (timeoutSeconds > 0) part.expiresAt = Date.now() + timeoutSeconds * 1000
    }
    this.parts.push(part)
    return [{ kind: 'part', part }]
  }

  /** 最近一个还在跑的工具调用（审批要拦的就是它） */
  private lastRunningToolCallId(): string | undefined {
    for (let index = this.parts.length - 1; index >= 0; index -= 1) {
      const part = this.parts[index]
      if (part.type !== 'tool') continue
      if (part.status !== 'running') continue
      return part.toolCallId || undefined
    }
    return undefined
  }

  /** 这张审批拦的是哪个工具调用（主进程用它给审计的结果行对号） */
  approvalToolCallId(requestId: string): string | undefined {
    for (let index = this.parts.length - 1; index >= 0; index -= 1) {
      const part = this.parts[index]
      if (part.type !== 'approval') continue
      if (part.requestId !== requestId) continue
      return part.toolCallId
    }
    return undefined
  }

  /**
   * 结算回执找卡片：`prompt_id` → 命令原文 → 唯一一条未决。
   * 三级兜底是因为服务端的 `approval.responded` 不一定带 `request_id`。
   */
  private findApproval(payload: Record<string, unknown>): number {
    const id = textOf(payload.request_id) || textOf(payload.prompt_id)
    if (id) {
      const byId = this.parts.findIndex(
        (part) => part.type === 'approval' && part.requestId === id
      )
      if (byId >= 0) return byId
    }
    const command = textOf(payload.command)
    if (command) {
      const byCommand = this.parts.findIndex(
        (part) => part.type === 'approval' && part.command === command
      )
      if (byCommand >= 0) return byCommand
    }
    let found = -1
    let count = 0
    for (let index = 0; index < this.parts.length; index += 1) {
      const part = this.parts[index]
      if (part.type !== 'approval') continue
      if (part.decision || part.expiredAt !== undefined || part.settled) continue
      found = index
      count += 1
    }
    return count === 1 ? found : -1
  }

  /** 一轮结束仍未决的审批：本地标超时（服务端不会再给回执了） */
  private expirePendingApprovals(frames: CloudFrame[]): void {
    const at = Date.now()
    for (let index = 0; index < this.parts.length; index += 1) {
      const part = this.parts[index]
      if (part.type !== 'approval') continue
      if (part.decision || part.expiredAt !== undefined || part.settled) continue
      const next: CloudTracePart = { ...part, expiredAt: at }
      this.parts[index] = next
      frames.push({ kind: 'part', part: next })
    }
  }

  private findSubagent(key: string): number {
    return this.parts.findIndex((part) => part.type === 'subagent' && part.id === key)
  }

  /** 配对键：`subagent_id` → `delegation_id` → 单飞的"最后一个还在跑的子代理" */
  private subagentKey(payload: Record<string, unknown>): string {
    const id = textOf(payload.subagent_id) || textOf(payload.delegation_id)
    if (id) return `sa:${id}`
    for (let index = this.parts.length - 1; index >= 0; index -= 1) {
      const part = this.parts[index]
      if (part.type === 'subagent' && part.status === 'running') return part.id
    }
    const taskIndex = numOf(payload.task_index) ?? 0
    return `sa:task:${taskIndex}`
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
        for (const emitted of this.ensureApproval(payload)) frames.push(emitted)
        break
      }
      case 'approval.responded': {
        const index = this.findApproval(payload)
        if (index >= 0) {
          const existing = this.parts[index] as Extract<CloudTracePart, { type: 'approval' }>
          const decision = approvalChoiceOf(payload.choice)
          const next: CloudTracePart = decision
            ? { ...existing, decision, decidedAt: existing.decidedAt ?? Date.now() }
            : // 服务端说结算了，但选项不是我们支持的（例如别的客户端选了 always）
              { ...existing, settled: true }
          this.parts[index] = next
          frames.push({ kind: 'part', part: next })
        }
        break
      }
      case 'approval.settled': {
        // 实机回执只有 `prompt_id` + `execution_generation`，**不带 choice**。
        // 自己点过就先保留那个决定（这是应答的回声）；没有就是我们没参与的结算。
        const index = this.findApproval(payload)
        if (index >= 0) {
          const existing = this.parts[index] as Extract<CloudTracePart, { type: 'approval' }>
          if (existing.decision || existing.settled) break
          const next: CloudTracePart = { ...existing, settled: true }
          this.parts[index] = next
          frames.push({ kind: 'part', part: next })
        }
        break
      }
      case 'run.queued': {
        // 同一会话已有轮次在跑：后端排队，界面要能说“排队中”而不是“执行中”
        frames.push({ kind: 'run', runId: this.runId, state: 'queued' })
        break
      }
      case 'run.started':
      case 'run.running': {
        // 排队结束 / 断流后重新接上：状态从 queued 回到 running
        frames.push({ kind: 'run', runId: this.runId, state: 'running' })
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
        this.expirePendingApprovals(frames)
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
        this.expirePendingApprovals(frames)
        this.takePendingSteer(frames)
        break
      }
      case 'clarify.request': {
        for (const emitted of this.ensureClarify(payload)) frames.push(emitted)
        break
      }
      case 'clarify.settled': {
        // 结算可能来自我们自己的回答，也可能是超时 / 别的客户端答的
        const promptId = textOf(payload.prompt_id)
        const index = this.parts.findIndex(
          (part) => part.type === 'clarify' && part.promptId === promptId
        )
        if (index >= 0) {
          const existing = this.parts[index] as Extract<CloudTracePart, { type: 'clarify' }>
          if (!existing.settled) {
            const next = { ...existing, settled: true }
            this.parts[index] = next
            frames.push({ kind: 'part', part: next })
          }
        }
        break
      }
      case 'subagent.start':
      case 'subagent.complete': {
        const key = this.subagentKey(payload)
        const index = this.findSubagent(key)
        const goal = textOf(payload.goal) || textOf(payload.text)
        const done = name === 'subagent.complete'
        const status = done ? subagentStatusOf(payload.status) : 'running'
        if (index < 0) {
          const part: CloudTracePart = {
            type: 'subagent',
            id: key,
            goal: goal || '子代理',
            status,
            subagentId: textOf(payload.subagent_id) || undefined,
            delegationId: textOf(payload.delegation_id) || undefined,
            taskIndex: numOf(payload.task_index),
            taskCount: numOf(payload.task_count),
            model: textOf(payload.model) || undefined,
            childSessionId: textOf(payload.child_session_id) || undefined,
          }
          this.parts.push(part)
          frames.push({ kind: 'part', part })
          if (!done) break
          // 没有 start 帧（比如中途接入）：补一条已完成的卡片，别把它丢了
          const filled: CloudTracePart = { ...part, ...this.subagentResult(payload) }
          this.parts[this.parts.length - 1] = filled
          frames.push({ kind: 'part', part: filled })
          break
        }
        const current = this.parts[index] as Extract<CloudTracePart, { type: 'subagent' }>
        const next: CloudTracePart = done
          ? { ...current, ...this.subagentResult(payload) }
          : {
              ...current,
              status: 'running',
              // start 帧偶尔晚于 progress：只在还没有 goal 时补
              goal: current.goal || goal || '子代理',
              toolCount: numOf(payload.tool_count) ?? current.toolCount,
            }
        this.parts[index] = next
        frames.push({ kind: 'part', part: next })
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
        this.expirePendingApprovals(frames)
        this.takePendingSteer(frames)
        break
      }
      default:
        // subagent.* 等不进入时间线
        break
    }

    return frames
  }
}
