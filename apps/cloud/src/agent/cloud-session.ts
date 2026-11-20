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
  type CloudAgentStatus,
  type CloudChatMessage,
  type CloudRuntimeState,
  type CloudTaskEventPayload,
  type CloudTaskSnapshot,
  type AgentTraceEvent,
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
  now?: () => number
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
  private error: string | undefined

  constructor(private readonly deps: CloudSessionDeps) {}

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
      model: config ? { provider: config.provider, id: config.model } : undefined,
    }
  }

  get currentSessionId(): string | null {
    return this.sessionId
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

  /** 会话历史 → 快照消息（唯一真相源是 JSONL，这里只做投影） */
  async history(): Promise<CloudChatMessage[]> {
    if (!this.sessionId) return []
    const opened = await this.deps.agent.openSession(this.sessionId)
    if (!opened.success) return []
    const messages: CloudChatMessage[] = []
    ;(opened.history ?? []).forEach((message, index) => {
      if (message.role !== 'user' && message.role !== 'assistant') return
      messages.push({
        id: `h-${index}`,
        role: message.role,
        text: message.content,
        at: message.timestamp || this.now(),
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
    this.pending.set(payload.taskId, { payload, at: this.now() })
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushEvents()
    }, CLOUD_EVENT_THROTTLE_MS)
    this.flushTimer.unref?.()
  }

  private async flushEvents(): Promise<void> {
    const sessionId = this.sessionId
    if (!sessionId || this.pending.size === 0) return
    const events = [...this.pending.values()]
    this.pending.clear()

    const busy = this.deps.agent.isSessionBusy(sessionId)
    // 多条事件合并成一条 custom message：一轮只跑一次，避免刷屏与重复唤醒
    const merged: CloudTaskEventPayload = {
      eventId: `evt-batch-${this.now()}`,
      kind: events.length === 1 ? events[0].payload.kind : 'milestone',
      taskId: events.map((item) => item.payload.taskId).join(','),
      deviceId: events.map((item) => item.payload.deviceId).join(','),
      at: this.now(),
      summary: events.map((item) => `${item.payload.taskId}: ${item.payload.summary}`).join(' / '),
      status: events[events.length - 1].payload.status,
      terminalReason: events[events.length - 1].payload.terminalReason,
    }
    const message = buildTaskEventMessage(merged)
    const result = await this.deps.agent.sendCustomMessage(sessionId, message, {
      triggerTurn: true,
      deliverAs: 'followUp',
    })
    if (!result.success) {
      this.deps.logger.warn('[cloud] failed to wake the cloud session:', result.error)
      return
    }
    if (!busy) this.beginTurn()
  }

  // ------------------------------ 内部 ------------------------------

  private beginTurn(): void {
    this.status = 'thinking'
    this.deps.hub.publish({ type: 'cloud_status', status: 'thinking' })
  }

  private endTurn(status: CloudAgentStatus): void {
    if (this.streamingMessageId) this.finishStreamingMessage()
    this.status = status
    this.deps.hub.publish({ type: 'cloud_status', status })
  }

  /** 流式：把 text_delta 拼成一条消息，tool/thinking 作为独立 trace 帧转发 */
  private onTrace(event: AgentTraceEvent): void {
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
      return
    }

    // 思考 / 工具调用属于「协调过程」，可见但不进会话正文（F-28 / F-45）
    if (event.type === 'compaction_start' || event.type === 'compaction_end') return
    this.deps.hub.publish({ type: 'trace', messageId: this.streamingMessageId ?? undefined, trace: event })
  }

  private finishStreamingMessage(): void {
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

export type { CloudTaskSnapshot }
