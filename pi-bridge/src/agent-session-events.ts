/**
 * 会话流式事件投影器：从 `AgentManager` 拆出的独立子系统。
 *
 * 负责订阅 Pi SDK 的 `session.subscribe()`，将模型增量、按 `contentIndex` 隔离的思考计时、
 * 工具起止与文件 Diff 快照、自动重试、上下文压缩及轮次收敛事件分发给 `runtime.onTrace`。
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { entryTimestamp } from './session-entries.js'
import { summarizeToolArgs, summarizeToolResult } from './text-utils.js'
import { StallWatchdog } from './stall-watchdog.js'
import type { AgentLogger } from './types.js'
import {
  MAX_EDIT_SNAPSHOT_BYTES,
  STALL_TIMEOUT_MS,
  isInsideWorkspace,
  resolveToolFilePath,
  resolveToolPath,
  type SessionRuntime,
} from './agent-runtime-types.js'

export interface SessionEventsDeps {
  getLogger: () => AgentLogger
  getWorkspaceDir: () => string | undefined
  persistExtras: (runtime: SessionRuntime) => void
  onAgentSettled: (runtime: SessionRuntime) => void
}

/** 成功压缩后从当前活跃分支取回本次落盘的 compaction entry（只扫 getBranch，避免命中废弃分支） */
export function resolveCompactionEntry(runtime: SessionRuntime, logger: AgentLogger): any | null {
  try {
    const entries = (
      typeof runtime.sessionManager.getBranch === 'function'
        ? runtime.sessionManager.getBranch()
        : runtime.sessionManager.getEntries()
    ) as any[]
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry?.type !== 'compaction') continue
      if (entry.id === runtime.lastCompactionEntryId) return null
      runtime.lastCompactionEntryId = entry.id
      runtime.lastCompactionEntry = {
        id: entry.id,
        timestamp: entryTimestamp(entry.timestamp),
        tokensBefore: typeof entry.tokensBefore === 'number' ? entry.tokensBefore : undefined,
      }
      return entry
    }
  } catch (error) {
    logger.warn('[Agent Manager] Failed to resolve compaction entry:', error)
  }
  return null
}

export function subscribeSessionEvents(
  runtime: SessionRuntime,
  deps: SessionEventsDeps
): () => void {
  return runtime.session.subscribe((event: any) => {
    const logger = deps.getLogger()
    try {
      if (event.type === 'message_start' && event.message?.role === 'assistant') {
        runtime.watchdog?.touch()
        runtime.thinkingDeltaSeen.clear()
        runtime.thinkingStarts.clear()
        runtime.thinkingDurationsThisMessage = []
        return
      }

      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const timestamp = event.message?.timestamp
        if (typeof timestamp === 'number' && runtime.thinkingDurationsThisMessage.length > 0) {
          runtime.extras.thinkingDurations[String(timestamp)] = [
            ...runtime.thinkingDurationsThisMessage,
          ]
          deps.persistExtras(runtime)
        }
        return
      }

      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent
        if (update?.type === 'text_delta' && typeof update.delta === 'string') {
          runtime.watchdog?.touch()
          // Gemini 等供应商会在 toolUse 末尾附带空串 delta，不得透传以免切碎过程轨迹
          if (update.delta.length > 0) {
            runtime.onTextDelta?.(update.delta)
            runtime.onTrace?.({ type: 'text_delta', delta: update.delta })
          }
        } else if (update?.type === 'thinking_start') {
          const index = typeof update.contentIndex === 'number' ? update.contentIndex : -1
          runtime.thinkingDeltaSeen.delete(index)
          runtime.thinkingStarts.set(index, Date.now())
        } else if (update?.type === 'thinking_delta' && typeof update.delta === 'string') {
          runtime.watchdog?.touch()
          const index = typeof update.contentIndex === 'number' ? update.contentIndex : -1
          runtime.thinkingDeltaSeen.add(index)
          if (!runtime.thinkingStarts.has(index)) {
            runtime.thinkingStarts.set(index, Date.now())
          }
          runtime.onTrace?.({ type: 'thinking_delta', delta: update.delta })
        } else if (update?.type === 'thinking_end') {
          const index = typeof update.contentIndex === 'number' ? update.contentIndex : -1
          const startedAt = runtime.thinkingStarts.get(index)
          if (startedAt !== undefined) {
            runtime.thinkingDurationsThisMessage.push(Math.max(0, Date.now() - startedAt))
            runtime.thinkingStarts.delete(index)
          }
          // 部分供应商只在 end 给出完整内容，或返回脱敏后的空内容
          if (!runtime.thinkingDeltaSeen.has(index)) {
            const content = typeof update.content === 'string' ? update.content : ''
            if (content) runtime.onTrace?.({ type: 'thinking_delta', delta: content })
            else runtime.onTrace?.({ type: 'thinking_redacted' })
          }
        } else if (update?.type === 'toolcall_start' || update?.type === 'toolcall_delta') {
          // 工具参数 JSON 增量：写大文件时可能持续几十秒，属于模型仍在产出
          runtime.watchdog?.touch()
        }
        return
      }

      if (event.type === 'auto_retry_start') {
        runtime.watchdog?.touch()
        logger.warn(
          `[Agent Manager] Provider retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms: ${event.errorMessage ?? ''}`
        )
        runtime.onTrace?.({
          type: 'retry_start',
          attempt: Number(event.attempt) || 0,
          maxAttempts: Number(event.maxAttempts) || 0,
          delayMs: Number(event.delayMs) || 0,
          message: typeof event.errorMessage === 'string' ? event.errorMessage : undefined,
        })
        return
      }
      if (event.type === 'auto_retry_end') {
        runtime.watchdog?.touch()
        logger.info(`[Agent Manager] Auto retry ${event.success ? 'succeeded' : 'failed'}`)
        runtime.onTrace?.({ type: 'retry_end', success: Boolean(event.success) })
        return
      }

      if (event.type === 'compaction_start') {
        runtime.watchdog?.beginCompaction()
        runtime.onTrace?.({ type: 'compaction_start', reason: event.reason })
        return
      }
      if (event.type === 'compaction_end') {
        runtime.watchdog?.endCompaction()
        const error = typeof event.errorMessage === 'string' ? event.errorMessage : undefined
        const aborted = Boolean((event as any).aborted)
        const entry = error || aborted ? null : resolveCompactionEntry(runtime, logger)
        runtime.onTrace?.({
          type: 'compaction_end',
          reason: event.reason,
          tokensBefore:
            typeof event.result?.tokensBefore === 'number'
              ? event.result.tokensBefore
              : typeof entry?.tokensBefore === 'number'
                ? entry.tokensBefore
                : undefined,
          error,
          aborted: aborted || undefined,
          willRetry: typeof (event as any).willRetry === 'boolean' ? (event as any).willRetry : undefined,
          entryId: entry?.id,
          timestamp: entry ? entryTimestamp(entry.timestamp) : undefined,
        })
        return
      }

      if (event.type === 'agent_start') {
        runtime.sdkStreaming = true
        if (!runtime.watchdog) {
          const bgWatchdog = new StallWatchdog({
            timeoutMs: STALL_TIMEOUT_MS,
            logger,
            onStall: (idleMs) => {
              logger.warn(
                `[Agent Manager] Event-triggered turn stalled for ${Math.round(idleMs / 1000)}s; aborting session ${runtime.id}`
              )
              void runtime.session.abort().catch((error) => {
                logger.warn('[Agent Manager] Failed to abort stalled background turn:', error)
              })
            },
          })
          runtime.bgWatchdog = bgWatchdog
          runtime.watchdog = bgWatchdog
          bgWatchdog.start()
        }
        return
      }

      if (event.type === 'agent_settled') {
        runtime.sdkStreaming = false
        if (runtime.bgWatchdog) {
          runtime.bgWatchdog.stop()
          if (runtime.watchdog === runtime.bgWatchdog) runtime.watchdog = null
          runtime.bgWatchdog = null
        }
        deps.onAgentSettled(runtime)
        return
      }

      if (event.type === 'turn_end' || event.type === 'agent_end') {
        runtime.watchdog?.resetTools()
        // 自动重试期间（willRetry === true）本轮尚未收敛，必须保持 sdkStreaming 与后台看门狗存活，
        // 待 agent_settled 或非重试终态 agent_end 再释放。
        if (event.type === 'agent_end' && event.willRetry !== true) {
          runtime.sdkStreaming = false
          if (runtime.bgWatchdog) {
            runtime.bgWatchdog.stop()
            if (runtime.watchdog === runtime.bgWatchdog) runtime.watchdog = null
            runtime.bgWatchdog = null
          }
        }
        runtime.editSnapshots.clear()
        runtime.toolFiles.clear()
        runtime.thinkingDeltaSeen.clear()
        runtime.thinkingStarts.clear()
        return
      }

      if (event.type === 'tool_execution_start') {
        runtime.watchdog?.beginTool(event.toolCallId)
        const args = event.args ?? {}
        const root = runtime.sessionManager.getCwd()
        const fallbackRoot = deps.getWorkspaceDir()
        const filePath = resolveToolFilePath(event.toolName, args, root, fallbackRoot)
        if (filePath) runtime.toolFiles.set(event.toolCallId, filePath)
        runtime.onTrace?.({
          type: 'tool_start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          argsSummary: summarizeToolArgs(event.toolName, args),
          startedAt: Date.now(),
          parentToolCallId: event.parentToolCallId,
        })

        if (event.toolName !== 'write' && event.toolName !== 'edit') return
        const target = resolveToolPath(args.path, root, fallbackRoot)
        if (!target || !isInsideWorkspace(target, root, fallbackRoot)) return
        const existed = existsSync(target)
        let oldContent = ''
        if (existed) {
          try {
            if (statSync(target).size > MAX_EDIT_SNAPSHOT_BYTES) return
            oldContent = readFileSync(target, 'utf-8')
          } catch {
            return
          }
        }
        runtime.editSnapshots.set(event.toolCallId, { path: target, oldContent, existed })
        return
      }

      if (event.type === 'tool_execution_update') {
        runtime.watchdog?.touch()
        const preview = summarizeToolResult(
          event.partialResult,
          event.toolName === 'bash' || event.toolName === 'powershell'
        )
        if (preview) {
          runtime.onTrace?.({
            type: 'tool_update',
            toolCallId: event.toolCallId,
            resultPreview: preview,
            parentToolCallId: event.parentToolCallId,
          })
        }
        return
      }

      if (event.type === 'tool_execution_end') {
        runtime.watchdog?.endTool(event.toolCallId)
        const snapshot = runtime.editSnapshots.get(event.toolCallId)
        const filePath = snapshot?.path ?? runtime.toolFiles.get(event.toolCallId)
        runtime.editSnapshots.delete(event.toolCallId)
        runtime.toolFiles.delete(event.toolCallId)

        if (snapshot) {
          let newContent = ''
          let readable = true
          if (existsSync(snapshot.path)) {
            try {
              if (statSync(snapshot.path).size > MAX_EDIT_SNAPSHOT_BYTES) {
                readable = false
              } else {
                newContent = readFileSync(snapshot.path, 'utf-8')
              }
            } catch {
              readable = false
            }
          }
          if (readable && newContent !== snapshot.oldContent) {
            runtime.pendingEdits.push({
              path: snapshot.path,
              oldContent: snapshot.oldContent,
              newContent,
              toolCallId: event.toolCallId,
            })
          }
        }

        runtime.onTrace?.({
          type: 'tool_end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: event.isError ? 'error' : 'success',
          durationMs: event.durationMs,
          resultPreview: summarizeToolResult(
            event.result,
            event.toolName === 'bash' || event.toolName === 'powershell'
          ),
          filePath,
          parentToolCallId: event.parentToolCallId,
        })
      }
    } catch (error) {
      logger.warn('[Agent Manager] Failed to process session event:', error)
    }
  })
}
