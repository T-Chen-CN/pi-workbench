/**
 * 会话附加数据（E-07）
 *
 * Pi 的 JSONL 只保存消息与工具结果，不保存思考时长。
 * 这里按会话保存一份 sidecar：
 * - thinkingDurations：按 assistant 消息时间戳记录每段思考的时长
 *
 * 工具调用的前后文件内容只在当前进程内保留（用于当前轮 Diff），不再落盘。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { normalizeSessionPermission, type SessionPermission } from './approval-policy.js'
import { isStructuredPlan, type StructuredPlan } from './plan.js'

export interface SessionExtras {
  version: 1
  thinkingDurations: Record<string, number[]>
  /** 分支切换（R-03）：assistant 入口 → 该分支上次停留的叶子，切回时可恢复完整后续 */
  branchLeaves: Record<string, string>
  /** 结构化计划（R-04）；不进入模型上下文，压缩后仍保留 */
  plan: StructuredPlan | null
  /** 会话权限（AF-02）；null 表示尚未固化，首次打开时从全局默认档生成 */
  permission: SessionPermission | null
}

/** 会话 id 只允许字母、数字、下划线与连字符，禁止路径分隔符与 `..` */
export function isSafeSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

export function emptyExtras(): SessionExtras {
  return {
    version: 1,
    thinkingDurations: {},
    branchLeaves: {},
    plan: null,
    permission: null,
  }
}

/** 已清理过旧 toolEdits 的 sidecar，避免每次 load 都重写 */
const legacyToolEditsPruned = new Set<string>()

export class SessionExtrasStore {
  constructor(private readonly baseDir: string) {}

  private pathFor(sessionId: string): string {
    if (!isSafeSessionId(sessionId)) {
      throw new Error('Invalid session id')
    }
    return path.join(this.baseDir, `${sessionId}.json`)
  }
  async load(sessionId: string): Promise<SessionExtras> {
    try {
      const filePath = this.pathFor(sessionId)
      const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      if (!raw || raw.version !== 1) return emptyExtras()
      const extras: SessionExtras = {
        version: 1,
        thinkingDurations:
          raw.thinkingDurations && typeof raw.thinkingDurations === 'object'
            ? raw.thinkingDurations
            : {},
        branchLeaves:
          raw.branchLeaves && typeof raw.branchLeaves === 'object' ? raw.branchLeaves : {},
        plan: isStructuredPlan(raw.plan) ? raw.plan : null,
        permission:
          raw.permission && typeof raw.permission === 'object'
            ? normalizeSessionPermission(raw.permission)
            : null,
      }
      // 旧版本 sidecar 保存过完整文件内容；读取后异步重写一次，回收磁盘
      if (raw.toolEdits && !legacyToolEditsPruned.has(filePath)) {
        legacyToolEditsPruned.add(filePath)
        await this.save(sessionId, extras).catch(() => undefined)
      }
      return extras
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

  /** 会话删除时一并清理 sidecar，避免遗留权限与历史记录 */
  async delete(sessionId: string): Promise<void> {
    await fs.unlink(this.pathFor(sessionId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
