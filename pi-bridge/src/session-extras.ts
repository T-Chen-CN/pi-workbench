/**
 * 会话附加数据（E-07 / E-08）
 *
 * Pi 的 JSONL 只保存消息与工具结果，不保存思考时长和工具调用时的文件内容。
 * 这里按会话保存一份 sidecar：
 * - thinkingDurations：按 assistant 消息时间戳记录每段思考的时长
 * - toolEdits：按 toolCallId 记录 write/edit 的前后内容，供历史工具行查看 Diff
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { isStructuredPlan, type StructuredPlan } from './plan.js'

export interface ToolEditRecord {
  path: string
  oldContent: string
  newContent: string
}

export interface SessionExtras {
  version: 1
  thinkingDurations: Record<string, number[]>
  toolEdits: Record<string, ToolEditRecord>
  /** 分支切换（R-03）：assistant 入口 → 该分支上次停留的叶子，切回时可恢复完整后续 */
  branchLeaves: Record<string, string>
  /** 结构化计划（R-04）；不进入模型上下文，压缩后仍保留 */
  plan: StructuredPlan | null
}

export function emptyExtras(): SessionExtras {
  return { version: 1, thinkingDurations: {}, toolEdits: {}, branchLeaves: {}, plan: null }
}

export class SessionExtrasStore {
  constructor(private readonly baseDir: string) {}

  private pathFor(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.json`)
  }

  async load(sessionId: string): Promise<SessionExtras> {
    try {
      const raw = JSON.parse(await fs.readFile(this.pathFor(sessionId), 'utf-8'))
      if (!raw || raw.version !== 1) return emptyExtras()
      return {
        version: 1,
        thinkingDurations:
          raw.thinkingDurations && typeof raw.thinkingDurations === 'object'
            ? raw.thinkingDurations
            : {},
        toolEdits: raw.toolEdits && typeof raw.toolEdits === 'object' ? raw.toolEdits : {},
        branchLeaves:
          raw.branchLeaves && typeof raw.branchLeaves === 'object' ? raw.branchLeaves : {},
        plan: isStructuredPlan(raw.plan) ? raw.plan : null,
      }
    } catch {
      return emptyExtras()
    }
  }

  async save(sessionId: string, extras: SessionExtras): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true })
    const target = this.pathFor(sessionId)
    const temp = `${target}.tmp`
    await fs.writeFile(temp, JSON.stringify(extras), 'utf-8')
    await fs.rename(temp, target)
  }
}
