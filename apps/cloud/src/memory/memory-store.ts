/**
 * 云端持久记忆、留存文档与梦境记录存储（F-39 / F-41 / F-42 / C-03a）。
 *
 * 落盘目录统一在 `${dataDir}/memory/` 下，确保每日备份脚本 `backup.sh` 自动覆盖：
 * - `memories.json`：结构化记忆条目（事实 / 偏好 / 项目状态 / 已定决策 / 待办）
 * - `dreams.json`：梦境整理时间线（最近 50 条）
 * - `AGENTS.md` / `SOUL.md`：白名单留存文档，用户可在 Web / 桌面端直接查阅与编辑
 *
 * 两条硬约束：
 * 1. `source === 'manual'` 的手工记忆永远优先：自动抽取与梦境整理绝不覆盖或删除它；
 * 2. 文档读写只接受 `CLOUD_DOC_WHITELIST` 里的固定文件名，拒绝任何路径穿越或额外文件名。
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { readJsonAsyncWithBackup, writeJsonAtomicAsync } from 'pi-bridge/atomic-json'

export const CLOUD_MEMORY_KINDS = ['fact', 'preference', 'project', 'decision', 'todo'] as const
export type CloudMemoryKind = (typeof CLOUD_MEMORY_KINDS)[number]
export type CloudMemorySource = 'auto' | 'dream' | 'manual'

export const CLOUD_DOC_WHITELIST = ['AGENTS.md', 'SOUL.md'] as const
export type CloudDocName = (typeof CLOUD_DOC_WHITELIST)[number]

export const CLOUD_DOC_MAX_BYTES = 64 * 1024
const MAX_MEMORIES = 200
const MAX_DREAMS = 50
const MAX_CONTENT_LEN = 600

export interface CloudMemoryItem {
  id: string
  kind: CloudMemoryKind
  content: string
  tags: string[]
  source: CloudMemorySource
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export interface CloudDreamRecord {
  id: string
  at: number
  trigger: 'idle' | 'manual'
  summary: string
  added: number
  merged: number
  removed: number
}

export interface CloudDocView {
  name: CloudDocName
  content: string
  exists: boolean
  updatedAt: number | null
}

interface MemoriesFile {
  items: CloudMemoryItem[]
}

interface DreamsFile {
  dreams: CloudDreamRecord[]
}

export function isWhitelistedDocName(name: string): name is CloudDocName {
  return (CLOUD_DOC_WHITELIST as readonly string[]).includes(name)
}

export function normalizeMemoryKind(value: unknown): CloudMemoryKind {
  return typeof value === 'string' && (CLOUD_MEMORY_KINDS as readonly string[]).includes(value)
    ? (value as CloudMemoryKind)
    : 'fact'
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const clean = item.trim().slice(0, 32)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clean)
    if (out.length >= 8) break
  }
  return out
}

function normalizeTextKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s"'`.,，。!！?？:：;；\-—_/\\()（）[\]【】]+/g, '')
    .trim()
}

export class CloudMemoryStore {
  private readonly dir: string
  private readonly memoriesPath: string
  private readonly dreamsPath: string
  private memories: CloudMemoryItem[]
  private dreams: CloudDreamRecord[]
  private writeQueue: Promise<void> = Promise.resolve()

  private constructor(dir: string, memories: CloudMemoryItem[], dreams: CloudDreamRecord[]) {
    this.dir = dir
    this.memoriesPath = path.join(dir, 'memories.json')
    this.dreamsPath = path.join(dir, 'dreams.json')
    this.memories = memories
    this.dreams = dreams
  }

  static async open(dataDir: string): Promise<CloudMemoryStore> {
    const dir = path.join(dataDir, 'memory')
    await fs.mkdir(dir, { recursive: true })
    const memoriesPath = path.join(dir, 'memories.json')
    const dreamsPath = path.join(dir, 'dreams.json')
    const memRead = await readJsonAsyncWithBackup<MemoriesFile>(memoriesPath)
    const dreamRead = await readJsonAsyncWithBackup<DreamsFile>(dreamsPath)
    const memories = Array.isArray(memRead.data?.items) ? memRead.data.items : []
    const dreams = Array.isArray(dreamRead.data?.dreams) ? dreamRead.data.dreams : []
    return new CloudMemoryStore(dir, memories, dreams)
  }

  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(fn, fn)
    this.writeQueue = next.catch(() => undefined)
    return next
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  // ------------------------------ 结构化记忆 ------------------------------

  listMemories(): CloudMemoryItem[] {
    return [...this.memories].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
  }

  findMemory(id: string): CloudMemoryItem | undefined {
    return this.memories.find((item) => item.id === id)
  }

  async addMemory(input: {
    kind?: unknown
    content: string
    tags?: unknown
    source?: CloudMemorySource
    pinned?: boolean
    now?: number
  }): Promise<CloudMemoryItem> {
    const content = input.content.trim().slice(0, MAX_CONTENT_LEN)
    if (!content) throw new Error('Memory content cannot be empty')
    const now = input.now ?? Date.now()
    const item: CloudMemoryItem = {
      id: `mem-${randomBytes(4).toString('hex')}`,
      kind: normalizeMemoryKind(input.kind),
      content,
      tags: normalizeTags(input.tags),
      source: input.source ?? 'manual',
      pinned: Boolean(input.pinned),
      createdAt: now,
      updatedAt: now,
    }
    return this.mutateMemories(() => ({
      next: [item, ...this.memories].slice(0, MAX_MEMORIES),
      result: item,
    }))
  }

  /** 用户手工编辑记忆时自动提升为 source='manual'，避免后续被自动抽取或梦境覆盖（F-39） */
  async updateMemory(
    id: string,
    patch: { kind?: unknown; content?: string; tags?: unknown; pinned?: boolean },
    now = Date.now()
  ): Promise<CloudMemoryItem | null> {
    return this.mutateMemories(() => {
      const index = this.memories.findIndex((item) => item.id === id)
      if (index < 0) return { next: this.memories, result: null, changed: false }
      const current = this.memories[index]
      const nextContent =
        typeof patch.content === 'string' ? patch.content.trim().slice(0, MAX_CONTENT_LEN) : current.content
      if (!nextContent) throw new Error('Memory content cannot be empty')
      const updated: CloudMemoryItem = {
        ...current,
        kind: patch.kind !== undefined ? normalizeMemoryKind(patch.kind) : current.kind,
        content: nextContent,
        tags: patch.tags !== undefined ? normalizeTags(patch.tags) : current.tags,
        pinned: typeof patch.pinned === 'boolean' ? patch.pinned : current.pinned,
        source: 'manual',
        updatedAt: now,
      }
      return {
        next: this.memories.map((item, idx) => (idx === index ? updated : item)),
        result: updated,
      }
    })
  }

  async deleteMemory(id: string): Promise<boolean> {
    return this.mutateMemories(() => {
      const next = this.memories.filter((item) => item.id !== id)
      const changed = next.length !== this.memories.length
      return { next, result: changed, changed }
    })
  }

  /**
   * 合并自动抽取候选条目（压缩前调用）：
   * - 按归一化文本去重；
   * - 绝不覆盖或删除 `source === 'manual'` 的手工条目；
   * - 超出上限时优先淘汰最旧的非置顶自动条目。
   */
  async mergeAutoMemories(
    candidates: Array<{ kind?: unknown; content?: unknown; tags?: unknown }>,
    source: 'auto' | 'dream' = 'auto',
    now = Date.now()
  ): Promise<CloudMemoryItem[]> {
    return this.mutateMemories(() => {
      const existingKeys = new Set(this.memories.map((item) => normalizeTextKey(item.content)))
      const added: CloudMemoryItem[] = []
      for (const candidate of candidates) {
        if (typeof candidate.content !== 'string') continue
        const content = candidate.content.trim().slice(0, MAX_CONTENT_LEN)
        const key = normalizeTextKey(content)
        if (!key || key.length < 4 || existingKeys.has(key)) continue
        existingKeys.add(key)
        added.push({
          id: `mem-${randomBytes(4).toString('hex')}`,
          kind: normalizeMemoryKind(candidate.kind),
          content,
          tags: normalizeTags(candidate.tags),
          source,
          pinned: false,
          createdAt: now,
          updatedAt: now,
        })
      }
      if (added.length === 0) return { next: this.memories, result: [], changed: false }
      return {
        next: trimMemories([...added, ...this.memories], MAX_MEMORIES),
        result: added,
      }
    })
  }

  /**
   * 应用梦境整理结果：硬保护所有 `source === 'manual'` 条目，绝不允许梦境删除或覆盖手工记忆。
   */
  async applyDreamConsolidation(
    input: {
      removeIds: string[]
      upsert: Array<{ kind?: unknown; content?: unknown; tags?: unknown }>
    },
    now = Date.now()
  ): Promise<{ added: number; removed: number }> {
    return this.mutateMemories(() => {
      const removable = new Set(
        this.memories.filter((item) => item.source !== 'manual').map((item) => item.id)
      )
      const toRemove = new Set(input.removeIds.filter((id) => removable.has(id)))
      const kept =
        toRemove.size > 0 ? this.memories.filter((item) => !toRemove.has(item.id)) : this.memories
      const removed = this.memories.length - kept.length

      const existingKeys = new Set(kept.map((item) => normalizeTextKey(item.content)))
      const added: CloudMemoryItem[] = []
      for (const candidate of input.upsert) {
        if (typeof candidate.content !== 'string') continue
        const content = candidate.content.trim().slice(0, MAX_CONTENT_LEN)
        const key = normalizeTextKey(content)
        if (!key || key.length < 4 || existingKeys.has(key)) continue
        existingKeys.add(key)
        added.push({
          id: `mem-${randomBytes(4).toString('hex')}`,
          kind: normalizeMemoryKind(candidate.kind),
          content,
          tags: normalizeTags(candidate.tags),
          source: 'dream',
          pinned: false,
          createdAt: now,
          updatedAt: now,
        })
      }
      const changed = removed > 0 || added.length > 0
      const next = changed ? trimMemories([...added, ...kept], MAX_MEMORIES) : this.memories
      return { next, result: { added: added.length, removed }, changed }
    })
  }

  /** 在串行写锁内执行内存更新 + 落盘，写入失败时保持原内存状态避免磁盘与内存分叉 */
  private async mutateMemories<R>(fn: () => { next: CloudMemoryItem[]; result: R; changed?: boolean }): Promise<R> {
    let outcome!: R
    await this.enqueueWrite(async () => {
      const { next, result, changed = true } = fn()
      outcome = result
      if (!changed) return
      const snapshot: MemoriesFile = { items: [...next] }
      await writeJsonAtomicAsync(this.memoriesPath, snapshot)
      this.memories = next
    })
    return outcome
  }

  // ------------------------------ 梦境记录 ------------------------------

  listDreams(): CloudDreamRecord[] {
    return [...this.dreams].sort((a, b) => b.at - a.at)
  }

  lastDreamAt(): number {
    return this.dreams.reduce((max, item) => Math.max(max, item.at), 0)
  }

  async appendDream(record: Omit<CloudDreamRecord, 'id'>): Promise<CloudDreamRecord> {
    const full: CloudDreamRecord = {
      id: `dream-${randomBytes(4).toString('hex')}`,
      ...record,
    }
    await this.enqueueWrite(async () => {
      const next = [full, ...this.dreams].slice(0, MAX_DREAMS)
      const snapshot: DreamsFile = { dreams: [...next] }
      await writeJsonAtomicAsync(this.dreamsPath, snapshot)
      this.dreams = next
    })
    return full
  }

  // ------------------------------ 留存文档（白名单：AGENTS.md / SOUL.md） ------------------------------

  async readDoc(name: CloudDocName): Promise<CloudDocView> {
    if (!isWhitelistedDocName(name)) throw new Error(`Doc not allowed: ${String(name)}`)
    const filePath = path.join(this.dir, name)
    try {
      const [content, stat] = await Promise.all([fs.readFile(filePath, 'utf-8'), fs.stat(filePath)])
      return { name, content, exists: true, updatedAt: Math.floor(stat.mtimeMs) }
    } catch {
      return { name, content: '', exists: false, updatedAt: null }
    }
  }

  async listDocs(): Promise<CloudDocView[]> {
    return Promise.all(CLOUD_DOC_WHITELIST.map((name) => this.readDoc(name)))
  }

  async writeDoc(name: CloudDocName, content: string): Promise<CloudDocView> {
    if (!isWhitelistedDocName(name)) throw new Error(`Doc not allowed: ${String(name)}`)
    if (Buffer.byteLength(content, 'utf8') > CLOUD_DOC_MAX_BYTES) {
      throw new Error(`Document exceeds ${CLOUD_DOC_MAX_BYTES} bytes limit`)
    }
    const filePath = path.join(this.dir, name)
    const tmp = `${filePath}.${randomBytes(4).toString('hex')}.tmp`
    await this.enqueueWrite(async () => {
      await fs.mkdir(this.dir, { recursive: true })
      const handle = await fs.open(tmp, 'w')
      try {
        await handle.writeFile(content, 'utf-8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(tmp, filePath)
    })
    return this.readDoc(name)
  }
}

/** 淘汰溢出条目：手工与置顶条目永不先淘汰 */
function trimMemories(items: CloudMemoryItem[], limit: number): CloudMemoryItem[] {
  if (items.length <= limit) return items
  const protectedItems = items.filter((item) => item.pinned || item.source === 'manual')
  const autoItems = items
    .filter((item) => !item.pinned && item.source !== 'manual')
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const room = Math.max(0, limit - protectedItems.length)
  return [...protectedItems, ...autoItems.slice(0, room)].slice(0, limit)
}
