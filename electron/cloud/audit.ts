/**
 * 云端审批审计：`data/cloud-agent/audit.jsonl`。
 *
 * 只回答三个问题：
 *   1. **谁批的** —— 本机用户点的那一下（`source: 'local'`）
 *   2. **依据哪条规则** —— 服务端命中的危险模式（`patternKeys`）+ 当时的档位（`mode`）
 *   3. **真实结果** —— 该轮下一个终态工具卡的 `error` + 结果预览前 200 字
 *
 * 两条约定：
 * - 只写一行 JSON，**追加 + fsync，永不改写**（不用 `atomic-json`：那是整文件替换）。
 * - 命令只存**摘要**（≤200 字）：完整命令里可能带 token、口令或绝对路径。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getAppDir } from '../app-paths.js'
import type { CloudApprovalChoice, CloudApprovalMode } from './types.js'

const COMMAND_MAX_CHARS = 200
const PREVIEW_MAX_CHARS = 200

export interface CloudAuditDecision {
  at: number
  kind: 'approval'
  /** 决定与结果两条记录的关联键 */
  auditId: string
  runId: string
  sessionId: string | null
  /** 命令摘要（≤200 字） */
  command: string
  patternKeys: string[]
  choice: CloudApprovalChoice
  /** 决策当时服务端生效的档位 */
  mode: CloudApprovalMode | null
}

export interface CloudAuditOutcome {
  at: number
  kind: 'approval_result'
  auditId: string
  runId: string
  /** 工具自己是否报错（被拒绝时服务端会把 BLOCKED 当作错误返回） */
  error: boolean
  /** 结果预览前 200 字 */
  preview: string
}

export interface CloudAuditModeChange {
  at: number
  kind: 'mode'
  from: CloudApprovalMode | null
  to: CloudApprovalMode | null
}

export type CloudAuditEntry = CloudAuditDecision | CloudAuditOutcome | CloudAuditModeChange

export function auditFile(): string {
  return path.join(getAppDir(), 'data', 'cloud-agent', 'audit.jsonl')
}

/** 折叠空白 + 截断：同一份逻辑给审计和卡片共用 */
export function auditCommandSummary(command: string): string {
  const flat = String(command ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length <= COMMAND_MAX_CHARS
    ? flat
    : `${flat.slice(0, COMMAND_MAX_CHARS - 1)}…`
}

/** 追加一行并 fsync（同步写：审计丢一条比卡一帧更糟） */
export function appendAudit(entry: CloudAuditEntry): void {
  const file = auditFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const line = `${JSON.stringify(entry)}\n`
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeSync(fd, line, null, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 待关联的审批决定：runId → auditId。
 *
 * 一轮里同时只会有一个待决审批，所以不用 requestId 当键；结果到达时（下一个
 * 终态工具卡）就把这一条结掉，避免长时间挂着内存。
 */
const pendingByRun = new Map<string, string>()

export function recordApprovalDecision(input: {
  runId: string
  sessionId?: string | null
  command: string
  patternKeys?: string[]
  choice: CloudApprovalChoice
  mode?: CloudApprovalMode | null
}): CloudAuditDecision {
  const entry: CloudAuditDecision = {
    at: Date.now(),
    kind: 'approval',
    auditId: `ap:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    runId: input.runId,
    sessionId: input.sessionId ?? null,
    command: auditCommandSummary(input.command),
    patternKeys: (input.patternKeys ?? []).slice(0, 8),
    choice: input.choice,
    mode: input.mode ?? null,
  }
  appendAudit(entry)
  pendingByRun.set(input.runId, entry.auditId)
  return entry
}

/**
 * 结掉上一次决定的结果。第一个终态工具卡就够（审批针对的就是紧跟着的那次调用）：
 * 被拒绝时服务端返回 `BLOCKED: ...` 且 `error=true`，与真实执行失败区分得开。
 */
export function recordApprovalOutcome(
  runId: string,
  result: { error: boolean; preview: string }
): boolean {
  const auditId = pendingByRun.get(runId)
  if (!auditId) return false
  pendingByRun.delete(runId)
  appendAudit({
    at: Date.now(),
    kind: 'approval_result',
    auditId,
    runId,
    error: Boolean(result.error),
    preview: String(result.preview ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, PREVIEW_MAX_CHARS),
  })
  return true
}

/** 档位变更也进审计：谁把闸门拧松了，要留痕 */
export function recordModeChange(
  from: CloudApprovalMode | null,
  to: CloudApprovalMode | null
): void {
  appendAudit({ at: Date.now(), kind: 'mode', from, to })
}

/** 测试用：清掉落盘与内存状态 */
export function resetAuditForTests(): void {
  pendingByRun.clear()
  try {
    fs.rmSync(auditFile(), { force: true })
  } catch {
    // 清不掉就算了：测试里不关键
  }
}
