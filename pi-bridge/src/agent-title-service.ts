/**
 * 会话标题生成与落盘服务：从 `AgentManager` 拆出的独立子系统。
 * 负责读取确定标题、生成首轮标题、跨运行时重建补写记录与 sidecar。
 */

import { SessionManager, type ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { Api, Model } from '@earendil-works/pi-ai'
import { extractMessageText, extractTitleSourceTexts } from './agent-projections.js'
import { stripContextBlock } from './text-utils.js'
import {
  buildTitlePrompt,
  isEchoOfUserText,
  parseTitleResponse,
  requestSessionTitle,
} from './session-title.js'
import type { SessionExtrasStore } from './session-extras.js'
import type { AgentConfig, AgentLogger } from './types.js'
import { TITLE_MAX_FAILURES, type SessionRuntime } from './agent-runtime-types.js'

export interface AgentTitleDeps {
  getConfig: () => AgentConfig | null
  getModelRuntime: () => ModelRuntime | null
  getLogger: () => AgentLogger
  getSessionDir: () => string
  getExtrasStore: () => SessionExtrasStore | null
  getLiveRuntime: (sessionId: string) => SessionRuntime | undefined
  isDeleted: (sessionId: string) => boolean
  findSessionFile: (sessionId: string) => Promise<string | null>
  resolveSessionModel: (runtime?: SessionRuntime) => Model<Api> | undefined
  persistExtras: (runtime: SessionRuntime) => void
}

export class AgentTitleService {
  /** sessionId → 已确定的标题：跨运行时重建仍然有效，只有手动重命名能改写 */
  private readonly settledTitles = new Map<string, string>()

  constructor(private readonly deps: AgentTitleDeps) {}

  clear(): void {
    this.settledTitles.clear()
  }

  delete(sessionId: string): void {
    this.settledTitles.delete(sessionId)
  }

  getSettled(sessionId: string): string | undefined {
    return this.settledTitles.get(sessionId)
  }

  setSettled(sessionId: string, title: string): void {
    this.settledTitles.set(sessionId, title)
    if (this.settledTitles.size > 500) {
      const oldest = this.settledTitles.keys().next().value
      if (oldest !== undefined) this.settledTitles.delete(oldest)
    }
  }

  /** 已确定的标题：临时标题 → 会话记录 → 进程内已确定 → sidecar 快照 */
  sessionTitle(runtime: SessionRuntime): string | null {
    const pending = runtime.pendingTitle?.trim()
    if (pending) return pending
    try {
      const recorded = (runtime.sessionManager.getSessionName() ?? '').trim()
      if (recorded) return recorded
    } catch (error) {
      this.deps.getLogger().warn('[Agent Manager] Failed to read the session title:', error)
    }
    return this.settledTitles.get(runtime.id)?.trim() || runtime.extras.title?.trim() || null
  }

  /** 标记标题已确定（进程内 + sidecar）：之后只有手动重命名能改写 */
  settleSessionTitle(runtime: SessionRuntime, title: string): void {
    this.setSettled(runtime.id, title)
    if (runtime.extras.title === title) return
    runtime.extras.title = title
    this.deps.persistExtras(runtime)
  }

  /** 当前活跃分支的首条用户消息文本（废弃/回退分支不参与兜底标题） */
  recordFirstUserText(runtime: SessionRuntime): string {
    try {
      const entries = (
        typeof runtime.sessionManager.getBranch === 'function'
          ? runtime.sessionManager.getBranch()
          : runtime.sessionManager.getEntries()
      ) as any[]
      for (const entry of entries) {
        if (entry?.type !== 'message' || entry.message?.role !== 'user') continue
        const text = stripContextBlock(extractMessageText(entry.message.content)).trim()
        if (text) return text
      }
    } catch (error) {
      this.deps.getLogger().warn('[Agent Manager] Failed to resolve the first user message:', error)
    }
    return ''
  }

  /** 第一轮成功后异步生成会话标题；不在关键路径上 */
  async maybeGenerateTitle(runtime: SessionRuntime): Promise<void> {
    if (runtime.titleAttempted) return
    const config = this.deps.getConfig()
    if (!config?.onSessionTitle) return
    if (this.sessionTitle(runtime)) {
      runtime.titleAttempted = true
      return
    }

    const logger = this.deps.getLogger()
    const turn = extractTitleSourceTexts(runtime.sessionManager, logger)
    if (!turn.assistantText) {
      logger.info('[Agent Manager] Session title skipped: no assistant text yet')
      return
    }
    runtime.titleAttempted = true

    if (turn.imageOnly) {
      await this.persistSessionTitle(
        runtime,
        config,
        config.getLanguage?.() === 'en' ? 'Image chat' : '图片对话'
      )
      return
    }
    if (!turn.userText) {
      logger.info('[Agent Manager] Session title skipped: no user text to name')
      return
    }

    const titleModel = this.deps.resolveSessionModel(runtime)
    const modelRuntime = this.deps.getModelRuntime()
    const raw =
      titleModel && modelRuntime
        ? await requestSessionTitle(
            modelRuntime,
            titleModel,
            buildTitlePrompt(turn.userText, turn.assistantText),
            logger
          )
        : null
    const title = raw ? parseTitleResponse(raw) : ''
    if (!title || isEchoOfUserText(title, turn.userText)) {
      runtime.titleFailures += 1
      if (runtime.titleFailures < TITLE_MAX_FAILURES) runtime.titleAttempted = false
      logger.warn(
        `[Agent Manager] Session title unavailable (${runtime.titleFailures}/${TITLE_MAX_FAILURES}), keeping the fallback title`,
        title ? `rejected: ${JSON.stringify(title)}` : ''
      )
      return
    }
    await this.persistSessionTitle(runtime, config, title)
  }

  /** 写入会话标题；即使运行时已释放也通过会话文件与 sidecar 补写，不丢标题 */
  private async persistSessionTitle(
    runtime: SessionRuntime,
    config: AgentConfig,
    title: string
  ): Promise<void> {
    const id = runtime.id
    const value = title.trim().slice(0, 80)
    if (!value) return
    if (this.sessionTitle(runtime) || this.settledTitles.has(id)) return

    const logger = this.deps.getLogger()
    try {
      const liveRuntime = this.deps.getLiveRuntime(id)
      if (liveRuntime) {
        liveRuntime.sessionManager.appendSessionInfo(value)
        liveRuntime.updatedAt = Date.now()
        this.settleSessionTitle(liveRuntime, value)
      } else if (await this.appendTitleToSessionRecord(id, value)) {
        this.setSettled(id, value)
        void this.saveSessionTitleExtra(id, value)
      } else {
        logger.warn('[Agent Manager] Failed to persist the session title: session is gone')
        return
      }
    } catch (error) {
      logger.warn('[Agent Manager] Failed to persist the session title:', error)
      return
    }

    config.onSessionTitle?.(id, value)
    logger.info('[Agent Manager] Generated session title:', value)
  }

  private async appendTitleToSessionRecord(id: string, title: string): Promise<boolean> {
    if (this.deps.isDeleted(id)) return false
    const config = this.deps.getConfig()
    if (!config) return false
    const sessionDir = this.deps.getSessionDir()
    const root = config.resolveSessionRoot?.(id) ?? config.workspaceDir
    const file =
      (await this.deps.findSessionFile(id)) ?? SessionManager.findById(root, id, sessionDir)
    if (!file) return false
    const manager = SessionManager.open(file, sessionDir, root)
    if ((manager.getSessionName() ?? '').trim()) return false
    manager.appendSessionInfo(title)
    return true
  }

  async saveSessionTitleExtra(id: string, title: string): Promise<void> {
    const extrasStore = this.deps.getExtrasStore()
    if (!extrasStore || this.deps.isDeleted(id)) return
    try {
      const extras = await extrasStore.load(id)
      if (extras.title === title) return
      await extrasStore.save(id, { ...extras, title })
    } catch (error) {
      this.deps.getLogger().warn('[Agent Manager] Failed to save the session title:', error)
    }
  }
}
