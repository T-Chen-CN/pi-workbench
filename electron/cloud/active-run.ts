/**
 * 「上一次开的那一轮」：跨重启接回在跑 run 的唯一线索。
 *
 * 为什么必须落盘：服务端的 run 活在网关进程里，跟我们重启毫无关系；而
 * `GET /api/sessions` 不返回 run id，重启之后客户端没有任何办法问出「这个会话是不是还在跑」。
 * 所以启动时开跑就写一条记录，run 到终态就删掉 —— 它是**可丢弃的 UI 缓存**，
 * 不是云端真相（真相仍在 Hermes `state.db`，见 CLOUD_AGENT §4.4）。
 *
 * 后端不认这条记录（网关重启过 / run 被回收）时一律当"没有"，顺手删掉，
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

export function activeRunFile(): string {
  return path.join(getAppDir(), 'data', 'cloud-agent', 'active-run.json')
}

export function readActiveRun(): ActiveRunRecord | null {
  const { data } = readJsonWithBackup<Partial<ActiveRunRecord>>(activeRunFile())
  const runId = typeof data?.runId === 'string' ? data.runId.trim() : ''
  if (!runId) return null
  return {
    runId,
    sessionId: typeof data?.sessionId === 'string' && data.sessionId ? data.sessionId : null,
    startedAt: typeof data?.startedAt === 'number' ? data.startedAt : 0,
  }
}

export function writeActiveRun(record: ActiveRunRecord): void {
  try {
    writeJsonAtomicSync(activeRunFile(), {
      runId: record.runId,
      sessionId: record.sessionId,
      startedAt: record.startedAt,
    })
  } catch {
    // 写不进去只是失去"接回"能力，不该让开跑失败
  }
}

/** 只在这条记录就是刚结束的那一轮时才清；别把别人的记录顶掉 */
export function clearActiveRun(runId?: string): void {
  try {
    if (runId) {
      const current = readActiveRun()
      if (current && current.runId !== runId) return
    }
    fs.rmSync(activeRunFile(), { force: true })
    fs.rmSync(`${activeRunFile()}.bak`, { force: true })
  } catch {
    // 删不掉就留着，下次 attach 会因 not_found 自行作废
  }
}
