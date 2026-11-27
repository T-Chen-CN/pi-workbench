/**
 * 云端 Agent：唯一会话 + 六个派活类工具 + 事件唤醒（F-29 / F-37 / D-03 / D-21 / D-29）。
 *
 * 工具集**没有** `fs` / `bash` / `git`：云端没有仓库，给它只会变成在服务器上瞎搞。
 * 推进不靠阻塞工具，靠 `sendCustomMessage(customType:'task-event')` 唤醒，一轮只跑一次。
 *
 * 六个工具是自研 ToolDefinition，通过 `extensionFactories` 注入，因此云端会话也可以
 * 用「内置扩展全关 + auto 权限」装配（G1/G3）：不注册审批扩展也不会有 tool_call 钩子，
 * 但云端工具全是只读查询与派活，被 auto 放行即可。
 */

import {
  buildTaskEventMessage,
  CLOUD_EVENT_THROTTLE_MS,
  createStreamCoalescer,
  type CloudAgentStatus,
  type CloudChatMessage,
  type CloudChatTraceItem,
  type CloudRuntimeState,
  type CloudTaskEventPayload,
  type CloudTaskSnapshot,
  type AgentTraceEvent,
  type StreamCoalescer,
} from 'pi-bridge'
import type { AgentManager } from 'pi-bridge'
import type { CloudStore } from '../store/store.js'
import type { Hub } from '../ws/hub.js'
import type { TaskDispatcher } from '../tasks/dispatcher.js'
import type { AuthorizationRecord } from '../tasks/authorization.js'

/** 云端会话可用的六个工具（D-03：白名单写死，不给 fs / bash / git） */
export const CLOUD_TOOL_NAMES = [
  'list_devices',
  'list_repos',
  'dispatch_task',
  'get_task',
  'send_task_message',
  'cancel_task',
] as const

export interface CloudSessionDeps {
  agent: AgentManager
  store: CloudStore
  hub: Hub
  dispatcher: TaskDispatcher
  logger: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
    debug: (...args: unknown[]) => void
  }
  /**
   * 入口屏障：F-13 的配置轮换会在轮次边界重建运行时（`dispose()` + `initialize()`）。
   * 重建窗口里 `sessionId` 与运行时都不可用，所以用户消息与事件唤醒必须先等它结束。
   * 返回 false 表示当前没有可用运行时（未推配置 / 重建失败）。
   */
  ready?: () => Promise<boolean>
  now?: () => number
  /** 流式增量合帧窗口（毫秒，默认 50ms）；测试可显式调整 */
  traceFlushMs?: number
  /** 工单事件唤醒节流窗口（毫秒，默认 2000ms）；测试可显式调整 */
  eventThrottleMs?: number
}

interface PendingEvent {
  payload: CloudTaskEventPayload
  at: number
}

export class CloudSession {
  private status: CloudAgentStatus = 'idle'
  private sessionId: string | null = null
  private streamingMessageId: string | null = null
  private streamingText = ''
  private pending = new Map<string, PendingEvent>()
  private flushTimer: NodeJS.Timeout | null = null
  private flushFailureCount = 0
  private error: string | undefined
  private readonly traceCoalescer: StreamCoalescer<AgentTraceEvent>

  constructor(private readonly deps: CloudSessionDeps) {
    this.traceCoalescer = createStreamCoalescer<AgentTraceEvent>(
      (events) => this.emitCoalescedTraces(events),
      {
        intervalMs: deps.traceFlushMs ?? 50,
        maxChars: 4000,
        flushOnBoundary: true,
      }
    )
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  runtimeState(): CloudRuntimeState {
    const busy = this.sessionId ? this.deps.agent.isSessionBusy(this.sessionId) : false
    const config = this.deps.store.getCloudConfig()
    return {
      status: this.status,
      canStopReply: busy,
      error: this.error,
      model: config ? { provider: config.providerId, id: config.model } : undefined,
    }
  }

  get currentSessionId(): string | null {
    return this.sessionId
  }

  /** 是否正在跑一轮；配置轮换要等它为 false（F-13：不许打断进行中的轮次） */
  isBusy(): boolean {
    return this.sessionId ? this.deps.agent.isSessionBusy(this.sessionId) : false
  }

  /**
   * 打开（或继续）唯一会话。
   * `initialize()` 会无条件 `continueRecent()`，所以这里直接用它的结果：单会话模型下
   * 重启后继续最近会话就是正确语义。
   */
  async open(): Promise<{ ok: boolean; error?: string }> {
    const opened = await this.deps.agent.openSession()
    if (!opened.success || !opened.session) {
      this.error = opened.error ?? 'Unable to open the cloud session.'
      return { ok: false, error: this.error }
    }
    this.sessionId = opened.session.id
    await this.deps.agent.subscribeTrace(this.sessionId, (event) =>
      this.onTrace(event)
    )
    this.status = 'idle'
    this.deps.logger.info(`[cloud] session ready: ${this.sessionId}`)
    return { ok: true }
  }

  /** 会话历史 → 快照消息（唯一真相源是 JSONL，这里只做投影，含思考与工具轨迹） */
  async history(): Promise<CloudChatMessage[]> {
    if (!this.sessionId) return []
    const opened = await this.deps.agent.openSession(this.sessionId)
    if (!opened.success) return []
    const messages: CloudChatMessage[] = []
    ;(opened.history ?? []).forEach((message, index) => {
      if (message.role !== 'user' && message.role !== 'assistant') return
      const parts = message.parts ?? []
      let thinking = ''
      let thinkingRedacted = false
      let thinkingDurationMs = 0
      const traces: CloudChatTraceItem[] = []
      for (const part of parts) {
        if (part.type === 'thinking') {
          if (part.text) thinking = thinking ? `${thinking}\n\n${part.text}` : part.text
          if (part.redacted) thinkingRedacted = true
          if (typeof part.durationMs === 'number') thinkingDurationMs += part.durationMs
        } else if (part.type === 'tool') {
          traces.push({
            id: part.toolCallId,
            toolName: part.toolName,
            summary: part.resultPreview || part.argsSummary || '',
            status: part.status === 'error' || part.isError ? 'error' : part.status === 'running' ? 'running' : 'ok',
            durationMs: part.durationMs,
            resultPreview: part.resultPreview,
          })
        }
      }
      messages.push({
        id: `h-${index}`,
        role: message.role,
        text: message.content,
        at: message.timestamp || this.now(),
        ...(thinking ? { thinking } : {}),
        ...(thinkingRedacted ? { thinkingRedacted: true } : {}),
        ...(thinkingDurationMs > 0 ? { thinkingDurationMs } : {}),
        ...(traces.length > 0 ? { traces: traces.slice(-30) } : {}),
      })
    })
    return messages.slice(-200)
  }

  // ------------------------------ 用户输入 ------------------------------

  /** 用户消息：空闲→开一轮；正在跑→`steer` 注入（不新开轮次，G11） */
  async say(
    text: string,
    clientMessageId: string
  ): Promise<{ success: boolean; error?: string }> {
    const body = text.trim()
    if (!body) return { success: false, error: 'Message is empty.' }
    // 屏障必须放在读 sessionId 之前：重建期间旧 id 已失效
    if (this.deps.ready) {
      const ok = await this.deps.ready()
      if (!ok) return { success: false, error: 'Cloud session is not ready.' }
    }
    if (!this.sessionId) return { success: false, error: 'Cloud session is not ready.' }

    // 用户消息也要广播：多端（Web / 另一台设备）必须看到同一份对话。
    // messageId 用客户端给的 id，发起的端可以据此去重（它本地已经乐观追加了）。
    this.echoUserMessage(body, clientMessageId)

    if (this.deps.agent.isSessionBusy(this.sessionId)) {
      const steered = await this.deps.agent.steer(this.sessionId, body)
      if (steered.success) {
        this.deps.hub.publish({
          type: 'notice',
          level: 'info',
          text: '已把你的消息插入当前回复',
          at: this.now(),
          key: `steer-${clientMessageId}`,
        })
      }
      return steered
    }

    this.error = undefined
    this.beginTurn()
    void this.runTurn(body)
    return { success: true }
  }

  /** 用户消息回显（两端都靠这一对帧渲染用户气泡，不再依赖「本端自己画」） */
  private echoUserMessage(body: string, clientMessageId: string): void {
    const messageId = `u-${clientMessageId || this.now()}`
    this.deps.hub.publish({ type: 'message_start', messageId, role: 'user', at: this.now() })
    this.deps.hub.publish({ type: 'message_end', messageId, text: body, at: this.now() })
  }

  private async runTurn(text: string): Promise<void> {
    const sessionId = this.sessionId
    if (!sessionId) return
    const result = await this.deps.agent.chat(sessionId, text, {
      onTrace: () => {
        // 常驻订阅已经覆盖了 trace；这里不需要重复处理
      },
    })
    if (!result.success) {
      this.error = result.error
      this.deps.hub.publish({ type: 'cloud_status', status: 'error', error: result.error })
    }
    this.endTurn(result.success ? 'idle' : 'error')
  }

  /** 「停止云端回复」：只中断这一轮，不影响终端工单（F-30a） */
  async stopReply(): Promise<{ ok: boolean }> {
    if (!this.sessionId || !this.deps.agent.isSessionBusy(this.sessionId)) {
      return { ok: false }
    }
    await this.deps.agent.abort(this.sessionId)
    this.endTurn('idle')
    return { ok: true }
  }

  // ------------------------------ 事件唤醒 ------------------------------

  /**
   * 工单事件 → 云端会话。
   *
   * 节流合并：同一工单 ≥2 s、跨工单汇总成一条；轮次进行中用 `followUp`（SDK 原生排队，
   * 不打断本轮，也不并发调 chat）。
   */
  wake(payload: CloudTaskEventPayload): void {
    const existing = this.pending.get(payload.taskId)
    const nextPayload = existing ? mergeTaskEventPayloads(existing.payload, payload) : payload
    this.pending.set(payload.taskId, { payload: nextPayload, at: this.now() })
    this.scheduleFlush()
  }

  private scheduleFlush(delayMs = this.deps.eventThrottleMs ?? CLOUD_EVENT_THROTTLE_MS): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushEvents()
    }, delayMs)
    this.flushTimer.unref?.()
  }

  private async flushEvents(): Promise<void> {
    if (this.pending.size === 0) return
    const baseThrottleMs = this.deps.eventThrottleMs ?? CLOUD_EVENT_THROTTLE_MS
    if (this.deps.ready) {
      const ok = await this.deps.ready()
      if (!ok) {
        // 运行时暂不可用（重建窗口或暂未就绪）时必须重排定时器，绝不让 pending 事件永久搁浅
        this.scheduleFlush(baseThrottleMs * 2)
        return
      }
    }
    const sessionId = this.sessionId
    if (!sessionId || this.pending.size === 0) {
      if (!sessionId && this.pending.size > 0) this.scheduleFlush(baseThrottleMs * 2)
      return
    }
    const entries = [...this.pending.entries()]
    this.pending.clear()
    const events = entries.map(([, item]) => item)

    const busy = this.deps.agent.isSessionBusy(sessionId)
    // 多条事件合并成一条 custom message：保留最高优先级 kind，完整汇聚 changedFiles 与 secretHits
    const mergedChangedFiles = mergeBatchChangedFiles(events.map((item) => item.payload.changedFiles))
    const mergedSecretHits = mergeBatchSecretHits(events.map((item) => item.payload.secretHits))
    const highestKind = events.reduce(
      (best, item) =>
        eventKindPriority(item.payload.kind) > eventKindPriority(best) ? item.payload.kind : best,
      events[0].payload.kind
    )
    const merged: CloudTaskEventPayload = {
      eventId: `evt-batch-${this.now()}`,
      kind: highestKind,
      taskId: events.map((item) => item.payload.taskId).join(','),
      deviceId: [...new Set(events.map((item) => item.payload.deviceId))].join(','),
      at: this.now(),
      summary:
        events.length === 1
          ? events[0].payload.summary
          : events.map((item) => `${item.payload.taskId}: ${item.payload.summary}`).join(' / '),
      status: events[events.length - 1].payload.status,
      terminalReason: events[events.length - 1].payload.terminalReason,
      ...(mergedChangedFiles.length > 0 ? { changedFiles: mergedChangedFiles } : {}),
      ...(mergedSecretHits.length > 0 ? { secretHits: mergedSecretHits } : {}),
    }
    const message = buildTaskEventMessage(merged)
    // 必须在 await sendCustomMessage 之前进入 thinking：否则轮次可能在 await 返回前已 settle，
    // 后置 beginTurn() 会把已结束的会话永久卡死在 thinking 状态
    const startedTurn = !busy
    if (startedTurn) this.beginTurn()

    let failedError: unknown = null
    let succeeded = false
    try {
      const result = await this.deps.agent.sendCustomMessage(sessionId, message, {
        triggerTurn: true,
        deliverAs: 'followUp',
      })
      if (result.success) {
        succeeded = true
        this.flushFailureCount = 0
      } else {
        failedError = result.error ?? 'sendCustomMessage returned success=false'
      }
    } catch (error) {
      failedError = error
    }

    if (!succeeded) {
      this.deps.logger.warn('[cloud] failed to wake the cloud session:', failedError)
      if (startedTurn && this.status === 'thinking') {
        this.endTurn('error')
      }
      // 将未送达事件放回 pending，不覆盖期间新到达的同 key 事件（合并保留两者信息）
      for (const [key, item] of entries) {
        const newer = this.pending.get(key)
        if (!newer) {
          this.pending.set(key, item)
        } else {
          this.pending.set(key, {
            payload: mergeTaskEventPayloads(item.payload, newer.payload),
            at: newer.at,
          })
        }
      }
      this.flushFailureCount = Math.min(this.flushFailureCount + 1, 5)
      const backoffMs = Math.min(baseThrottleMs * 2 ** this.flushFailureCount, 60_000)
      this.scheduleFlush(backoffMs)
    }
  }

  /** SDK `agent_settled` 钩子：收尾事件唤醒轮次的流式消息并复位状态 */
  onSettled(): void {
    this.endTurn('idle')
  }

  // ------------------------------ 内部 ------------------------------

  private beginTurn(): void {
    this.status = 'thinking'
    this.deps.hub.publish({ type: 'cloud_status', status: 'thinking' })
  }

  private endTurn(status: CloudAgentStatus): void {
    // 轮次结束前必须刷出剩余缓冲增量，否则最后 50ms 的文字或思考会丢失或晚于 message_end
    this.traceCoalescer.flush()
    if (this.streamingMessageId) this.finishStreamingMessage()
    this.status = status
    this.deps.hub.publish({ type: 'cloud_status', status })
  }

  /** 流式：经有序合帧器合并 50ms 内的 text_delta / thinking_delta，保护 2000 条 WS outbox */
  private onTrace(event: AgentTraceEvent): void {
    // 压缩属于执行细节，对话流不转发（F-45）
    if (event.type === 'compaction_start' || event.type === 'compaction_end') return
    this.traceCoalescer.push(event)
  }

  private emitCoalescedTraces(events: AgentTraceEvent[]): void {
    for (const event of events) {
      if (event.type === 'text_delta') {
        if (!this.streamingMessageId) {
          this.streamingMessageId = `msg-${this.now()}-${Math.random().toString(36).slice(2, 8)}`
          this.streamingText = ''
          this.status = 'replying'
          this.deps.hub.publish({ type: 'cloud_status', status: 'replying' })
          this.deps.hub.publish({
            type: 'message_start',
            messageId: this.streamingMessageId,
            role: 'assistant',
            at: this.now(),
          })
        }
        this.streamingText += event.delta
        this.deps.hub.publish({
          type: 'text_delta',
          messageId: this.streamingMessageId,
          delta: event.delta,
        })
        continue
      }

      if (event.type === 'thinking_delta' && this.status === 'idle') {
        this.status = 'thinking'
        this.deps.hub.publish({ type: 'cloud_status', status: 'thinking' })
      }
      // 思考与工具调用合并后作为有序 trace 帧下发，由桌面云端页与 Web 端折叠渲染（F-45）
      this.deps.hub.publish({
        type: 'trace',
        messageId: this.streamingMessageId ?? undefined,
        trace: event,
      })
    }
  }

  private finishStreamingMessage(): void {
    this.traceCoalescer.flush()
    const id = this.streamingMessageId
    if (!id) return
    this.deps.hub.publish({
      type: 'message_end',
      messageId: id,
      text: this.streamingText,
      at: this.now(),
    })
    this.streamingMessageId = null
    this.streamingText = ''
  }
}

/**
 * 授权记录 → 客户端可见视图（不含内部字段）。
 * UI 用它显示「已授权 N 张 / 剩 M 张」，据此决定是否提示重新确认（F-17）。
 */
export function authorizationView(record: AuthorizationRecord) {
  return {
    id: record.id,
    items: record.items.map((item) => ({
      deviceId: item.deviceId,
      workspacePath: item.workspacePath,
    })),
    quota: record.quota,
    used: record.used,
    confirmedAt: record.confirmedAt,
    confirmedSummary: record.confirmedSummary,
    expiresAt: record.expiresAt,
  }
}

/** 工具执行失败的统一形状：让模型看到可读原因而不是抛异常中断整轮 */
export function toolError(reason: string) {
  return { content: [{ type: 'text' as const, text: reason }], isError: true, details: undefined }
}

export function toolText(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: false, details: undefined }
}

/** 事件唤醒优先级：提问 > 失败/异常终态 > 完成 > 停滞 > 里程碑/接单 */
function eventKindPriority(kind: CloudTaskEventPayload['kind']): number {
  switch (kind) {
    case 'question':
      return 5
    case 'failed':
    case 'cancelled':
    case 'interrupted':
    case 'device-offline':
    case 'expired':
      return 4
    case 'done':
      return 3
    case 'stalled':
      return 2
    default:
      return 1
  }
}

function mergeBatchChangedFiles(
  lists: Array<CloudTaskEventPayload['changedFiles']>
): NonNullable<CloudTaskEventPayload['changedFiles']> {
  const byPath = new Map<string, NonNullable<CloudTaskEventPayload['changedFiles']>[number]>()
  for (const list of lists) {
    if (!list) continue
    for (const item of list) {
      const prev = byPath.get(item.path)
      byPath.set(item.path, prev?.attention && !item.attention ? { ...item, attention: prev.attention } : item)
    }
  }
  return [...byPath.values()]
}

function mergeBatchSecretHits(
  lists: Array<CloudTaskEventPayload['secretHits']>
): NonNullable<CloudTaskEventPayload['secretHits']> {
  const seen = new Set<string>()
  const merged: NonNullable<CloudTaskEventPayload['secretHits']> = []
  for (const list of lists) {
    if (!list) continue
    for (const hit of list) {
      const key = `${hit.path}:${hit.line}:${hit.kind}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(hit)
    }
  }
  return merged
}

/** 同一工单在 2s 节流窗口内收到多条事件时，保留更高优先级的 kind 并汇聚改动与密钥告警 */
function mergeTaskEventPayloads(
  prev: CloudTaskEventPayload,
  next: CloudTaskEventPayload
): CloudTaskEventPayload {
  const keepPrevKind = eventKindPriority(prev.kind) > eventKindPriority(next.kind)
  const changedFiles = mergeBatchChangedFiles([prev.changedFiles, next.changedFiles])
  const secretHits = mergeBatchSecretHits([prev.secretHits, next.secretHits])
  const summary =
    prev.summary === next.summary
      ? next.summary
      : keepPrevKind
        ? `${prev.summary} / ${next.summary}`
        : `${next.summary} (${prev.summary})`
  return {
    ...next,
    kind: keepPrevKind ? prev.kind : next.kind,
    summary,
    status: next.status ?? prev.status,
    terminalReason: next.terminalReason ?? prev.terminalReason,
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(secretHits.length > 0 ? { secretHits } : {}),
  }
}

export type { CloudTaskSnapshot }
