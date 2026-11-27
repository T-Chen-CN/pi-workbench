/**
 * 云端记忆引擎：压缩前抽取 + 每轮相关性注入 + 梦境整理（F-38 / F-39 / F-41 / A-25）。
 *
 * 完全基于 Pi SDK 原生机制：
 * - 注入：注册 `before_agent_start` 扩展钩子，将 `SOUL.md` + `AGENTS.md` + 命中的 Top-K 记忆
 *   拼进本轮 `systemPrompt`（严格控字数上限，不挤爆上下文）；
 * - 抽取：挂在 `onSessionBeforeCompact` 钩子上，拿到待压缩的 `branchEntries` 后调辅助模型提炼要点；
 * - 梦境：空闲 ≥30 分钟且无活跃工单时后台去重合并非手工条目，结果写 `dreams.json` 并留痕。
 */

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import {
  CloudMemoryStore,
  type CloudDreamRecord,
  type CloudMemoryItem,
} from './memory-store.js'

export const CLOUD_DREAM_IDLE_MS = 30 * 60 * 1000
const MAX_INJECT_CHARS = 6_000
const MAX_DOC_INJECT_CHARS = 2_000
const MAX_MEMORY_INJECT_ITEMS = 16
const MAX_TRANSCRIPT_EXTRACT_CHARS = 12_000

export type AuxiliaryCompleter = (
  systemPrompt: string,
  userPrompt: string,
  options?: { maxTokens?: number; timeoutMs?: number }
) => Promise<string | null>

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()
  for (const match of lower.matchAll(/[a-z0-9_.-]{2,}|[\u4e00-\u9fff]{2,}/g)) {
    const word = match[0]
    tokens.add(word)
    // 中文短语补 2-gram，提升「记忆命中」召回率（如「画板开发」命中「画板」）
    if (/^[\u4e00-\u9fff]{3,}$/.test(word)) {
      for (let i = 0; i < word.length - 1; i += 1) {
        tokens.add(word.slice(i, i + 2))
      }
    }
  }
  return tokens
}

/** 按置顶 + 关键词/标签相关性 + 新近度挑出本轮最相关的记忆条目 */
export function selectRelevantMemories(
  items: CloudMemoryItem[],
  queryText: string,
  limit = MAX_MEMORY_INJECT_ITEMS
): CloudMemoryItem[] {
  if (items.length === 0) return []
  const queryTokens = tokenize(queryText)
  const scored = items.map((item) => {
    let score = 0
    if (item.pinned) score += 100
    if (item.source === 'manual') score += 10
    if (queryTokens.size > 0) {
      const itemTokens = tokenize(`${item.content} ${item.tags.join(' ')}`)
      let overlap = 0
      for (const token of queryTokens) {
        if (itemTokens.has(token)) overlap += 1
      }
      score += overlap * 12
    }
    return { item, score }
  })
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.item.updatedAt - a.item.updatedAt
  })
  return scored.slice(0, limit).map((entry) => entry.item)
}

/** 组装本轮注入云端系统提示的持久文档与记忆块（严格控预算） */
export async function buildMemoryContextBlock(
  store: CloudMemoryStore,
  queryText: string,
  maxChars = MAX_INJECT_CHARS
): Promise<string> {
  const [soul, agents] = await Promise.all([store.readDoc('SOUL.md'), store.readDoc('AGENTS.md')])
  const sections: string[] = []
  let remaining = maxChars

  const pushSection = (title: string, body: string, cap: number) => {
    const trimmed = body.trim()
    if (!trimmed || remaining <= 120) return
    const budget = Math.min(cap, remaining - title.length - 16)
    if (budget <= 40) return
    const clipped =
      trimmed.length > budget ? `${trimmed.slice(0, budget)}\n...[truncated]` : trimmed
    const block = `## ${title}\n${clipped}`
    sections.push(block)
    remaining -= block.length + 2
  }

  if (soul.content.trim()) pushSection('Cloud Persona (SOUL.md)', soul.content, MAX_DOC_INJECT_CHARS)
  if (agents.content.trim()) {
    pushSection('Cloud Working Rules (AGENTS.md)', agents.content, MAX_DOC_INJECT_CHARS)
  }

  const relevant = selectRelevantMemories(store.listMemories(), queryText)
  if (relevant.length > 0 && remaining > 120) {
    const lines: string[] = []
    for (const item of relevant) {
      const tags = item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : ''
      const mark = item.pinned ? ' ★' : ''
      const line = `- (${item.kind}${mark}) ${item.content}${tags}`
      if (lines.join('\n').length + line.length + 40 > remaining) break
      lines.push(line)
    }
    if (lines.length > 0) {
      sections.push(`## Long-term Cloud Memory\n${lines.join('\n')}`)
    }
  }

  if (sections.length === 0) return ''
  return ['<cloud-persistent-context>', ...sections, '</cloud-persistent-context>'].join('\n\n')
}

export interface CloudMemoryExtensionOptions {
  complete?: AuxiliaryCompleter
  onExtracted?: (added: CloudMemoryItem[]) => void
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

/**
 * Pi SDK 原生扩展（F-38 / F-39 / A-25）：
 * 1. `before_agent_start`：每轮开始前动态注入 `SOUL.md` + `AGENTS.md` + 相关 Top-K 记忆；
 * 2. `session_before_compact`：压缩前拿到完整 `branchEntries` 自动提炼长期记忆。
 */
export function createCloudMemoryExtension(
  store: CloudMemoryStore,
  options: CloudMemoryExtensionOptions = {}
): ExtensionFactory {
  return (pi) => {
    pi.on('before_agent_start', async (event) => {
      try {
        const promptText =
          'prompt' in event && typeof event.prompt === 'string' ? event.prompt : ''
        const block = await buildMemoryContextBlock(store, promptText)
        if (!block) return undefined
        const base = typeof event.systemPrompt === 'string' ? event.systemPrompt : ''
        return {
          systemPrompt: base ? `${base}\n\n${block}` : block,
        }
      } catch {
        // 记忆读取异常不得阻塞正常对话
        return undefined
      }
    })

    if (options.complete) {
      const complete = options.complete
      pi.on('session_before_compact', async (event) => {
        try {
          const entries = Array.isArray(event.branchEntries) ? event.branchEntries : []
          const added = await extractMemoriesBeforeCompact(store, entries, complete)
          if (added.length > 0) {
            options.onExtracted?.(added)
            options.logger?.info(`[cloud] extracted ${added.length} memory item(s) before compaction`)
          }
        } catch (error) {
          options.logger?.warn('[cloud] pre-compact memory extraction failed:', error)
        }
      })
    }
  }
}

/** 从压缩前 `branchEntries` 提取可读对话文本（忽略纯工具噪声，限长） */
export function extractConversationTranscript(entries: readonly unknown[]): string {
  const lines: string[] = []
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    if (entry.type !== 'message') continue
    const message = entry.message as Record<string, unknown> | undefined
    if (!message) continue
    const role = message.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = message.content
    let text = ''
    if (typeof content === 'string') {
      text = content.trim()
    } else if (Array.isArray(content)) {
      text = content
        .filter(
          (part): part is { type: 'text'; text: string } =>
            Boolean(part && typeof part === 'object' && (part as { type?: unknown }).type === 'text')
        )
        .map((part) => String(part.text ?? '').trim())
        .filter(Boolean)
        .join('\n')
    }
    if (!text) continue
    lines.push(`${role === 'user' ? 'User' : 'Assistant'}: ${text.slice(0, 800)}`)
  }
  const joined = lines.join('\n')
  if (joined.length <= MAX_TRANSCRIPT_EXTRACT_CHARS) return joined
  return joined.slice(-MAX_TRANSCRIPT_EXTRACT_CHARS)
}

function parseJsonObject<T>(raw: string): T | null {
  const trimmed = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = (fenced ? fenced[1] : trimmed).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

const EXTRACT_SYSTEM_PROMPT = [
  'You extract durable long-term memories from a cloud coding orchestrator conversation right before context compaction.',
  'Only extract lasting facts, user preferences, project conventions/states, confirmed decisions, or open follow-up todos.',
  'Never store transient tool output, secrets, API keys, or vague chitchat.',
  'Return strict JSON only: {"items":[{"kind":"fact|preference|project|decision|todo","content":"concise single sentence","tags":["repo-or-topic"]}]}',
  'Return {"items":[]} if nothing durable needs to be saved.',
].join('\n')

/** 压缩前自动记忆抽取（F-38 / A-25）：挂在 SDK 原生 `session_before_compact` 上 */
export async function extractMemoriesBeforeCompact(
  store: CloudMemoryStore,
  branchEntries: readonly unknown[],
  complete: AuxiliaryCompleter,
  now = Date.now()
): Promise<CloudMemoryItem[]> {
  const transcript = extractConversationTranscript(branchEntries)
  if (transcript.length < 40) return []
  const existing = store
    .listMemories()
    .slice(0, 30)
    .map((item) => `- (${item.kind}) ${item.content}`)
    .join('\n')
  const userPrompt = [
    existing ? `Existing memories (do not duplicate):\n${existing}` : 'Existing memories: (none)',
    `Conversation segment about to be compacted:\n${transcript}`,
  ].join('\n\n')
  const raw = await complete(EXTRACT_SYSTEM_PROMPT, userPrompt, { maxTokens: 1024, timeoutMs: 20_000 })
  if (!raw) return []
  const parsed = parseJsonObject<{ items?: Array<{ kind?: unknown; content?: unknown; tags?: unknown }> }>(raw)
  if (!parsed || !Array.isArray(parsed.items)) return []
  return store.mergeAutoMemories(parsed.items, 'auto', now)
}

const DREAM_SYSTEM_PROMPT = [
  'You consolidate long-term memory entries for a single-user cloud coding orchestrator during idle dream maintenance.',
  'Rules:',
  '1. Deduplicate overlapping auto/dream memories and merge related ones into crisp, accurate statements.',
  '2. Never modify or list any manual memory id in removeIds (manual entries are read-only user overrides).',
  '3. Drop obsolete/redundant auto entries by putting their ids in removeIds and put consolidated replacements in upsert.',
  'Return strict JSON only: {"summary":"short 1-line Chinese summary of what changed","removeIds":["mem-..."],"upsert":[{"kind":"fact|preference|project|decision|todo","content":"...","tags":["..."]}]}',
].join('\n')

/** 梦境后台整理（F-41）：去重合并非手工记忆、写 `dreams.json` 留痕 */
export async function runDreamConsolidation(
  store: CloudMemoryStore,
  trigger: 'idle' | 'manual',
  complete: AuxiliaryCompleter,
  now = Date.now()
): Promise<CloudDreamRecord | null> {
  const all = store.listMemories()
  const autoItems = all.filter((item) => item.source !== 'manual')
  const manualItems = all.filter((item) => item.source === 'manual')
  if (autoItems.length === 0) {
    if (trigger === 'manual') {
      return store.appendDream({
        at: now,
        trigger,
        summary: '当前没有需要整理的自动记忆条目。',
        added: 0,
        merged: 0,
        removed: 0,
      })
    }
    return null
  }

  // 分批整理（每批最多 50 条）并提升 maxTokens 上限，避免 200 条全部塞进 1024 token 输出被截断
  const batch = autoItems.slice(0, 50)
  const eligibleIds = new Set(batch.map((m) => m.id))

  const userPrompt = [
    manualItems.length > 0
      ? `Manual memories (READ-ONLY, NEVER remove or contradict):\n${manualItems.map((m) => `- [${m.id}] (${m.kind}) ${m.content}`).join('\n')}`
      : 'Manual memories: (none)',
    `Auto/dream memories eligible for consolidation (${batch.length} of ${autoItems.length}):\n${batch.map((m) => `- [${m.id}] (${m.kind}) ${m.content}`).join('\n')}`,
  ].join('\n\n')

  const raw = await complete(DREAM_SYSTEM_PROMPT, userPrompt, { maxTokens: 4096, timeoutMs: 25_000 })
  if (!raw) return null
  const parsed = parseJsonObject<{
    summary?: unknown
    removeIds?: unknown
    upsert?: Array<{ kind?: unknown; content?: unknown; tags?: unknown }>
  }>(raw)
  if (!parsed) return null

  const removeIds = Array.isArray(parsed.removeIds)
    ? parsed.removeIds.filter((id): id is string => typeof id === 'string' && eligibleIds.has(id))
    : []
  const upsert = Array.isArray(parsed.upsert) ? parsed.upsert : []
  // 截断或异常回复防护：若一次要求删除超过半数（且 >5 条）自动记忆却无任何新合并条目，拒绝落地防误删
  if (removeIds.length > Math.max(5, Math.ceil(batch.length * 0.5)) && upsert.length === 0) {
    return null
  }
  const applied = await store.applyDreamConsolidation({ removeIds, upsert }, now)
  const merged = Math.min(applied.added, applied.removed)
  const summary =
    typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 240)
      : `整理完成：新增 ${applied.added} 条、移除 ${applied.removed} 条。`
  return store.appendDream({
    at: now,
    trigger,
    summary,
    added: applied.added,
    merged,
    removed: applied.removed,
  })
}
