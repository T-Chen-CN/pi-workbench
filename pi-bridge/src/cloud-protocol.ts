/**
 * 云端 Agent 的传输契约（P0）。
 *
 * 三条通道共用的唯一事实源：`/client/ws`（桌面端 / Web）与 `/device/ws`（终端执行器）。
 * 放在 pi-bridge 而不是 `apps/cloud`，是为了让 electron 主进程与云端服务共用同一份
 * 类型与常量——两份定义一定会漂移（桌面端与云端各自升级）。
 *
 * 约定：
 * - 只放**类型、常量、纯函数**，不 import 任何 Electron / Node 运行时模块，
 *   Web 客户端（无构建链）可以安全地引用这里的常量。
 * - 帧格式不做版本协商：`v` 不匹配直接拒绝（F-47，不维护旧客户端兼容）。
 * - 所有服务端 → 对端的增量帧都带单调 `seq`；`ack(seq)` 之后服务端才可以删 outbox。
 */

import type { AgentTraceEvent } from './types.js'

/** 协议版本：任何破坏性帧变更都必须 +1，服务端按它直接拒绝旧客户端 */
export const CLOUD_PROTOCOL_VERSION = 1

/** 两条数据面路径（Caddy 反代到 127.0.0.1:8787） */
export const CLOUD_WS_PATHS = {
  client: '/client/ws',
  device: '/device/ws',
} as const

/** 事件唤醒用的 custom message 类型；落盘为 custom_message，不冒充用户授权 */
export const CLOUD_TASK_EVENT_CUSTOM_TYPE = 'task-event'

// ---------------------------------------------------------------------------
// 连接游标（「我收到哪了」）
// ---------------------------------------------------------------------------

/**
 * 解析续传游标：**只有正整数才算游标**。
 *
 * `0` / 负数 / `NaN` / 空串都等于「我手上什么都没有」，必须回整份快照。
 * 按 0 去重放日志只会把旧事件播一遗，而快照里那些消息一条也到不了客户端——
 * 表现就是「一刷新历史全没了」。三端（Web / 桌面桥 / 服务端）都走这个函数。
 */
export function normalizeResumeCursor(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.floor(value)
}

/** 连接 URL 的游标参数；没有游标时返回空串（不能拼 `?lastAckSeq=0`） */
export function clientCursorQuery(lastSeq: number): string {
  const cursor = normalizeResumeCursor(lastSeq)
  return cursor === null ? '' : `?lastAckSeq=${cursor}`
}

/**
 * 「给我一份新快照」：`resume(0)` 就是游标为空。
 *
 * 客户端重载 / 页面重新挂载时用它——连接还活着但本地状态已清空，
 * 不复用这条连接就只能一直白屏。
 */
export function buildSnapshotRequest(): { type: 'resume'; lastAckSeq: number } {
  return { type: 'resume', lastAckSeq: 0 }
}

// ---------------------------------------------------------------------------
// 时间与容量（F-21 / F-44 / F-46 / O-15 的默认值集中在这里，改一处即可）
// ---------------------------------------------------------------------------

export const CLOUD_HEARTBEAT_INTERVAL_MS = 25_000
export const CLOUD_OFFLINE_TIMEOUT_MS = 60_000
/** `queued` 只覆盖“服务端已生成工单、终端尚未 ack”的窗口 */
export const CLOUD_QUEUED_ACK_WINDOW_MS = 60_000
export const CLOUD_WAITING_HUMAN_TIMEOUT_MS = 2 * 60 * 60 * 1000
/** 里程碑汇报节流：同一工单 ≥2 s 合并一次 */
export const CLOUD_EVENT_THROTTLE_MS = 2_000
/** 客户端通道 outbox 上限：超过就丢掉旧增量，resume 时回 snapshot */
export const CLOUD_OUTBOX_MAX_ENTRIES = 2_000
export const CLOUD_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** 单进程并发会话上限（D-15：超出排队而不是全放） */
export const CLOUD_MAX_CONCURRENT_SESSIONS = 8
/** 客户端连接超时：把“静默被墙”变成可读错误（F-43 / A-19） */
export const CLOUD_CONNECT_TIMEOUT_MS = 8_000

// ---------------------------------------------------------------------------
// 错误与连接分级
// ---------------------------------------------------------------------------

/** 帧级 / 连接级错误码；对端按它决定是重试、提示更新还是停止重试 */
export type CloudErrorCode =
  | 'protocol-version'
  | 'unauthorized'
  | 'rate-limited'
  | 'invalid-frame'
  | 'unknown-target'
  | 'conflict'
  | 'server-error'

/** 连接失败的用户可见分级（F-43） */
export type CloudConnectErrorKind =
  | 'offline'
  | 'dns'
  | 'timeout'
  | 'auth'
  | 'protocol'
  | 'server'

export function classifyConnectError(input: {
  stage: 'resolve' | 'connect' | 'tls' | 'http' | 'ws'
  status?: number
  code?: string
  message?: string
}): CloudConnectErrorKind {
  if (input.status === 401 || input.status === 403) return 'auth'
  if (input.status === 426 || input.code === 'protocol-version') return 'protocol'
  if (input.status && input.status >= 500) return 'server'
  const code = (input.code ?? '').toUpperCase()
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  if (code === 'ECONNREFUSED' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return 'offline'
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout'
  if (input.stage === 'resolve') return 'dns'
  return 'offline'
}

// ---------------------------------------------------------------------------
// 通用信封
// ---------------------------------------------------------------------------

interface FrameBase {
  v: typeof CLOUD_PROTOCOL_VERSION
}

/** 帧解码结果：失败时给出可直接回给对端的错误码 */
export type CloudFrameResult<T> =
  | { ok: true; frame: T }
  | { ok: false; code: CloudErrorCode; message: string }

export function encodeFrame(frame: unknown): string {
  return JSON.stringify(frame)
}

/** 已登记的上行帧类型：不认识就直接回 `invalid-frame`，否则会被静默丢弃、对端干等 */
export const CLIENT_TO_SERVER_TYPES: ReadonlySet<string> = new Set([
  'resume',
  'ack',
  'say',
  'confirm_plan',
  'stop_reply',
  'stop_task',
  'close_unit',
  'ping',
])

export const DEVICE_TO_SERVER_TYPES: ReadonlySet<string> = new Set([
  'hello',
  'resume',
  'ack',
  'workspaces',
  'heartbeat',
  'task_status',
  'task_worktree',
  'task_milestone',
  'task_question',
  'task_result',
  'task_failed',
  'task_interrupted',
  'unit_closed',
  'unit_state',
  'ping',
])

/**
 * 解帧：JSON 合法、是对象、`v` 匹配、`type` 在本次通道的登记表里。
 * 具体字段校验交给各帧的处理分支（避免这里变成第二个 schema 定义）。
 */
export function decodeFrame<T extends FrameBase>(
  raw: unknown,
  knownTypes?: ReadonlySet<string>
): CloudFrameResult<T> {
  if (typeof raw !== 'string') return { ok: false, code: 'invalid-frame', message: 'Frame must be text.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, code: 'invalid-frame', message: 'Frame is not valid JSON.' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'invalid-frame', message: 'Frame must be an object.' }
  }
  const version = (parsed as { v?: unknown }).v
  if (version !== CLOUD_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: 'protocol-version',
      message: `Protocol version ${String(version)} is not supported (need ${CLOUD_PROTOCOL_VERSION}).`,
    }
  }
  const type = (parsed as { type?: unknown }).type
  if (typeof type !== 'string') {
    return { ok: false, code: 'invalid-frame', message: 'Frame is missing type.' }
  }
  if (knownTypes && !knownTypes.has(type)) {
    return { ok: false, code: 'invalid-frame', message: `Unknown frame type "${type}".` }
  }
  return { ok: true, frame: parsed as T }
}

// ---------------------------------------------------------------------------
// 共享的数据模型
// ---------------------------------------------------------------------------

/** 工单状态机（F-20）；终态由服务端先落者胜（F-21） */
export type CloudTaskStatus =
  | 'queued'
  | 'assigned'
  | 'running'
  | 'waiting_human'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'rejected'
  | 'interrupted'

export const CLOUD_TASK_TERMINAL_STATUSES: readonly CloudTaskStatus[] = [
  'done',
  'failed',
  'cancelled',
  'expired',
  'rejected',
  'interrupted',
]

export function isTerminalTaskStatus(status: CloudTaskStatus): boolean {
  return CLOUD_TASK_TERMINAL_STATUSES.includes(status)
}

/** 服务端先落终态者胜：后到的终态只能作附注，不能覆盖 */
export type CloudTaskTerminalReason =
  | 'device-offline'
  | 'user-cancel'
  | 'app-quit'
  | 'ack-timeout'
  | 'waiting-human-timeout'
  | 'failed'
  | 'completed'

export type CloudChangedFileKind = 'added' | 'modified' | 'deleted' | 'renamed'

/** 改动清单条目；`attention` 是 `.env*` / lock / CI / hooks 一类需要点名的原因 */
export interface CloudChangedFile {
  path: string
  kind: CloudChangedFileKind
  attention?: string
}

/** 疑似密钥命中：只报位置，绝不打印值（F-36） */
export interface CloudSecretHit {
  path: string
  line: number
  kind: string
}

export interface CloudTaskProgress {
  step: number
  totalSteps?: number
  summary?: string
  currentTool?: string
  changedFiles?: CloudChangedFile[]
  branch?: string
  /** 工作单元收敛后的提交（同一 unit 只能有一次，F-19a） */
  commit?: string
  lastEventAt: number
}

/** 派活内容：终端看不到用户与云端的对话，必须自包含（F-19） */
export interface CloudTaskSpec {
  workUnitId: string
  deviceId: string
  repo: {
    /** 终端侧绝对路径；派活时由 deviceId 的工作区清单校验 */
    workspacePath: string
    remote?: string
    baseBranch?: string
  }
  title: string
  background: string
  goal: string
  acceptance: string
  /** 沟通用：预期动哪些地方，不是执行约束 */
  expectedChanges?: string
  forbidden?: string[]
  output: {
    summary: boolean
    changeList: boolean
    testResult: boolean
    diffLimitBytes?: number
  }
  /** 由云端按工作单元判定：本单是否产出提交 */
  commit: boolean
  /** 授权凭据（G9）：服务端用它强制校验设备 × 仓库 × 额度 */
  authorizationId: string
}

export interface CloudTaskSnapshot {
  id: string
  spec: CloudTaskSpec
  status: CloudTaskStatus
  idempotencyKey: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  terminalReason?: CloudTaskTerminalReason
  progress: CloudTaskProgress
  error?: string
}

/** 终端执行结果：汇报必须可验证（F-34） */
export interface CloudTaskResult {
  summary: string
  changedFiles: CloudChangedFile[]
  tests?: { command: string; passed: boolean; excerpt?: string }
  diff?: { bytes: number; excerpt: string }
  branch?: string
  commit?: string
  notes?: string
  secretHits?: CloudSecretHit[]
  /**
   * 工单结束时工作树是否干净（`git status --porcelain` 无输出；ignored 文件不算脏）。
   * 服务端据此决定能不能自动回收：干净 = 什么都没留下来，删了不丢东西。
   */
  worktreeClean?: boolean
}

export interface CloudTaskQuestion {
  id: string
  taskId: string
  text: string
  at: number
  answer?: { text: string; at: number; source: 'cloud' | 'user' }
}

export interface CloudWorkspaceInfo {
  /** 绝对路径；派活按它定位仓库 */
  path: string
  name: string
  remote?: string
  defaultBranch?: string
  /** 非 git 目录不接受派活（G10） */
  isGit: boolean
}

export interface CloudDeviceSnapshot {
  id: string
  name: string
  platform: string
  online: boolean
  lastSeenAt: number
  workspaces: CloudWorkspaceInfo[]
  /** 设备上正在执行的工单数（单设备并发 1） */
  runningTaskIds: string[]
}

// ---------------------------------------------------------------------------
// 会话与指示器（F-27 / F-48 / F-49）
// ---------------------------------------------------------------------------

export type CloudAgentStatus = 'idle' | 'thinking' | 'replying' | 'error'

export interface CloudRuntimeState {
  status: CloudAgentStatus
  turnStartedAt?: number
  /** 「停止云端回复」是否可用（与「停止工单」是两个动作，F-30a） */
  canStopReply: boolean
  error?: string
  /** 只暴露 provider / 模型名；Key 永不出服务器 */
  model?: { provider: string; id: string }
}

export type CloudChatRole = 'user' | 'assistant' | 'system' | 'event'

export interface CloudChatMessage {
  id: string
  role: CloudChatRole
  text: string
  at: number
  streaming?: boolean
  error?: string
  /** 由工单事件唤醒的一轮：UI 上要与用户发言区分（A-31） */
  taskEvent?: { taskId?: string; kind: string }
  usage?: { input?: number; output?: number; reasoning?: number; cost?: number }
}

export interface CloudSnapshot {
  serverVersion: string
  protocol: typeof CLOUD_PROTOCOL_VERSION
  lastSeq: number
  cloud: CloudRuntimeState
  messages: CloudChatMessage[]
  tasks: CloudTaskSnapshot[]
  devices: CloudDeviceSnapshot[]
  /** 工作单元：一个单元一个工作树（F-19a），UI 据此提供「结束工作单元」 */
  units: CloudUnitView[]
  /** 当前有效的授权（UI 用来显示「已授权 N 张 / 剩 M 张」） */
  authorizations: CloudAuthorizationView[]
}

/**
 * 工作单元的对外视图。
 *
 * 回收语义（F-19a / A-43）：工单进终态且该单元无后续工单时，**干净树自动回收**；
 * 脏树保留并在此处标 `dirtyAt`，由用户手动结束。`closedAt` 只在**设备回执后**才写。
 */
export interface CloudUnitView {
  unitId: string
  deviceId: string
  workspacePath: string
  worktreePath?: string
  branch?: string
  createdAt: number
  /** 已回收；脏树保留时保持 null（表示“还在等用户处理”） */
  closedAt: number | null
  /** 已发出回收请求、还没收到设备回执 */
  closeRequestedAt?: number
  /** 最近一次回收因脏树被拒的时间（UI 标「待清理」） */
  dirtyAt?: number
}

/** 对客户端只暴露授权范围与额度，不暴露内部实现 */
export interface CloudAuthorizationView {
  id: string
  items: Array<{ deviceId: string; workspacePath: string }>
  quota: number
  used: number
  confirmedAt: number
  confirmedSummary: string
  expiresAt: number
}

/** 服务端 → 客户端的增量事件 */
export type CloudEvent =
  | { type: 'message_start'; messageId: string; role: CloudChatRole; at: number }
  | { type: 'text_delta'; messageId: string; delta: string }
  | { type: 'message_end'; messageId: string; text: string; at: number; error?: string }
  | { type: 'trace'; messageId?: string; trace: AgentTraceEvent }
  | { type: 'cloud_status'; status: CloudAgentStatus; error?: string }
  | { type: 'task'; task: CloudTaskSnapshot }
  | { type: 'device'; device: CloudDeviceSnapshot }
  | { type: 'unit'; unit: CloudUnitView }
  | {
      type: 'notice'
      level: 'info' | 'warn' | 'error'
      text: string
      at: number
      /** 稳定键：同一件事重复通知时去重（例如“你离开期间…”） */
      key?: string
    }

// ---------------------------------------------------------------------------
// 客户端通道（桌面端 / Web）
// ---------------------------------------------------------------------------

export type ClientToServerFrame =
  | ({ type: 'resume'; lastAckSeq: number } & FrameBase)
  | ({ type: 'ack'; seq: number } & FrameBase)
  | ({ type: 'say'; text: string; clientMessageId: string } & FrameBase)
  | ({
      type: 'confirm_plan'
      /** 方案原文（自然语言，不做结构化编辑） */
      planText: string
      /** 授权范围：设备 × 仓库；用户手选，避免模型自报 */
      items: Array<{ deviceId: string; workspacePath: string }>
      quota: number
    } & FrameBase)
  | ({ type: 'stop_reply' } & FrameBase)
  | ({ type: 'stop_task'; taskId: string } & FrameBase)
  /** F-19a：结束工作单元（回收工作树）；干净树才会真删，脏树只汇报 */
  | ({ type: 'close_unit'; unitId: string } & FrameBase)
  | ({ type: 'ping'; at: number } & FrameBase)

export type ServerToClientFrame =
  | ({ type: 'snapshot'; seq: number; snapshot: CloudSnapshot } & FrameBase)
  | ({ type: 'event'; seq: number; event: CloudEvent } & FrameBase)
  | ({ type: 'ack'; seq: number } & FrameBase)
  | ({ type: 'pong'; at: number } & FrameBase)
  | ({ type: 'error'; code: CloudErrorCode; message: string; fatal: boolean } & FrameBase)

// ---------------------------------------------------------------------------
// 设备通道（终端执行器）
// ---------------------------------------------------------------------------

export type CloudTaskMilestoneKind =
  | 'accepted'
  | 'first-change'
  | 'tests-done'
  | 'progress'
  | 'uncommitted'

export interface CloudTaskMilestone {
  kind: CloudTaskMilestoneKind
  text: string
  at: number
  changedFiles?: CloudChangedFile[]
}

export type DeviceToServerFrame =
  | ({
      type: 'hello'
      deviceId: string
      workspaces: CloudWorkspaceInfo[]
      /**
       * 终端**认为**还在跑的工单（重连对账用，F-21 / A-13）。
       * 服务端只对已落终态的那些回 `task_cancel`：离线判定、用户停止、超时都发生
       * 在终端掉线期间，终端不知道工单已经结束，不纠正会把“已取消”的活干完。
       */
      runningTasks?: string[]
    } & FrameBase)
  | ({ type: 'resume'; lastAckSeq: number } & FrameBase)
  | ({ type: 'ack'; seq: number } & FrameBase)
  | ({ type: 'workspaces'; workspaces: CloudWorkspaceInfo[] } & FrameBase)
  | ({ type: 'heartbeat'; at: number } & FrameBase)
  | ({ type: 'task_status'; taskId: string; status: CloudTaskStatus; at: number } & FrameBase)
  | ({
      type: 'task_worktree'
      taskId: string
      unitId: string
      path: string
      branch?: string
      at: number
    } & FrameBase)
  | ({ type: 'task_milestone'; taskId: string; milestone: CloudTaskMilestone } & FrameBase)
  | ({ type: 'task_question'; taskId: string; questionId: string; text: string; at: number } & FrameBase)
  | ({ type: 'task_result'; taskId: string; result: CloudTaskResult; at: number } & FrameBase)
  | ({
      type: 'task_failed'
      taskId: string
      error: string
      changedFiles?: CloudChangedFile[]
      /** 同 `CloudTaskResult.worktreeClean`：干净才可以自动回收（F-19a） */
      worktreeClean?: boolean
      at: number
    } & FrameBase)
  | ({
      type: 'task_interrupted'
      taskId: string
      reason: string
      /** 停止/退出时的工作树状态；干净则服务端可立即自动回收 */
      worktreeClean?: boolean
      at: number
    } & FrameBase)
  | ({
      type: 'unit_closed'
      unitId: string
      /** 工作树是否真的被删了（脏树保留时为 false） */
      removed: boolean
      dirty: boolean
      worktreePath?: string
      /** 有提交时分支保留，commit 存活 */
      branch?: string
      error?: string
      at: number
    } & FrameBase)
  /** 启动/重连时的兜底上报：让云端能对上“已收敛但树还留着”的单元（A-43） */
  | ({
      type: 'unit_state'
      unitId: string
      clean: boolean
      worktreePath?: string
      at: number
    } & FrameBase)
  | ({ type: 'ping'; at: number } & FrameBase)

export type ServerToDeviceFrame =
  | ({ type: 'ack'; seq: number } & FrameBase)
  | ({ type: 'task'; seq: number; task: CloudTaskSnapshot } & FrameBase)
  | ({ type: 'task_cancel'; seq: number; taskId: string; reason: string } & FrameBase)
  | ({ type: 'task_answer'; taskId: string; questionId: string; text: string; at: number } & FrameBase)
  | ({ type: 'task_message'; seq: number; taskId: string; text: string; at: number } & FrameBase)
  | ({
      type: 'close_unit'
      seq: number
      unitId: string
      reason: 'converged' | 'user-close' | 'sweep'
    } & FrameBase)
  | ({ type: 'pong'; at: number } & FrameBase)
  | ({ type: 'error'; code: CloudErrorCode; message: string; fatal: boolean } & FrameBase)

// ---------------------------------------------------------------------------
// 事件唤醒载荷（投进云端会话的 custom message）
// ---------------------------------------------------------------------------

export type CloudTaskEventKind =
  | 'accepted'
  | 'milestone'
  | 'question'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'interrupted'
  | 'device-offline'

export interface CloudTaskEventPayload {
  /** SDK 的 sendCustomMessage 返回 void，回执与去重靠这个自造 id */
  eventId: string
  kind: CloudTaskEventKind
  taskId: string
  deviceId: string
  at: number
  summary: string
  status?: CloudTaskStatus
  terminalReason?: CloudTaskTerminalReason
}

/** 事件 message 的完整形状，直接喂给 `AgentManager.sendCustomMessage` */
export interface CloudTaskEventMessage {
  customType: typeof CLOUD_TASK_EVENT_CUSTOM_TYPE
  content: string
  display: boolean
  details: CloudTaskEventPayload
}

/**
 * 把事件载荷包成 custom message。
 *
 * `display: false` 是刻意的：事件不是人说的话，UI 的对话流里只显示云端据此产出的
 * 汇报；`details` 保留结构化载荷供云端在下一轮里读到“origin”。
 */
export function buildTaskEventMessage(payload: CloudTaskEventPayload): CloudTaskEventMessage {
  const lines = [`[task-event] ${payload.kind} ${payload.taskId}`, payload.summary]
  if (payload.status) lines.push(`status: ${payload.status}`)
  if (payload.terminalReason) lines.push(`reason: ${payload.terminalReason}`)
  return {
    customType: CLOUD_TASK_EVENT_CUSTOM_TYPE,
    content: lines.join('\n'),
    display: false,
    details: payload,
  }
}
