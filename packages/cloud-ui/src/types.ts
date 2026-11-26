/**
 * 云端前端共享数据形状与常量（桌面端 CloudView 与云端 Web 共用，零 Electron / zustand 依赖）。
 */

/** 与 `pi-bridge/src/cloud-protocol.ts` 保持一致，由 `tests/cloud-protocol.test.ts` 交叉校验 */
export const CLOUD_PROTOCOL_VERSION = 1

export interface CloudWorkspaceEntry {
  path: string
  name: string
  remote?: string
  defaultBranch?: string
  isGit: boolean
}

export interface CloudTraceRow {
  id: string
  toolName: string
  summary: string
  status: 'running' | 'ok' | 'error'
  durationMs?: number
  resultPreview?: string
}

export interface CloudChatRow {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
  /** 流式中的消息：下一次 text_delta 直接追加 */
  streaming?: boolean
  /** 思考/工具先于正文时创建的占位行，下一条 assistant message_start 到达时原地复用 */
  pendingTrace?: boolean
  /** 实时流式与重连快照恢复的思考过程文本 */
  thinking?: string
  thinkingRedacted?: boolean
  thinkingStartedAt?: number
  thinkingDurationMs?: number
  traces: CloudTraceRow[]
  error?: string
}

export type CloudTaskStatusName =
  | 'queued'
  | 'assigned'
  | 'running'
  | 'waiting_human'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'expired'
  | 'rejected'

export const CLOUD_ACTIVE_TASK_STATUSES: readonly CloudTaskStatusName[] = [
  'queued',
  'assigned',
  'running',
  'waiting_human',
] as const

export function isCloudTaskActiveStatus(status: string): boolean {
  return (CLOUD_ACTIVE_TASK_STATUSES as readonly string[]).includes(status)
}

export interface CloudChangedFileRow {
  path: string
  kind: string
  attention?: string
}

export interface CloudSecretHitRow {
  path: string
  line: number
  kind: string
}

export interface CloudAwaySummaryRow {
  since: number
  until: number
  text: string
  items: Array<{
    taskId: string
    title: string
    status: CloudTaskStatusName
    terminalReason?: string
    at: number
  }>
}

export interface CloudTaskRow {
  id: string
  title: string
  deviceId: string
  workspacePath: string
  status: CloudTaskStatusName
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  terminalReason?: string
  /** 终端回报的里程碑文本（最后一条） */
  lastMilestone?: string
  question?: { id: string; text: string; at: number }
  changedFiles?: CloudChangedFileRow[]
  secretHits?: CloudSecretHitRow[]
  result?: { summary: string; changedFiles: CloudChangedFileRow[]; secretHits?: CloudSecretHitRow[] }
  error?: string
  worktreePath?: string
  branch?: string
  /** 归属工作单元：同一单元的后续工单不需要重新确认（O-06） */
  workUnitId: string
}

export interface CloudDeviceRow {
  id: string
  name: string
  platform: string
  online: boolean
  workspaces: CloudWorkspaceEntry[]
  lastSeenAt?: number
}

export interface CloudAuthorizationRow {
  id: string
  items: Array<{ deviceId: string; workspacePath: string }>
  quota: number
  used: number
  confirmedAt: number
  expiresAt: number
  confirmedSummary: string
}

export interface CloudUnitRow {
  unitId: string
  deviceId: string
  workspacePath: string
  worktreePath?: string
  branch?: string
  createdAt: number
  closedAt: number | null
  closeRequestedAt?: number
  dirtyAt?: number
}

export interface CloudNotice {
  level: 'info' | 'warn' | 'error'
  text: string
  at: number
  key?: string
}

export type CloudMemoryKind = 'fact' | 'preference' | 'project' | 'decision' | 'todo'

export interface CloudMemoryItem {
  id: string
  kind: CloudMemoryKind
  content: string
  tags: string[]
  source: 'auto' | 'dream' | 'manual'
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export interface CloudDocItem {
  name: 'AGENTS.md' | 'SOUL.md'
  content: string
  exists: boolean
  updatedAt: number | null
}

export interface CloudDreamItem {
  id: string
  at: number
  trigger: 'idle' | 'manual'
  summary: string
  added: number
  merged: number
  removed: number
}

export interface CloudCatalogModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  vision?: boolean
}

export type CloudAgentStatusName = 'idle' | 'thinking' | 'replying' | 'error'

export interface CloudSessionState {
  messages: CloudChatRow[]
  tasks: CloudTaskRow[]
  devices: CloudDeviceRow[]
  units: CloudUnitRow[]
  authorizations: CloudAuthorizationRow[]
  notices: CloudNotice[]
  awaySummary: CloudAwaySummaryRow | null
  lastSeq: number
  lastReadSeq: number
  unreadCount: number
  agentStatus: CloudAgentStatusName
  canStopReply: boolean
  stoppingTaskIds: Record<string, true>
}

export const INITIAL_CLOUD_SESSION_STATE: CloudSessionState = {
  messages: [],
  tasks: [],
  devices: [],
  units: [],
  authorizations: [],
  notices: [],
  awaySummary: null,
  lastSeq: 0,
  lastReadSeq: 0,
  unreadCount: 0,
  agentStatus: 'idle',
  canStopReply: false,
  stoppingTaskIds: {},
}

/** 固定供应商白名单（桌面端与云端 Web 共用；模型能力来自 Pi catalog） */
export const CLOUD_PROVIDER_PRESETS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'google', label: 'Google' },
  { id: 'xai', label: 'xAI' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'xiaomi', label: '小米 MiMo' },
  { id: 'xiaomi-token-plan-cn', label: '小米（Token 套餐）' },
  { id: 'openai-codex', label: 'OpenAI Codex' },
]
