/**
 * 云端持久记忆、留存文档与梦境记录存储（F-39 / F-41 / F-42 / C-03a / D9）。
 *
 * 持久化分层：
 * - 结构化记忆与梦境记录统一落入 `cloud.db`（`memories` / `dreams` 表，事务化写入）；
 *   首次升级若检测到历史 `${dataDir}/memory/memories.json` 或 `dreams.json` 且库表为空，
 *   自动在单个事务内导入 `cloud.db` 并将旧 JSON 重命名为 `.migrated`；
 *   单测未传 `CloudStore` 时保留轻量独立 JSON 回退，避免泄漏未关闭 SQLite 句柄。
 * - `AGENTS.md` / `SOUL.md` 保持为 `${dataDir}/memory/` 下可直接编辑的白名单 Markdown 文件。
 *
 * 两条硬约束：
 * 1. `source === 'manual'` 的手工记忆永远优先：自动抽取与梦境整理绝不覆盖或删除它；
 * 2. 文档读写只接受 `CLOUD_DOC_WHITELIST` 里的固定文件名，拒绝任何路径穿越或额外文件名。
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { readJsonAsyncWithBackup, writeJsonAtomicAsync } from 'pi-bridge/atomic-json'
import type { CloudStore } from '../store/store.js'

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

function normalizeMemorySource(value: unknown): CloudMemorySource {
  return value === 'auto' || value === 'dream' || value === 'manual' ? value : 'manual'
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

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function renameToMigrated(sourcePath: string): Promise<void> {
  const destPath = `${sourcePath}.migrated`
  try {
    await fs.rename(sourcePath, destPath)
  } catch {
    // Windows 上目标已存在时回退先删后改名
    try {
      await fs.unlink(destPath).catch(() => undefined)
      await fs.rename(sourcePath, destPath)
    } catch {
      // ignore best-effort rename failure
    }
  }
}

function sanitizeLegacyMemories(rawItems: unknown[]): CloudMemoryItem[] {
  const out: CloudMemoryItem[] = []
  const now = Date.now()
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue
    const rec = raw as Record<string, unknown>
    const content = typeof rec.content === 'string' ? rec.content.trim().slice(0, MAX_CONTENT_LEN) : ''
    if (!content) continue
    const id =
      typeof rec.id === 'string' && rec.id.trim()
        ? rec.id.trim()
        : `mem-${randomBytes(4).toString('hex')}`
    const createdAt = typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : now
    const updatedAt = typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : createdAt
    out.push({
      id,
      kind: normalizeMemoryKind(rec.kind),
      content,
      tags: normalizeTags(rec.tags),
      source: normalizeMemorySource(rec.source),
      pinned: Boolean(rec.pinned),
      createdAt,
      updatedAt,
    })
  }
  return trimMemories(out, MAX_MEMORIES)
}

function sanitizeLegacyDreams(rawDreams: unknown[]): CloudDreamRecord[] {
  const out: CloudDreamRecord[] = []
  const now = Date.now()
  for (const raw of rawDreams) {
    if (!raw || typeof raw !== 'object') continue
    const rec = raw as Record<string, unknown>
    const id =
      typeof rec.id === 'string' && rec.id.trim()
        ? rec.id.trim()
        : `dream-${randomBytes(4).toString('hex')}`
    out.push({
      id,
      at: typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : now,
      trigger: rec.trigger === 'idle' ? 'idle' : 'manual',
      summary: typeof rec.summary === 'string' ? rec.summary.slice(0, 400) : '',
      added: typeof rec.added === 'number' && Number.isFinite(rec.added) ? rec.added : 0,
      merged: typeof rec.merged === 'number' && Number.isFinite(rec.merged) ? rec.merged : 0,
      removed: typeof rec.removed === 'number' && Number.isFinite(rec.removed) ? rec.removed : 0,
    })
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_DREAMS)
}

export class CloudMemoryStore {
  private readonly dir: string
  private readonly memoriesPath: string
  private readonly dreamsPath: string
  private readonly cloudStore?: CloudStore
  private memories: CloudMemoryItem[]
  private dreams: CloudDreamRecord[]
  private writeQueue: Promise<void> = Promise.resolve()

  private constructor(
    dir: string,
    memories: CloudMemoryItem[],
    dreams: CloudDreamRecord[],
    cloudStore?: CloudStore
  ) {
    this.dir = dir
    this.memoriesPath = path.join(dir, 'memories.json')
    this.dreamsPath = path.join(dir, 'dreams.json')
    this.memories = memories
    this.dreams = dreams
    this.cloudStore = cloudStore
  }

  static async open(dataDir: string, cloudStore?: CloudStore): Promise<CloudMemoryStore> {
    const dir = path.join(dataDir, 'memory')
    await fs.mkdir(dir, { recursive: true })
    const memoriesPath = path.join(dir, 'memories.json')
    const dreamsPath = path.join(dir, 'dreams.json')

    if (cloudStore) {
      // 首次从旧 JSON 升级：仅当目标 SQLite 表为空且旧文件存在时导入并重命名为 `.migrated`
      const [hasLegacyMem, hasLegacyDream] = await Promise.all([
        fileExists(memoriesPath),
        fileExists(dreamsPath),
      ])
      if (hasLegacyMem && cloudStore.countMemories() === 0) {
        const memRead = await readJsonAsyncWithBackup<MemoriesFile>(memoriesPath)
        const legacyItems = Array.isArray(memRead.data?.items)
          ? sanitizeLegacyMemories(memRead.data.items)
          : []
        cloudStore.replaceMemories(legacyItems)
        await renameToMigrated(memoriesPath)
      }
      if (hasLegacyDream && cloudStore.countDreams() === 0) {
        const dreamRead = await readJsonAsyncWithBackup<DreamsFile>(dreamsPath)
        const legacyDreams = Array.isArray(dreamRead.data?.dreams)
          ? sanitizeLegacyDreams(dreamRead.data.dreams)
          : []
        cloudStore.importDreams(legacyDreams, MAX_DREAMS)
        await renameToMigrated(dreamsPath)
      }
      return new CloudMemoryStore(dir, [], [], cloudStore)
    }

    // 独立回退模式（供无 CloudStore 的纯单测使用）
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
    if (this.cloudStore) return this.cloudStore.listMemories()
    return [...this.memories].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
  }

  findMemory(id: string): CloudMemoryItem | undefined {
    if (this.cloudStore) return this.cloudStore.findMemory(id)
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
    return this.mutateMemories((current) => ({
      next: trimMemories([item, ...current], MAX_MEMORIES),
      result: item,
    }))
  }

  /** 用户手工编辑记忆时自动提升为 source='manual'，避免后续被自动抽取或梦境覆盖（F-39） */
  async updateMemory(
    id: string,
    patch: { kind?: unknown; content?: string; tags?: unknown; pinned?: boolean },
    now = Date.now()
  ): Promise<CloudMemoryItem | null> {
    return this.mutateMemories((items) => {
      const index = items.findIndex((item) => item.id === id)
      if (index < 0) return { next: items, result: null, changed: false }
      const current = items[index]
      const nextContent =
        typeof patch.content === 'string'
          ? patch.content.trim().slice(0, MAX_CONTENT_LEN)
          : current.content
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
        next: items.map((item, idx) => (idx === index ? updated : item)),
        result: updated,
      }
    })
  }

  async deleteMemory(id: string): Promise<boolean> {
    if (this.cloudStore) {
      return this.cloudStore.deleteMemoryRow(id)
    }
    return this.mutateMemories((items) => {
      const next = items.filter((item) => item.id !== id)
      const changed = next.length !== items.length
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
    return this.mutateMemories((items) => {
      const existingKeys = new Set(items.map((item) => normalizeTextKey(item.content)))
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
      if (added.length === 0) return { next: items, result: [], changed: false }
      return {
        next: trimMemories([...added, ...items], MAX_MEMORIES),
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
    return this.mutateMemories((items) => {
      const removable = new Set(
        items.filter((item) => item.source !== 'manual').map((item) => item.id)
      )
      const toRemove = new Set(input.removeIds.filter((id) => removable.has(id)))
      const kept = toRemove.size > 0 ? items.filter((item) => !toRemove.has(item.id)) : items
      const removed = items.length - kept.length

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
      const next = changed ? trimMemories([...added, ...kept], MAX_MEMORIES) : items
      return { next, result: { added: added.length, removed }, changed }
    })
  }

  /** SQLite 事务内原子更新，或独立回退模式下串行写锁内原子写 JSON */
  private async mutateMemories<R>(
    fn: (current: CloudMemoryItem[]) => { next: CloudMemoryItem[]; result: R; changed?: boolean }
  ): Promise<R> {
    if (this.cloudStore) {
      const dbStore = this.cloudStore
      return dbStore.runTransaction(() => {
        const current = dbStore.listMemories()
        const { next, result, changed = true } = fn(current)
        if (!changed) return result
        dbStore.replaceMemories(next)
        return result
      })
    }

    let outcome!: R
    await this.enqueueWrite(async () => {
      const { next, result, changed = true } = fn(this.memories)
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
    if (this.cloudStore) return this.cloudStore.listDreams()
    return [...this.dreams].sort((a, b) => b.at - a.at)
  }

  lastDreamAt(): number {
    if (this.cloudStore) return this.cloudStore.lastDreamAt()
    return this.dreams.reduce((max, item) => Math.max(max, item.at), 0)
  }

  async appendDream(record: Omit<CloudDreamRecord, 'id'>): Promise<CloudDreamRecord> {
    const full: CloudDreamRecord = {
      id: `dream-${randomBytes(4).toString('hex')}`,
      ...record,
    }
    if (this.cloudStore) {
      this.cloudStore.appendDreamRecord(full, MAX_DREAMS)
      return full
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
