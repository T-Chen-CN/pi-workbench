/**
 * 会话附加数据（E-07）
 *
 * Pi 的 JSONL 只保存消息与工具结果，不保存思考时长。
 * 这里按会话保存一份 sidecar：
 * - thinkingDurations：按 assistant 消息时间戳记录每段思考的时长
 * - title：已确定的会话标题快照（防丢失，不是展示来源）
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
  /**
   * 已确定的会话标题。展示来源仍是 JSONL 的 session_info，这里只做备份：
   * 记录被裁剪或迁移后重开会话时用它补写回去，并阻止再次自动生成。
   */
  title: string | null
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
    title: null,
  }
}

/** 已清理过旧 toolEdits 的 sidecar，避免每次 load 都重写 */
const legacyToolEditsPruned = new Set<string>()

/**
 * Windows 上 rename 覆盖已存在文件可能被索引 / 杀软短暂占用（EPERM / EBUSY），
 * 标题快照不能因此丢掉，短暂错误重试几次。
 */
async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!transient || attempt >= attempts - 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)))
    }
  }
}

export interface SessionExtrasLoadResult {
  extras: SessionExtras
  /** 文件存在但主文件与备份均损坏，调用方对安全敏感字段（如权限）必须 fail-closed */
  corrupted: boolean
}

export class SessionExtrasStore {
  /** 按会话串行化写操作，防止标题写入 / legacy 清理 / 正常保存互相踩踏临时文件 */
  private readonly writeChains = new Map<string, Promise<void>>()

  constructor(private readonly baseDir: string) {}

  private pathFor(sessionId: string): string {
    if (!isSafeSessionId(sessionId)) {
      throw new Error('Invalid session id')
    }
    return path.join(this.baseDir, `${sessionId}.json`)
  }

  private parseExtras(raw: unknown): SessionExtras | null {
    if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1) {
      return null
    }
    const value = raw as Record<string, unknown>
    return {
      version: 1,
      thinkingDurations:
        value.thinkingDurations && typeof value.thinkingDurations === 'object'
          ? (value.thinkingDurations as Record<string, number[]>)
          : {},
      branchLeaves:
        value.branchLeaves && typeof value.branchLeaves === 'object'
          ? (value.branchLeaves as Record<string, string>)
          : {},
      plan: isStructuredPlan(value.plan) ? value.plan : null,
      permission:
        value.permission && typeof value.permission === 'object'
          ? normalizeSessionPermission(value.permission)
          : null,
      title:
        typeof value.title === 'string' && value.title.trim()
          ? value.title.trim().slice(0, 80)
          : null,
    }
  }

  async loadWithStatus(sessionId: string): Promise<SessionExtrasLoadResult> {
    let filePath: string
    try {
      filePath = this.pathFor(sessionId)
    } catch {
      return { extras: emptyExtras(), corrupted: false }
    }

    let primaryExisted = false
    for (const candidate of [filePath, `${filePath}.bak`]) {
      try {
        const text = await fs.readFile(candidate, 'utf-8')
        if (candidate === filePath) primaryExisted = true
        const raw = JSON.parse(text) as Record<string, unknown>
        const extras = this.parseExtras(raw)
        if (!extras) continue
        if (candidate === filePath && raw.toolEdits && !legacyToolEditsPruned.has(filePath)) {
          legacyToolEditsPruned.add(filePath)
          await this.save(sessionId, extras).catch(() => undefined)
        }
        return { extras, corrupted: false }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && candidate === filePath) {
          primaryExisted = true
        }
      }
    }
    return { extras: emptyExtras(), corrupted: primaryExisted }
  }

  async load(sessionId: string): Promise<SessionExtras> {
    return (await this.loadWithStatus(sessionId)).extras
  }

  async save(sessionId: string, extras: SessionExtras): Promise<void> {
    const target = this.pathFor(sessionId)
    const previous = this.writeChains.get(sessionId) ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(this.baseDir, { recursive: true })
        const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
        const temp = `${target}.${unique}.tmp`
        const body = JSON.stringify(extras)
        let handle: Awaited<ReturnType<typeof fs.open>> | undefined
        try {
          handle = await fs.open(temp, 'w', 0o600)
          await handle.writeFile(body, 'utf-8')
          await handle.sync()
        } catch (error) {
          await handle?.close().catch(() => {})
          await fs.rm(temp, { force: true }).catch(() => {})
          throw error
        }
        await handle.close()
        try {
          try {
            // 仅在旧主文件为合法 JSON 且结构有效时才更新 .bak，避免损坏主文件覆盖健康备份
            const existing = await fs.readFile(target, 'utf-8')
            const parsed: unknown = JSON.parse(existing)
            if (this.parseExtras(parsed)) {
              await fs.copyFile(target, `${target}.bak`)
            }
          } catch {
            // 主文件不存在或已损坏：保留现有 .bak
          }
          await renameWithRetry(temp, target)
        } catch (error) {
          await fs.rm(temp, { force: true }).catch(() => {})
          throw error
        }
      })
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    this.writeChains.set(sessionId, tail)
    void tail.then(() => {
      if (this.writeChains.get(sessionId) === tail) this.writeChains.delete(sessionId)
    })
    return run
  }

  /** 会话删除时一并清理 sidecar 与备份，避免遗留权限与历史记录 */
  async delete(sessionId: string): Promise<void> {
    const target = this.pathFor(sessionId)
    await fs.unlink(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    await fs.unlink(`${target}.bak`).catch(() => undefined)
  }
}
