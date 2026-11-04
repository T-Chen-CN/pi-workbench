/**
 * 未结算账本：这一轮到底做没做？
 *
 * 定位是**事后观测**，不是拦截。拦截需要审批层，而审批已整体取消（见 BACKLOG §7.4）。
 *
 * 三个动作：
 * 1. 记账 —— `tool.started` 时按命令表分类，命中三类（对外写 / 系统级 / 破坏性）才记；
 * 2. 结账 —— `tool.completed` 落定；run 终态仍未结账的标 `unknown`；
 * 3. 复核 —— 重连后按 `tool_call_id` 去历史消息里找 `role:"tool"` 行，找到就推定完成，
 *    找不到就留给人工三选一（做了 / 没做 / 不管）。
 *
 * 为什么不记文件写入：`write_file` / `patch` 几乎每轮都命中，噪音太大，
 * 而且改动都在 git 里可回滚。只记"出去了就收不回来"的那三类。
 */

import * as path from 'path'
import { getAppDir } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomicSync } from '../atomic-json.js'
import type { CloudPendingWrite, CloudWriteClass, CloudWriteStatus } from './types.js'

/** 账本最多留多少条（超出按时间从旧到新丢） */
export const LEDGER_MAX_ENTRIES = 200
/** 已确认的条目留多久（毫秒） */
export const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** 还需要人看一眼的状态 */
const OPEN_STATUSES: CloudWriteStatus[] = ['pending', 'unknown']

export function ledgerFile(): string {
  return path.join(getAppDir(), 'data', 'cloud-agent', 'pending-writes.json')
}

export function isOpenWrite(entry: CloudPendingWrite): boolean {
  return OPEN_STATUSES.includes(entry.status)
}

interface WriteRule {
  writeClass: CloudWriteClass
  /** 命中任意一条就算这一类；大小写不敏感 */
  patterns: RegExp[]
}

/**
 * 分类表。顺序有意义：破坏性优先于系统级，系统级优先于对外写
 * （`sudo rm -rf /x` 应该归到 irreversible）。
 */
const WRITE_RULES: WriteRule[] = [
  {
    writeClass: 'irreversible',
    patterns: [
      /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
      /\bdd\s+if=/i,
      /\bmkfs(\.\w+)?\b/i,
      /\bchmod\s+(-r\s+)?777\b/i,
      /\btruncate\s+-s\s*0\b/i,
      />\s*\/dev\/(sd|nvme|hd)/i,
      /\bshred\b/i,
      /\bgit\s+push\b[^\n]*\s(-f|--force)\b/i,
    ],
  },
  {
    writeClass: 'system',
    patterns: [
      /\bsystemctl\b/i,
      /\b(apt|apt-get|yum|dnf|pacman|brew)\s+(install|remove|purge|upgrade|update)\b/i,
      /\bsudo\b/i,
      /\bcrontab\b/i,
      /\buseradd\b|\buserdel\b|\busermod\b|\bgroupadd\b/i,
      /\biptables\b|\bufw\b|\bnft\b/i,
      /authorized_keys/i,
      /\btelegraf\b|\bnginx\s+-s\b/i,
      /\bkill(all)?\b\s+-9/i,
      /\bmount\b|\bumount\b/i,
      /\bsysctl\b/i,
      /\bvisudo\b|\/etc\/sudoers/i,
    ],
  },
  {
    writeClass: 'external',
    patterns: [
      /\bgit\s+push\b/i,
      /\bcurl\b[^\n]*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|--request\s+(POST|PUT|PATCH|DELETE)\b|\s-d\s|\s--data\b|\s-F\s|\s--form\b|\s-T\s|\s--upload-file\b)/i,
      /\bwget\b[^\n]*(--post-data|--post-file|--method=?(POST|PUT|DELETE))/i,
      /\b(http|https)\s+(POST|PUT|PATCH|DELETE)\b/i,
      /\bssh\b|\bscp\b|\brsync\b|\bsftp\b/i,
      /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/i,
      /\btwine\s+upload\b|\bpip\s+upload\b/i,
      /\bdocker\s+push\b/i,
      /\bgh\s+(pr|release|issue|api)\b[^\n]*(-X\s*(POST|PATCH|DELETE)|create|merge|close|edit)/i,
      /\b(aws|gcloud|az|tencentcloud)\b/i,
      /\b(sendmail|mail|mailx)\b|\bsmtp\b/i,
      /\bwebhook\b/i,
      /\bgit\s+clone\b|\bgit\s+fetch\b|\bgit\s+pull\b/i,
    ],
  },
]

/** 哪些工具的输出算"命令文本"：只有 terminal 类工具的 preview 是命令行 */
const COMMAND_TOOLS = new Set(['terminal', 'process', 'shell', 'bash', 'exec'])

/**
 * 判断这次工具调用要不要记账。
 *
 * `preview` 只有 `terminal` 类工具是命令行；其它工具（read / web_search / vision）
 * 即便参数里出现 `curl` 也不该记账，所以先按工具名过滤。
 */
export function classifyToolWrite(input: {
  toolName: string
  summary: string
}): CloudWriteClass | null {
  const tool = String(input.toolName ?? '').toLowerCase()
  if (!COMMAND_TOOLS.has(tool)) return null
  const command = String(input.summary ?? '')
  if (!command.trim()) return null
  for (const rule of WRITE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(command))) return rule.writeClass
  }
  return null
}

export function makeWriteEntry(input: {
  runId: string
  sessionId: string | null
  toolCallId: string
  toolName: string
  summary: string
  writeClass: CloudWriteClass
  now?: number
}): CloudPendingWrite {
  return {
    id: `${input.runId}:${input.toolCallId}`,
    runId: input.runId,
    sessionId: input.sessionId,
    toolName: input.toolName,
    writeClass: input.writeClass,
    summary: input.summary.slice(0, 300),
    startedAt: input.now ?? Date.now(),
    status: 'pending',
  }
}

/** 记账（幂等：同 id 只记一次，重复帧不刷时间） */
export function recordStarted(
  entries: CloudPendingWrite[],
  entry: CloudPendingWrite
): CloudPendingWrite[] {
  if (entries.some((item) => item.id === entry.id)) return entries
  return [entry, ...entries]
}

/** 结账：找不到就原样返回（可能是历史帧或未记账的工具） */
export function recordCompleted(
  entries: CloudPendingWrite[],
  runId: string,
  toolCallId: string,
  ok: boolean,
  now = Date.now()
): CloudPendingWrite[] {
  const id = `${runId}:${toolCallId}`
  let touched = false
  const next = entries.map((entry) => {
    if (entry.id !== id || entry.status !== 'pending') return entry
    touched = true
    return { ...entry, status: (ok ? 'done' : 'failed') as CloudWriteStatus, settledAt: now }
  })
  return touched ? next : entries
}

/**
 * 一轮结束：还挂着的条目变成 `unknown`。
 * 这代表"我们没看到它的结果"，正是账本要处理的那种情况。
 */
export function settleRun(
  entries: CloudPendingWrite[],
  runId: string,
  now = Date.now()
): CloudPendingWrite[] {
  let touched = false
  const next = entries.map((entry) => {
    if (entry.runId !== runId || entry.status !== 'pending') return entry
    touched = true
    return { ...entry, status: 'unknown' as CloudWriteStatus, settledAt: now }
  })
  return touched ? next : entries
}

/**
 * 用历史消息复核：`tool_call_id` 出现在该会话的工具行里 → 推定做完了。
 * 只动 `unknown`，且标记 `inferred`，UI 上要显示"按历史推断"。
 */
export function reconcileWithHistory(
  entries: CloudPendingWrite[],
  sessionId: string,
  toolCallIds: Set<string>,
  now = Date.now()
): CloudPendingWrite[] {
  let touched = false
  const next = entries.map((entry) => {
    if (entry.status !== 'unknown' || entry.sessionId !== sessionId) return entry
    const callId = entry.id.slice(entry.id.indexOf(':') + 1)
    if (!toolCallIds.has(callId)) return entry
    touched = true
    return {
      ...entry,
      status: 'done' as CloudWriteStatus,
      inferred: true,
      settledAt: now,
    }
  })
  return touched ? next : entries
}

/** 人工三选一 */
export function applyVerdict(
  entries: CloudPendingWrite[],
  id: string,
  verdict: 'done' | 'missing' | 'ignored',
  now = Date.now()
): CloudPendingWrite[] {
  const status: CloudWriteStatus =
    verdict === 'done' ? 'confirmed_done' : verdict === 'missing' ? 'confirmed_missing' : 'ignored'
  return entries.map((entry) =>
    entry.id === id ? { ...entry, status, confirmedAt: now, settledAt: now } : entry
  )
}

/** 剪枝：先删过期已确认，再按总量截断 */
export function pruneLedger(entries: CloudPendingWrite[], now = Date.now()): CloudPendingWrite[] {
  const kept = entries.filter((entry) => {
    if (isOpenWrite(entry)) return true
    const at = entry.settledAt ?? entry.startedAt
    return now - at <= LEDGER_RETENTION_MS
  })
  return kept.slice(0, LEDGER_MAX_ENTRIES)
}

interface LedgerFile {
  version: 1
  entries: CloudPendingWrite[]
}

export function readLedger(): CloudPendingWrite[] {
  const raw = readJsonWithBackup<LedgerFile>(ledgerFile()).data
  const entries = Array.isArray(raw?.entries) ? raw.entries : []
  // 坏数据不能把整个视图拖下水：逐条校验形状
  return entries.filter(
    (entry): entry is CloudPendingWrite =>
      Boolean(entry) &&
      typeof entry.id === 'string' &&
      typeof entry.summary === 'string' &&
      typeof entry.startedAt === 'number' &&
      typeof entry.status === 'string'
  )
}

export function writeLedger(entries: CloudPendingWrite[]): CloudPendingWrite[] {
  const pruned = pruneLedger(entries)
  writeJsonAtomicSync(ledgerFile(), { version: 1, entries: pruned } satisfies LedgerFile)
  return pruned
}

/** 读 → 变更 → 剪枝 → 写，一把梭；返回变更后的列表 */
export function mutateLedger(
  mutate: (entries: CloudPendingWrite[]) => CloudPendingWrite[]
): CloudPendingWrite[] {
  return writeLedger(mutate(readLedger()))
}
