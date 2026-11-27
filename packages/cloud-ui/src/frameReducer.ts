/**
 * 桌面端与云端 Web 共享的 WS 协议帧归并器（纯函数、无副作用、零 Electron / zustand 依赖）。
 */

import {
  CLOUD_PROTOCOL_VERSION,
  isCloudTaskActiveStatus,
  type CloudAgentStatusName,
  type CloudAuthorizationRow,
  type CloudAwaySummaryRow,
  type CloudChangedFileRow,
  type CloudChatRow,
  type CloudDeviceRow,
  type CloudNotice,
  type CloudSecretHitRow,
  type CloudSessionState,
  type CloudTaskRow,
  type CloudTaskStatusName,
  type CloudTraceRow,
  type CloudUnitRow,
} from './types'

const USER_ECHO_PREFIX = 'u-'

function fallbackMessageId(now: number): string {
  return `m-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function normalizeCloudChangedFiles(raw: unknown): CloudChangedFileRow[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item) => ({
      path: String(item.path ?? ''),
      kind: String(item.kind ?? 'modified'),
      ...(typeof item.attention === 'string' && item.attention ? { attention: item.attention } : {}),
    }))
    .filter((item) => Boolean(item.path))
}

export function normalizeCloudSecretHits(raw: unknown): CloudSecretHitRow[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item) => ({
      path: String(item.path ?? ''),
      line: Number(item.line ?? 0),
      kind: String(item.kind ?? ''),
    }))
    .filter((item) => Boolean(item.path) && item.line > 0 && Boolean(item.kind))
}

export function hydrateCloudMessage(raw: unknown, now = Date.now()): CloudChatRow {
  const obj = asRecord(raw) ?? {}
  return {
    id: String(obj.id ?? fallbackMessageId(now)),
    role: obj.role === 'user' ? 'user' : 'assistant',
    text: String(obj.text ?? ''),
    at: Number(obj.at ?? now),
    streaming: Boolean(obj.streaming),
    ...(typeof obj.thinking === 'string' && obj.thinking ? { thinking: obj.thinking } : {}),
    ...(obj.thinkingRedacted ? { thinkingRedacted: true } : {}),
    ...(typeof obj.thinkingDurationMs === 'number'
      ? { thinkingDurationMs: obj.thinkingDurationMs }
      : {}),
    traces: Array.isArray(obj.traces)
      ? obj.traces.map((item) => {
          const trace = asRecord(item) ?? {}
          return {
            id: String(trace.id ?? ''),
            toolName: String(trace.toolName ?? 'tool'),
            summary: String(trace.summary ?? ''),
            status:
              trace.status === 'error'
                ? 'error'
                : trace.status === 'running'
                  ? 'running'
                  : 'ok',
            ...(typeof trace.durationMs === 'number' ? { durationMs: trace.durationMs } : {}),
            ...(typeof trace.resultPreview === 'string'
              ? { resultPreview: trace.resultPreview }
              : {}),
          }
        })
      : [],
    error: typeof obj.error === 'string' ? obj.error : undefined,
  }
}

/** 兼容服务端原始 CloudTaskSnapshot（spec/progress）与已规整的 CloudTaskRow */
export function normalizeCloudTask(raw: unknown, now = Date.now()): CloudTaskRow | null {
  const obj = asRecord(raw)
  if (!obj) return null
  const id = String(obj.id ?? '')
  if (!id) return null
  const spec = asRecord(obj.spec) ?? {}
  const specRepo = asRecord(spec.repo) ?? {}
  const resultObj = asRecord(obj.result)
  const progressObj = asRecord(obj.progress)
  const questionObj = asRecord(obj.question)
  const changedFiles = normalizeCloudChangedFiles(
    obj.changedFiles ?? resultObj?.changedFiles ?? progressObj?.changedFiles
  )
  const secretHits = normalizeCloudSecretHits(
    obj.secretHits ?? resultObj?.secretHits ?? progressObj?.secretHits
  )
  const summary =
    resultObj?.summary ?? (obj.status === 'done' ? progressObj?.summary : undefined)
  const question =
    questionObj && typeof questionObj.text === 'string'
      ? {
          id: String(questionObj.id ?? ''),
          text: String(questionObj.text),
          at: Number(questionObj.at ?? now),
        }
      : undefined
  return {
    id,
    title: String(spec.title ?? obj.title ?? '(未命名工单)'),
    deviceId: String(spec.deviceId ?? specRepo.deviceId ?? obj.deviceId ?? ''),
    workspacePath: String(specRepo.workspacePath ?? obj.workspacePath ?? ''),
    workUnitId: String(spec.workUnitId ?? obj.workUnitId ?? ''),
    status: String(obj.status ?? 'queued') as CloudTaskStatusName,
    createdAt: Number(obj.createdAt ?? now),
    updatedAt: Number(obj.updatedAt ?? now),
    startedAt: typeof obj.startedAt === 'number' ? obj.startedAt : undefined,
    finishedAt: typeof obj.finishedAt === 'number' ? obj.finishedAt : undefined,
    terminalReason: typeof obj.terminalReason === 'string' ? obj.terminalReason : undefined,
    lastMilestone:
      typeof progressObj?.summary === 'string'
        ? progressObj.summary
        : typeof obj.lastMilestone === 'string'
          ? obj.lastMilestone
          : undefined,
    question,
    worktreePath: typeof obj.worktreePath === 'string' ? obj.worktreePath : undefined,
    branch:
      typeof progressObj?.branch === 'string'
        ? progressObj.branch
        : typeof obj.branch === 'string'
          ? obj.branch
          : undefined,
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(secretHits.length > 0 ? { secretHits } : {}),
    result:
      summary || changedFiles.length > 0 || secretHits.length > 0
        ? {
            summary: String(summary ?? ''),
            changedFiles,
            ...(secretHits.length > 0 ? { secretHits } : {}),
          }
        : undefined,
    error: typeof obj.error === 'string' ? obj.error : undefined,
  }
}

export function normalizeCloudDevice(raw: unknown): CloudDeviceRow | null {
  const obj = asRecord(raw)
  if (!obj) return null
  const id = String(obj.id ?? '')
  if (!id) return null
  return {
    id,
    name: String(obj.name ?? id),
    platform: String(obj.platform ?? ''),
    online: Boolean(obj.online),
    workspaces: Array.isArray(obj.workspaces)
      ? (obj.workspaces as CloudDeviceRow['workspaces'])
      : [],
    lastSeenAt: typeof obj.lastSeenAt === 'number' ? obj.lastSeenAt : undefined,
  }
}

export function normalizeCloudUnit(raw: unknown, now = Date.now()): CloudUnitRow | null {
  const obj = asRecord(raw)
  if (!obj) return null
  const unitId = String(obj.unitId ?? '')
  if (!unitId) return null
  return {
    unitId,
    deviceId: String(obj.deviceId ?? ''),
    workspacePath: String(obj.workspacePath ?? ''),
    worktreePath: typeof obj.worktreePath === 'string' ? obj.worktreePath : undefined,
    branch: typeof obj.branch === 'string' ? obj.branch : undefined,
    createdAt: Number(obj.createdAt ?? now),
    closedAt: typeof obj.closedAt === 'number' ? obj.closedAt : null,
    closeRequestedAt: typeof obj.closeRequestedAt === 'number' ? obj.closeRequestedAt : undefined,
    dirtyAt: typeof obj.dirtyAt === 'number' ? obj.dirtyAt : undefined,
  }
}

export function normalizeCloudAuthorization(raw: unknown): CloudAuthorizationRow | null {
  const obj = asRecord(raw)
  if (!obj) return null
  const id = String(obj.id ?? '')
  if (!id) return null
  return {
    id,
    items: Array.isArray(obj.items) ? (obj.items as CloudAuthorizationRow['items']) : [],
    quota: Number(obj.quota ?? 0),
    used: Number(obj.used ?? 0),
    confirmedAt: Number(obj.confirmedAt ?? 0),
    expiresAt: Number(obj.expiresAt ?? 0),
    confirmedSummary: String(obj.confirmedSummary ?? ''),
  }
}

function normalizeAgentStatus(raw: unknown): CloudAgentStatusName {
  if (raw === 'thinking' || raw === 'replying' || raw === 'error') return raw
  return 'idle'
}

export interface ApplyCloudFrameOptions {
  /** 桌面端乐观发送 `c-...` 用户消息后，收到服务端回显 `u-c-...` 时原地替换 id 去重 */
  matchOptimisticUserEcho?: boolean
  /** 收到未读价值事件时直接递增 unreadCount（桌面端默认 true；Web 端按当前 tab/可见性自行决定） */
  incrementUnreadOnEvents?: boolean
  now?: number
}

export interface ApplyCloudFrameResult {
  state: CloudSessionState
  unreadWorthy: boolean
  snapshotUnread: boolean
  frameError?: string
}

export function applyCloudFrame(
  prev: CloudSessionState,
  raw: unknown,
  options: ApplyCloudFrameOptions = {}
): ApplyCloudFrameResult {
  const frame = asRecord(raw)
  if (!frame || frame.v !== CLOUD_PROTOCOL_VERSION) {
    return { state: prev, unreadWorthy: false, snapshotUnread: false }
  }

  const now = options.now ?? Date.now()
  const incrementUnread = options.incrementUnreadOnEvents ?? false

  if (frame.type === 'snapshot') {
    const snap = asRecord(frame.snapshot) ?? {}
    const away = asRecord(snap.awaySummary)
    const cloudMeta = asRecord(snap.cloud)
    // 服务重启后 seq 可能归零重计：snapshot 必须重置游标，不能只取 max
    const nextSeq = Number(frame.seq ?? snap.lastSeq ?? 0)
    const unreadCount = Number(snap.unreadCount ?? 0)
    const awaySummary: CloudAwaySummaryRow | null =
      away && typeof away.text === 'string'
        ? {
            since: Number(away.since ?? 0),
            until: Number(away.until ?? 0),
            text: String(away.text),
            items: Array.isArray(away.items)
              ? (away.items as CloudAwaySummaryRow['items'])
              : [],
          }
        : null
    const next: CloudSessionState = {
      ...prev,
      lastSeq: nextSeq,
      messages: Array.isArray(snap.messages)
        ? snap.messages.map((item: unknown) => hydrateCloudMessage(item, now))
        : [],
      tasks: Array.isArray(snap.tasks)
        ? snap.tasks
            .map((item: unknown) => normalizeCloudTask(item, now))
            .filter((row: CloudTaskRow | null): row is CloudTaskRow => row !== null)
        : [],
      devices: Array.isArray(snap.devices)
        ? snap.devices
            .map((item: unknown) => normalizeCloudDevice(item))
            .filter((row: CloudDeviceRow | null): row is CloudDeviceRow => row !== null)
        : [],
      units: Array.isArray(snap.units)
        ? snap.units
            .map((item: unknown) => normalizeCloudUnit(item, now))
            .filter((row: CloudUnitRow | null): row is CloudUnitRow => row !== null)
        : [],
      authorizations: Array.isArray(snap.authorizations)
        ? snap.authorizations
            .map((item: unknown) => normalizeCloudAuthorization(item))
            .filter(
              (row: CloudAuthorizationRow | null): row is CloudAuthorizationRow => row !== null
            )
        : [],
      awaySummary,
      lastReadSeq: Number(snap.lastReadSeq ?? 0),
      unreadCount,
      stoppingTaskIds: {},
      agentStatus: normalizeAgentStatus(cloudMeta?.status),
      canStopReply: Boolean(cloudMeta?.canStopReply),
    }
    return { state: next, unreadWorthy: false, snapshotUnread: unreadCount > 0 }
  }

  const nextSeq =
    typeof frame.seq === 'number' && frame.seq > prev.lastSeq ? frame.seq : prev.lastSeq

  if (frame.type === 'error') {
    const message = String(frame.message || 'cloud error')
    const notices: CloudNotice[] = [
      { level: 'error' as const, text: message, at: now },
      ...prev.notices,
    ].slice(0, 20)
    return {
      state: { ...prev, lastSeq: nextSeq, notices },
      unreadWorthy: false,
      snapshotUnread: false,
      frameError: message,
    }
  }

  if (frame.type !== 'event') {
    return {
      state: nextSeq === prev.lastSeq ? prev : { ...prev, lastSeq: nextSeq },
      unreadWorthy: false,
      snapshotUnread: false,
    }
  }

  const event = asRecord(frame.event) ?? {}
  const base = nextSeq === prev.lastSeq ? prev : { ...prev, lastSeq: nextSeq }

  switch (event.type) {
    case 'message': {
      const msg = event.message
      if (!msg) return { state: base, unreadWorthy: false, snapshotUnread: false }
      const hydrated = hydrateCloudMessage(msg, now)
      const index = base.messages.findIndex((row) => row.id === hydrated.id)
      const messages = base.messages.slice()
      if (index >= 0) messages[index] = { ...messages[index], ...hydrated }
      else messages.push(hydrated)
      return {
        state: { ...base, messages: messages.slice(-400) },
        unreadWorthy: false,
        snapshotUnread: false,
      }
    }
    case 'message_start': {
      const id = String(event.messageId || fallbackMessageId(now))
      if (base.messages.some((row) => row.id === id)) {
        return { state: base, unreadWorthy: false, snapshotUnread: false }
      }
      const isUser = event.role === 'user'
      const messages = base.messages.slice()
      if (isUser && options.matchOptimisticUserEcho && id.startsWith(USER_ECHO_PREFIX)) {
        const localId = id.slice(USER_ECHO_PREFIX.length)
        const idx = messages.findIndex((row) => row.id === localId)
        if (idx >= 0) {
          messages[idx] = { ...messages[idx], id }
          return { state: { ...base, messages }, unreadWorthy: false, snapshotUnread: false }
        }
      }
      if (!isUser) {
        // 工具先于正文到达时会先建一条 pendingTrace 占位行；正文开始时原地复用，避免出现双气泡与永久 streaming
        const lastIndex = messages.length - 1
        const last = messages[lastIndex]
        if (last && last.role === 'assistant' && last.pendingTrace && !last.text) {
          messages[lastIndex] = {
            ...last,
            id,
            at: Number(event.at ?? last.at),
            streaming: true,
            pendingTrace: false,
          }
          return { state: { ...base, messages }, unreadWorthy: false, snapshotUnread: false }
        }
      }
      messages.push({
        id,
        role: isUser ? 'user' : 'assistant',
        text: '',
        at: Number(event.at ?? now),
        streaming: !isUser,
        traces: [],
      })
      return {
        state: { ...base, messages: messages.slice(-400) },
        unreadWorthy: false,
        snapshotUnread: false,
      }
    }
    case 'text_delta': {
      const delta = String(event.delta ?? '')
      if (!delta) return { state: base, unreadWorthy: false, snapshotUnread: false }
      const messages = base.messages.slice()
      const targetId = String(event.messageId ?? '')
      // 流式期间用户插话会把 user 气泡插在末尾；优先按 messageId 匹配避免复制同 id 气泡
      let targetIndex = -1
      if (targetId) {
        for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
          if (messages[idx].id === targetId) {
            targetIndex = idx
            break
          }
        }
      }
      if (targetIndex < 0) {
        const last = messages[messages.length - 1]
        if (last && last.role === 'assistant' && last.streaming) {
          targetIndex = messages.length - 1
        }
      }
      if (targetIndex >= 0) {
        const target = messages[targetIndex]
        const thinkingDurationMs =
          target.thinkingStartedAt && target.thinkingDurationMs === undefined
            ? Math.max(0, now - target.thinkingStartedAt)
            : target.thinkingDurationMs
        messages[targetIndex] = {
          ...target,
          text: target.text + delta,
          streaming: true,
          pendingTrace: false,
          thinkingStartedAt: undefined,
          ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
        }
      } else {
        messages.push({
          id: targetId || fallbackMessageId(now),
          role: 'assistant',
          text: delta,
          at: now,
          streaming: true,
          traces: [],
        })
      }
      return {
        state: { ...base, messages: messages.slice(-400) },
        unreadWorthy: false,
        snapshotUnread: false,
      }
    }
    case 'message_end': {
      const targetId = String(event.messageId ?? '')
      const messages = base.messages.slice()
      const finalize = (row: CloudChatRow): CloudChatRow => {
        const thinkingDurationMs =
          row.thinkingStartedAt && row.thinkingDurationMs === undefined
            ? Math.max(0, now - row.thinkingStartedAt)
            : row.thinkingDurationMs
        return {
          ...row,
          text: event.text !== undefined ? String(event.text) : row.text,
          streaming: false,
          pendingTrace: false,
          thinkingStartedAt: undefined,
          ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
          error: typeof event.error === 'string' ? event.error : undefined,
        }
      }
      let idx = targetId ? messages.findIndex((item) => item.id === targetId) : -1
      if (idx < 0) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i].role === 'assistant' && messages[i].streaming) {
            idx = i
            break
          }
        }
      }
      if (idx >= 0) messages[idx] = finalize(messages[idx])
      const unreadWorthy =
        !targetId.startsWith(USER_ECHO_PREFIX) && String(event.text ?? '').trim().length > 0
      return {
        state: {
          ...base,
          messages,
          unreadCount: incrementUnread && unreadWorthy ? base.unreadCount + 1 : base.unreadCount,
        },
        unreadWorthy,
        snapshotUnread: false,
      }
    }
    case 'trace': {
      const trace = asRecord(event.trace) ?? {}
      const traceType = String(trace.type ?? '')
      if (
        traceType !== 'thinking_delta' &&
        traceType !== 'thinking_redacted' &&
        traceType !== 'tool_start' &&
        traceType !== 'tool_update' &&
        traceType !== 'tool_end'
      ) {
        return { state: base, unreadWorthy: false, snapshotUnread: false }
      }
      const messages = base.messages.slice()
      const targetId = String(event.messageId ?? '')
      let rowIndex = -1
      if (targetId) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i].id === targetId) {
            rowIndex = i
            break
          }
        }
      }
      if (rowIndex < 0) {
        const last = messages[messages.length - 1]
        if (last && last.role === 'assistant' && last.streaming) {
          rowIndex = messages.length - 1
        }
      }
      const row: CloudChatRow =
        rowIndex >= 0
          ? messages[rowIndex]
          : {
              id: targetId || fallbackMessageId(now),
              role: 'assistant',
              text: '',
              at: now,
              streaming: true,
              pendingTrace: !targetId,
              traces: [],
            }
      let updated: CloudChatRow = row
      if (traceType === 'thinking_delta') {
        const delta = String(trace.delta ?? '')
        if (!delta) return { state: base, unreadWorthy: false, snapshotUnread: false }
        updated = {
          ...row,
          thinking: (row.thinking ?? '') + delta,
          thinkingStartedAt: row.thinkingStartedAt ?? now,
        }
      } else if (traceType === 'thinking_redacted') {
        updated = { ...row, thinkingRedacted: true }
      } else {
        const traces: CloudTraceRow[] = row.traces.slice()
        const id = String(trace.toolCallId ?? '')
        const index = traces.findIndex((item) => item.id === id)
        const closedDuration =
          row.thinkingStartedAt && row.thinkingDurationMs === undefined
            ? Math.max(0, now - row.thinkingStartedAt)
            : row.thinkingDurationMs
        if (traceType === 'tool_start') {
          const nextTrace: CloudTraceRow = {
            id,
            toolName: String(trace.toolName ?? 'tool'),
            summary: String(trace.argsSummary ?? ''),
            status: 'running',
          }
          if (index >= 0) traces[index] = nextTrace
          else traces.push(nextTrace)
        } else if (traceType === 'tool_update' && index >= 0) {
          traces[index] = {
            ...traces[index],
            resultPreview:
              typeof trace.resultPreview === 'string'
                ? trace.resultPreview
                : traces[index].resultPreview,
          }
        } else if (traceType === 'tool_end' && index >= 0) {
          traces[index] = {
            ...traces[index],
            status: trace.status === 'error' ? 'error' : 'ok',
            summary: String(trace.resultPreview ?? traces[index].summary),
            ...(typeof trace.durationMs === 'number' ? { durationMs: trace.durationMs } : {}),
            ...(typeof trace.resultPreview === 'string'
              ? { resultPreview: trace.resultPreview }
              : {}),
          }
        }
        updated = {
          ...row,
          thinkingStartedAt: undefined,
          ...(closedDuration !== undefined ? { thinkingDurationMs: closedDuration } : {}),
          traces: traces.slice(-30),
        }
      }
      if (rowIndex >= 0) messages[rowIndex] = updated
      else messages.push(updated)
      return {
        state: { ...base, messages: messages.slice(-400) },
        unreadWorthy: false,
        snapshotUnread: false,
      }
    }
    case 'cloud_status': {
      const status = normalizeAgentStatus(event.status)
      return {
        state: {
          ...base,
          agentStatus: status,
          canStopReply: status === 'thinking' || status === 'replying',
        },
        unreadWorthy: false,
        snapshotUnread: false,
      }
    }
    case 'task': {
      const task = normalizeCloudTask(event.task, now)
      if (!task) return { state: base, unreadWorthy: false, snapshotUnread: false }
      const tasks = base.tasks.slice()
      const idx = tasks.findIndex((item) => item.id === task.id)
      const prevStatus = idx >= 0 ? tasks[idx].status : null
      if (idx >= 0) tasks[idx] = task
      else tasks.unshift(task)
      let stoppingTaskIds = base.stoppingTaskIds
      if (!isCloudTaskActiveStatus(task.status) && stoppingTaskIds[task.id]) {
        stoppingTaskIds = { ...stoppingTaskIds }
        delete stoppingTaskIds[task.id]
      }
      const unreadWorthy =
        prevStatus !== task.status &&
        (task.status === 'waiting_human' || !isCloudTaskActiveStatus(task.status))
      return {
        state: {
          ...base,
          tasks: tasks.slice(0, 200),
          stoppingTaskIds,
          unreadCount: incrementUnread && unreadWorthy ? base.unreadCount + 1 : base.unreadCount,
        },
        unreadWorthy,
        snapshotUnread: false,
      }
    }
    case 'device': {
      const device = normalizeCloudDevice(event.device)
      if (!device) return { state: base, unreadWorthy: false, snapshotUnread: false }
      const devices = base.devices.slice()
      const idx = devices.findIndex((item) => item.id === device.id)
      if (idx >= 0) devices[idx] = device
      else devices.push(device)
      return { state: { ...base, devices }, unreadWorthy: false, snapshotUnread: false }
    }
    case 'unit': {
      const unit = normalizeCloudUnit(event.unit, now)
      if (!unit) return { state: base, unreadWorthy: false, snapshotUnread: false }
      const units = base.units.slice()
      const idx = units.findIndex((item) => item.unitId === unit.unitId)
      if (idx >= 0) units[idx] = unit
      else units.unshift(unit)
      return {
        state: { ...base, units: units.slice(0, 200) },
        unreadWorthy: false,
        snapshotUnread: false,
      }
    }
    case 'notice': {
      const key = typeof event.key === 'string' ? event.key : undefined
      const notice: CloudNotice = {
        level: event.level === 'error' || event.level === 'warn' ? event.level : 'info',
        text: String(event.text ?? ''),
        at: Number(event.at ?? now),
        key,
      }
      const notices = key
        ? [notice, ...base.notices.filter((item) => item.key !== key)].slice(0, 20)
        : [notice, ...base.notices].slice(0, 20)
      return { state: { ...base, notices }, unreadWorthy: false, snapshotUnread: false }
    }
    case 'read_state': {
      const unreadCount = Number(event.unreadCount ?? 0)
      const reportedReadSeq = Number(event.lastReadSeq ?? base.lastReadSeq)
      const nextLastReadSeq =
        unreadCount === 0 && typeof frame.seq === 'number'
          ? Math.max(reportedReadSeq, frame.seq)
          : reportedReadSeq
      return {
        state: { ...base, lastReadSeq: nextLastReadSeq, unreadCount },
        unreadWorthy: false,
        snapshotUnread: false,
      }
    }
    default:
      return { state: base, unreadWorthy: false, snapshotUnread: false }
  }
}
