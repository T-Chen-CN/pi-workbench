/**
 * 派活账本：本机最近执行过的派活任务（谁派的、在哪个工作区、结果、本地会话 id）。
 *
 * 为什么需要它：云端有 hub.db 的账，但**本机**要能回答「刚才那个任务动了我哪个工作区、
 * 对应哪条本地会话」。会话本身不带派活标记（那是 pi-bridge 的格式，P1 不动），
 * 所以索引落在这里，界面和排查都靠它。
 *
 * 只保留最近 20 条：这是排查 / 回看用的，不是审计（审计在网关侧）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { readJsonWithBackup, writeJsonAtomicSync } from '../atomic-json.js'

export interface DispatchLedgerEntry {
  taskId: string
  workspaceId: string
  workspaceLabel: string
  state: 'completed' | 'failed' | 'canceled'
  summary: string
  /** 报告超过本机保留上限被截断（旧记录没有这个字段） */
  truncated?: boolean
  sessionId: string | null
  at: number
}

const MAX_ENTRIES = 20

export function ledgerPath(appDir: string): string {
  return path.join(appDir, 'data', 'agent', 'dispatch-ledger.json')
}

export function readLedger(filePath: string): DispatchLedgerEntry[] {
  const { data } = readJsonWithBackup<{ entries?: DispatchLedgerEntry[] }>(filePath)
  const entries = data?.entries
  return Array.isArray(entries) ? entries.filter(isEntry) : []
}

export function appendLedger(filePath: string, entry: DispatchLedgerEntry): DispatchLedgerEntry[] {
  const entries = [entry, ...readLedger(filePath)].slice(0, MAX_ENTRIES)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  writeJsonAtomicSync(filePath, { version: 1, entries })
  return entries
}

function isEntry(candidate: unknown): candidate is DispatchLedgerEntry {
  if (!candidate || typeof candidate !== 'object') return false
  const entry = candidate as Record<string, unknown>
  return typeof entry.taskId === 'string' && typeof entry.at === 'number'
}
