/**
 * 「还在跑的轮次」：跨重启接回的唯一线索。
 *
 * 为什么必须落盘：服务端的 run 活在网关进程里，跟我们重启毫无关系；而
 * `GET /api/sessions` 不返回 run id，重启之后客户端没有任何办法问出「这个会话是不是还在跑」。
 * 所以开跑就写一条记录，run 到终态就删掉 —— 它是**可丢弃的 UI 缓存**，
 * 不是云端真相（真相仍在 Hermes `state.db`，见 CLOUD_AGENT §4.4）。
 *
 * 多条并存：不同会话可以各跑一轮（上限同 `MAX_LIVE_STREAMS`）。旧版本只写过单条
 * `{runId, sessionId, startedAt}`，读取时按一条记录兼容，写回一律写新形状。
 *
 * 后端不认某条记录（网关重启过 / run 被回收）时一律当"没有"，顺手删掉，
 * 免得每次启动都白问一次。
 */

import * as fs from 'fs'
import * as path from 'path'
import { getAppDir } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomicSync } from '../atomic-json.js'

export interface ActiveRunRecord {
  runId: string
  sessionId: string | null
  /** 开跑时刻（毫秒）：只用于排查，不参与逻辑 */
  startedAt: number
}

interface ActiveRunFile {
  runs?: unknown
  /** 旧形状（单条记录） */
  runId?: unknown
  sessionId?: unknown
  startedAt?: unknown
}

export function activeRunFile(): string {
  return path.join(getAppDir(), 'data', 'cloud-agent', 'active-run.json')
}

function toRecord(value: unknown): ActiveRunRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const runId = typeof raw.runId === 'string' ? raw.runId.trim() : ''
  if (!runId) return null
  return {
    runId,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
  }
}

/** 全部待接回的轮次（旧单条文件也认） */
export function readActiveRuns(): ActiveRunRecord[] {
  const { data } = readJsonWithBackup<ActiveRunFile>(activeRunFile())
  if (!data) return []
  if (Array.isArray(data.runs)) {
    const rows = data.runs.map(toRecord).filter((item): item is ActiveRunRecord => item !== null)
    return rows
  }
  const single = toRecord(data)
  return single ? [single] : []
}

/** 兼容旧调用：最近一条 */
export function readActiveRun(): ActiveRunRecord | null {
  const rows = readActiveRuns()
  return rows.length > 0 ? (rows[rows.length - 1] ?? null) : null
}

function writeRecords(records: ActiveRunRecord[]): void {
  try {
    if (records.length === 0) {
      fs.rmSync(activeRunFile(), { force: true })
      fs.rmSync(`${activeRunFile()}.bak`, { force: true })
      return
    }
    writeJsonAtomicSync(activeRunFile(), {
      runs: records.map((record) => ({
        runId: record.runId,
        sessionId: record.sessionId,
        startedAt: record.startedAt,
      })),
    })
  } catch {
    // 写不进去只是失去"接回"能力，不该让开跑失败
  }
}

/** 追加一条；同一个 runId 只保留最新 */
export function writeActiveRun(record: ActiveRunRecord): void {
  const rows = readActiveRuns().filter((item) => item.runId !== record.runId)
  rows.push(record)
  writeRecords(rows)
}

/** 只清指定那一轮（不给 runId 就清空全部） */
export function clearActiveRun(runId?: string): void {
  try {
    if (!runId) {
      writeRecords([])
      return
    }
    const rows = readActiveRuns()
    const kept = rows.filter((item) => item.runId !== runId)
    if (kept.length === rows.length) return
    writeRecords(kept)
  } catch {
    // 删不掉就留着，下次 attach 会因 not_found 自行作废
  }
}

/** 这个会话在盘上还有没有记录（重启接回按会话找） */
export function activeRunForSession(sessionId: string): ActiveRunRecord | null {
  const rows = readActiveRuns()
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row && row.sessionId === sessionId) return row
  }
  return null
}
