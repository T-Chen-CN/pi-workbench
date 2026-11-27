/**
 * 会话仓储（SessionRepository）：统一负责会话文件发现、元信息与首行 header 读取、
 * 会话列表汇总、删除、导出（Markdown / HTML / JSON / JSONL 路径）、工具结果读取与分页、
 * 会话附加数据（extras）以及工作区打开标签的持久化。
 */

import { SessionManager } from '@earendil-works/pi-coding-agent'
import * as fs from 'fs/promises'
import { existsSync } from 'fs'
import * as path from 'path'
import { readJsonAsyncWithBackup, writeJsonAtomicAsync } from './atomic-json.js'
import { buildExportTurns } from './agent-projections.js'
import {
  normalizePathForCompare,
  resolveToolFilePath,
  type SessionRuntime,
} from './agent-runtime-types.js'
import { activeTimeline } from './session-entries.js'
import {
  buildHtmlExport,
  buildMarkdownExport,
  type ExportLanguage,
  type ExportTurn,
} from './session-export.js'
import {
  emptyExtras,
  isSafeSessionId,
  type SessionExtras,
  type SessionExtrasLoadResult,
  type SessionExtrasStore,
} from './session-extras.js'
import { deriveMessages } from './session-view.js'
import { stripContextBlock } from './text-utils.js'
import {
  describeToolResult,
  findToolResultPayload,
  readToolResultChunk as sliceToolResult,
  type ToolResultPayload,
} from './tool-results.js'
import type {
  AgentConfig,
  AgentLogger,
  AgentMessage,
  SessionSummary,
  ToolResultMeta,
} from './types.js'

export interface OpenTabsState {
  open: string[]
  active: string | null
}

export interface SessionRepositoryDeps {
  getConfig: () => AgentConfig | null
  getSessionDir: () => string
  getExtrasStore: () => SessionExtrasStore | null
  getLogger: () => AgentLogger
  getSettledTitle?: (sessionId: string) => string | undefined
}

/** 读取会话文件首行 header 的 cwd（仅读前 16KB，避免扫描整份 JSONL 正文） */
export async function readSessionHeaderInfo(
  filePath: string
): Promise<{ exists: false } | { exists: true; cwd?: string }> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(filePath, 'r')
    const buffer = Buffer.alloc(16 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead === 0) return { exists: true }
    const chunk = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = chunk.indexOf('\n')
    const firstLine = (newline >= 0 ? chunk.slice(0, newline) : chunk).trim()
    if (!firstLine) return { exists: true }
    const parsed = JSON.parse(firstLine) as { type?: unknown; cwd?: unknown }
    if (parsed && typeof parsed === 'object' && parsed.type === 'session') {
      return {
        exists: true,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
      }
    }
    return { exists: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { exists: false }
    }
    return { exists: true }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export class SessionRepository {
  constructor(private readonly deps: SessionRepositoryDeps) {}

  /** 校验会话记录的 cwd 是否归属当前工作区（Windows 大小写不敏感） */
  sessionBelongsToWorkspace(sessionId: string, cwd: string | undefined | null): boolean {
    const config = this.deps.getConfig()
    if (!config) return false
    if (config.isSessionOfWorkspace) {
      return config.isSessionOfWorkspace(sessionId, cwd ?? '')
    }
    const workspaceRoot = normalizePathForCompare(config.workspaceDir)
    const infoCwd = cwd ? normalizePathForCompare(cwd) : workspaceRoot
    return infoCwd === workspaceRoot
  }

  /**
   * 会话文件按 id 查找，同时强制校验归属当前工作区（防跨工作区打开/改名/删除共享 sessionDir 下的他人会话）。
   * 优先走 O(1) 仅读首行 header 的 `SessionManager.findById`，避免每次打开/重命名/删除都全量扫盘读取所有 `.jsonl`；
   * 仅当按已知工作区根未命中（例如历史链接工作树已解绑）时才回退 `SessionManager.listAll`。
   */
  async findSessionFile(sessionId: string, preferredRoot?: string): Promise<string | null> {
    const config = this.deps.getConfig()
    if (!config) return null
    const sessionDir = this.deps.getSessionDir()
    try {
      const resolvedRoot =
        preferredRoot ?? config.resolveSessionRoot?.(sessionId) ?? config.workspaceDir
      const candidateRoots = [resolvedRoot]
      if (normalizePathForCompare(resolvedRoot) !== normalizePathForCompare(config.workspaceDir)) {
        candidateRoots.push(config.workspaceDir)
      }

      if (typeof SessionManager.findById === 'function') {
        for (const candidateRoot of candidateRoots) {
          const direct = SessionManager.findById(candidateRoot, sessionId, sessionDir)
          if (!direct) continue
          const header = await readSessionHeaderInfo(direct)
          const owned = header.exists
            ? this.sessionBelongsToWorkspace(sessionId, header.cwd)
            : this.sessionBelongsToWorkspace(sessionId, candidateRoot)
          return owned ? direct : null
        }
      }

      if (typeof SessionManager.listAll !== 'function') return null
      const infos = await SessionManager.listAll(sessionDir)
      const matched = infos.find((info) => info.id === sessionId)
      if (!matched) return null
      if (!this.sessionBelongsToWorkspace(matched.id, matched.cwd)) return null
      return matched.path
    } catch (error) {
      this.deps.getLogger().warn('[Agent Manager] Failed to locate session file:', error)
      return null
    }
  }

  /** 判定 sessionId 是否已落盘但明确归属其他工作区（防止删除无本地文件会话时误删他仓 extras） */
  async isForeignSessionOnDisk(sessionId: string): Promise<boolean> {
    const config = this.deps.getConfig()
    if (!config || typeof SessionManager.listAll !== 'function') return false
    try {
      const infos = await SessionManager.listAll(this.deps.getSessionDir())
      const matched = infos.find((info) => info.id === sessionId)
      if (!matched) return false
      return !this.sessionBelongsToWorkspace(matched.id, matched.cwd)
    } catch {
      return false
    }
  }

  /** 会话在磁盘上的文件；未落盘的新会话返回 null */
  async resolvePersistedSessionFile(
    sessionManager: SessionManager,
    sessionId: string
  ): Promise<string | null> {
    const file = sessionManager.getSessionFile()
    if (file && existsSync(file)) return file
    const found = await this.findSessionFile(sessionId, sessionManager.getCwd())
    return found && existsSync(found) ? found : null
  }

  /**
   * 按会话文件重建管理器。文件还不存在（新会话尚未落盘）时用原 id 在目标根重新创建：
   * 直接 open 一个不存在的路径会让 SDK 生成新的会话 id。
   */
  openManagerForRoot(sessionId: string, file: string | null, root: string): SessionManager {
    const sessionDir = this.deps.getSessionDir()
    return file
      ? SessionManager.open(file, sessionDir, root)
      : SessionManager.create(root, sessionDir, { id: sessionId })
  }

  /** 列出当前工作区的全部会话（合并内存中尚未落盘的活跃会话摘要） */
  async listSessions(liveSummaries: Iterable<SessionSummary> = []): Promise<SessionSummary[]> {
    const config = this.deps.getConfig()
    if (!config) return []
    const sessionDir = this.deps.getSessionDir()

    const sessions = new Map<string, SessionSummary>()
    try {
      let infos: any[] = []
      if (typeof SessionManager.listAll === 'function') {
        try {
          infos = await SessionManager.listAll(sessionDir)
        } catch {
          infos = []
        }
      }
      // 兼容测试/旧版 SDK：listAll 不可用或为空时退回按 cwd 过滤的 list
      if (!infos.length) {
        infos = await SessionManager.list(config.workspaceDir, sessionDir)
      }
      for (const info of infos) {
        if (!this.sessionBelongsToWorkspace(info.id, info.cwd)) continue
        sessions.set(info.id, {
          id: info.id,
          title: (
            info.name?.trim() ||
            this.deps.getSettledTitle?.(info.id)?.trim() ||
            stripContextBlock(info.firstMessage ?? '').trim()
          ).slice(0, 60),
          messageCount: info.messageCount,
          createdAt: info.created.getTime(),
          updatedAt: info.modified.getTime(),
        })
      }
    } catch (error) {
      this.deps.getLogger().warn('[Agent Manager] Failed to list sessions:', error)
    }

    for (const summary of liveSummaries) {
      const existing = sessions.get(summary.id)
      if (!existing || summary.updatedAt >= existing.updatedAt) {
        sessions.set(summary.id, summary)
      }
    }

    return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 对未加载到内存的磁盘会话写入重命名 session_info */
  async renameSessionOnDisk(
    sessionId: string,
    title: string
  ): Promise<{ success: boolean; error?: string }> {
    const config = this.deps.getConfig()
    if (!config) return { success: false, error: 'Agent not initialized.' }
    const root = config.resolveSessionRoot?.(sessionId) ?? config.workspaceDir
    const file = await this.findSessionFile(sessionId, root)
    if (!file) return { success: false, error: 'Session not found.' }
    const manager = SessionManager.open(file, this.deps.getSessionDir(), root)
    manager.appendSessionInfo(title)
    return { success: true }
  }

  /** 删除会话磁盘记录与 sidecar（强制 sessionDir 边界检查与跨工作区归属检查） */
  async deleteSessionFiles(
    sessionId: string,
    options: {
      hadLocalRuntime: boolean
      onBeforeCleanup?: () => Promise<void>
    }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const config = this.deps.getConfig()
      if (!config) return { success: false, error: 'Agent not initialized.' }
      if (!isSafeSessionId(sessionId)) return { success: false, error: 'Invalid session id.' }

      // 会话 extras 以 id 为文件名，必须先确认 id 不属于其他工作区，避免跨工作区误删
      const root = config.resolveSessionRoot?.(sessionId) ?? config.workspaceDir
      const file = await this.findSessionFile(sessionId, root)
      if (!file && !options.hadLocalRuntime && (await this.isForeignSessionOnDisk(sessionId))) {
        return { success: true }
      }

      let resolvedFile: string | null = null
      if (file) {
        resolvedFile = path.resolve(file)
        const normalizedResolved = normalizePathForCompare(resolvedFile)
        const normalizedSessionDir = normalizePathForCompare(this.deps.getSessionDir())
        const sessionDirPrefix = normalizedSessionDir.endsWith(path.sep)
          ? normalizedSessionDir
          : normalizedSessionDir + path.sep
        if (!normalizedResolved.startsWith(sessionDirPrefix)) {
          return {
            success: false,
            error: 'Refusing to delete a session outside the session directory.',
          }
        }
      }

      await options.onBeforeCleanup?.()

      // 未落盘会话也可能已写入权限/标题 sidecar，无论 file 是否存在都必须清理 extras
      await this.deleteExtras(sessionId)

      if (!resolvedFile) return { success: true }
      await fs.unlink(resolvedFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 会话附加数据（extras）与工作区打开标签持久化
  // ---------------------------------------------------------------------------

  async loadExtrasWithStatus(sessionId: string): Promise<SessionExtrasLoadResult> {
    const store = this.deps.getExtrasStore()
    if (!store) return { extras: emptyExtras(), corrupted: false }
    return store.loadWithStatus(sessionId)
  }

  async saveExtras(sessionId: string, extras: SessionExtras): Promise<void> {
    const store = this.deps.getExtrasStore()
    if (!store) return
    await store.save(sessionId, extras)
  }

  async deleteExtras(sessionId: string): Promise<void> {
    const store = this.deps.getExtrasStore()
    if (!store) return
    await store.delete(sessionId).catch((error) => {
      this.deps.getLogger().warn('[Agent Manager] Failed to delete session extras:', error)
    })
  }

  async loadOpenTabs(workspaceDir?: string): Promise<OpenTabsState> {
    const root = workspaceDir ?? this.deps.getConfig()?.workspaceDir
    if (!root) return { open: [], active: null }
    const file = path.join(root, '.pi-workbench', 'chat-tabs.json')
    const result = await readJsonAsyncWithBackup<{ open?: unknown; active?: unknown }>(file)
    if (!result.data) return { open: [], active: null }
    const open = Array.isArray(result.data.open)
      ? result.data.open.filter((id): id is string => typeof id === 'string')
      : []
    const active = typeof result.data.active === 'string' ? result.data.active : null
    return { open, active }
  }

  async saveOpenTabs(
    tabs: { open?: unknown; active?: unknown },
    workspaceDir?: string
  ): Promise<void> {
    const root = workspaceDir ?? this.deps.getConfig()?.workspaceDir
    if (!root) return
    const open = Array.isArray(tabs?.open)
      ? tabs.open.filter((id): id is string => typeof id === 'string').slice(0, 20)
      : []
    const active = typeof tabs?.active === 'string' ? tabs.active : null
    const file = path.join(root, '.pi-workbench', 'chat-tabs.json')
    await writeJsonAtomicAsync(file, { open, active })
  }

  // ---------------------------------------------------------------------------
  // 时间线投影、工具结果读取与分页、会话导出
  // ---------------------------------------------------------------------------

  timelineMessages(sessionManager: SessionManager): any[] {
    return activeTimeline(sessionManager).flatMap((item) =>
      item.kind === 'message' ? [item.message] : []
    ) as any[]
  }

  deriveSessionMessages(runtime: SessionRuntime): AgentMessage[] {
    const isLiveStreaming = Boolean(
      runtime.isProcessing || runtime.sdkStreaming || (runtime.session as any)?.isStreaming
    )
    const fallbackWorkspace = this.deps.getConfig()?.workspaceDir
    return deriveMessages(activeTimeline(runtime.sessionManager), {
      thinkingDurations: runtime.extras.thinkingDurations,
      toolFilePath: (toolName: string, args: any) =>
        resolveToolFilePath(toolName, args, runtime.sessionManager.getCwd(), fallbackWorkspace),
      isLiveStreaming,
    })
  }

  /** 按 ADR-003 从完整分支时间线查找工具结果（压缩前的历史也能读到），兼顾未落盘缓冲 */
  findToolResult(
    sessionManager: SessionManager,
    liveMessages: any[],
    toolCallId: string
  ): ToolResultPayload | null {
    return (
      findToolResultPayload(this.timelineMessages(sessionManager), toolCallId) ??
      findToolResultPayload(liveMessages, toolCallId)
    )
  }

  getToolResultMeta(
    sessionManager: SessionManager,
    liveMessages: any[],
    toolCallId: string
  ): { success: boolean; meta?: ToolResultMeta; error?: string } {
    const payload = this.findToolResult(sessionManager, liveMessages, toolCallId)
    if (!payload) return { success: false, error: 'No result recorded for this tool call.' }
    return { success: true, meta: describeToolResult(payload) }
  }

  readToolResultChunk(
    sessionManager: SessionManager,
    liveMessages: any[],
    toolCallId: string,
    offset = 0,
    limit = 65_536
  ): {
    success: boolean
    text?: string
    offset?: number
    nextOffset?: number
    chars?: number
    done?: boolean
    error?: string
  } {
    const payload = this.findToolResult(sessionManager, liveMessages, toolCallId)
    if (!payload) return { success: false, error: 'No result recorded for this tool call.' }
    return { success: true, ...sliceToolResult(payload.text, offset, limit) }
  }

  getToolResultImage(
    sessionManager: SessionManager,
    liveMessages: any[],
    toolCallId: string,
    index = 0
  ): { success: boolean; data?: string; mimeType?: string; error?: string } {
    const payload = this.findToolResult(sessionManager, liveMessages, toolCallId)
    if (!payload || payload.images.length === 0) {
      return { success: false, error: 'No image result recorded for this tool call.' }
    }
    const image = payload.images[Math.max(0, Math.min(index, payload.images.length - 1))]
    return { success: true, data: image.data, mimeType: image.mimeType }
  }

  getToolResultText(
    sessionManager: SessionManager,
    liveMessages: any[],
    toolCallId: string
  ): { success: boolean; text?: string; toolName?: string; error?: string } {
    const payload = this.findToolResult(sessionManager, liveMessages, toolCallId)
    if (!payload) return { success: false, error: 'No result recorded for this tool call.' }
    return { success: true, text: payload.text, toolName: payload.toolName }
  }

  exportMarkdown(
    sessionManager: SessionManager,
    title: string,
    language: ExportLanguage = 'zh'
  ): { success: true; title: string; content: string } {
    const exported = buildMarkdownExport(
      title,
      buildExportTurns(sessionManager),
      language === 'en' ? 'en' : 'zh'
    )
    return { success: true, ...exported }
  }

  exportHtml(
    sessionManager: SessionManager,
    title: string,
    language: ExportLanguage = 'zh'
  ): { success: true; title: string; content: string } {
    const exported = buildHtmlExport(
      title,
      buildExportTurns(sessionManager),
      language === 'en' ? 'en' : 'zh'
    )
    return { success: true, ...exported }
  }

  exportJson(
    sessionManager: SessionManager,
    title: string
  ): { success: true; title: string; turns: ExportTurn[]; content: string } {
    const turns = buildExportTurns(sessionManager)
    const content = JSON.stringify({ title, exportedAt: new Date().toISOString(), turns }, null, 2)
    return { success: true, title, turns, content }
  }

  getSessionJsonlPath(
    sessionManager: SessionManager,
    title: string
  ): { success: boolean; title?: string; path?: string; error?: string } {
    const file = sessionManager.getSessionFile()
    if (!file) return { success: false, error: 'This session has not been saved yet.' }
    return { success: true, title, path: file }
  }
}
