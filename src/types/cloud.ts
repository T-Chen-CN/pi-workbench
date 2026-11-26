/**
 * 云端页的数据形状（渲染层视角）。
 *
 * 与 `pi-bridge/src/cloud-protocol.ts` 保持一一对应；渲染层只用类型导入，
 * 不把 bridge 的运行时打进浏览器包。
 */

import type {
  CloudClientState,
  CloudDeviceState,
  CloudLinkView,
  CloudWorkspaceEntry,
} from './electron'

export type { CloudClientState, CloudDeviceState, CloudLinkView, CloudWorkspaceEntry }

/**
 * 与 `pi-bridge/src/cloud-protocol.ts` 的 CLOUD_PROTOCOL_VERSION 必须一致。
 * 渲染层不能直接 import 那个模块（会把 Node 侧依赖打进浏览器包），
 * 所以这里复制一份常量，由 `tests/cloud-protocol.test.ts` 交叉校验。
 */
export const CLOUD_PROTOCOL_VERSION = 1

/** 会话消息：轻量渲染只保留正文与工具轨迹摘要（不引入 chatStore 的模型） */
export interface CloudChatRow {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
  /** 流式中的消息：下一次 text_delta 直接追加 */
  streaming?: boolean
  /** 工具先于正文时创建的占位行，下一条 assistant message_start 到达时原地复用 */
  pendingTrace?: boolean
  traces: CloudTraceRow[]
  error?: string
}

export interface CloudTraceRow {
  id: string
  toolName: string
  summary: string
  status: 'running' | 'ok' | 'error'
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

/**
 * 工作单元行（F-19a / A-43）：一个单元一个工作树。
 * 干净就自动回收，脏树保留并出现在这里供用户手动结束。
 */
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
