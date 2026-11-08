/**
 * 派活任务的本地执行：把「云端的一条指令」变成一次真实的本地会话。
 *
 * 关键取舍（WORKSPACE_DISPATCH §2）：
 * - **派活会话没有本地审批门**：权限固定 `auto`。云端 Hermes 就是这一轮的用户，
 *   本地再弹一个只有机器看得见的审批框，只会让任务超时作废。
 * - 会话按任务新建，任务结束后保留（人可以点进去回放整个过程）。
 * - 失败如实上报：不从错误里编造成功，也不吞掉 stderr。
 */

import * as path from 'node:path'
import { ensureWorkspaceAgent, type AgentIpcContext } from '../ipc/agent.js'
import type { ReportInput } from './relay.js'

export interface ExecuteTask {
  taskId: string
  workspaceId: string
  workspacePath: string
  prompt: string
  /**
   * 本地 Agent 反问（`ask_cloud_operator`）的出口：worker 负责把问题报给网关、
   * 等 `task.answered` 帧，再把答案 resolve 回来。任务被取消 / 超时会 reject。
   */
  ask?: (question: string) => Promise<string>
}

export interface ExecuteOutcome {
  report: Omit<ReportInput, 'taskId'>
  /** 本地会话 id：进审计与界面，云端只做展示 */
  sessionId: string | null
}

export interface ExecutorDeps {
  context: AgentIpcContext
  /** 现读 API 配置（含解密后的 key）；null 表示还没配好模型 */
  readApiConfig: () => Promise<{
    provider: string
    apiUrl: string
    apiKey: string
    selectedModel: string
    models?: Array<{ id: string; contextWindow: number; image: boolean }>
  } | null>
  logger: { warn: (...args: unknown[]) => void }
}

const SUMMARY_LIMIT = 4000

/**
 * 派活只用到 Agent 的四个方法。这里用结构化最小类型而不是 import pi-bridge：
 * 主进程的 tsconfig 以 `electron` 为 rootDir，从那里 import 源码会直接打穿构建。
 */
interface DispatchAgent {
  createSession: (
    workspaceDir: string,
    options?: { dispatchAsk?: (question: string) => Promise<string> }
  ) => Promise<{ success: boolean; session?: { id: string }; error?: string }>
  setSessionPermission: (
    sessionId: string,
    permission: { mode: 'auto'; grants: string[] }
  ) => Promise<unknown>
  chat: (sessionId: string, prompt: string) => Promise<DispatchChatResult>
  abort: (sessionId?: string) => Promise<void>
}

/** `AgentChatResult` 里派活实际读的字段 */
interface DispatchChatResult {
  success: boolean
  response?: string
  error?: string
  errorCode?: string
  outputLimit?: number
  edits?: Array<{ path: string }>
  usage?: { totalTokens?: number }
}

export class DispatchExecutor {
  /** 正在跑的本地会话：取消时按任务 id 找到它 */
  private readonly running = new Map<string, { agent: DispatchAgent; sessionId: string }>()

  constructor(private readonly deps: ExecutorDeps) {}

  /**
   * 跑一个任务。**不抛异常**：所有失败都变成 `failed` 回报，
   * 否则 worker 还得再兜一层，容易漏掉某一类错误导致任务悬挂。
   */
  async run(task: ExecuteTask): Promise<ExecuteOutcome> {
    const apiConfig = await this.deps.readApiConfig().catch(() => null)
    if (!apiConfig || !apiConfig.apiKey) {
      return {
        report: {
          kind: 'failed',
          error: '本机还没有配置模型（API Key 为空），无法派活执行。',
        },
        sessionId: null,
      }
    }

    const ensured = await ensureWorkspaceAgent(
      this.deps.context,
      task.workspacePath,
      apiConfig
    ).catch((error: unknown) => ({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    if (!ensured.success) {
      return {
        report: {
          kind: 'failed',
          error: `本机 Agent 初始化失败：${ensured.error ?? '未知原因'}`,
        },
        sessionId: null,
      }
    }

    const agent = (this.deps.context.agentRegistry.get(task.workspacePath) ??
      null) as DispatchAgent | null
    if (!agent) {
      return {
        report: { kind: 'failed', error: '本机 Agent 不可用（未登记到工作区）。' },
        sessionId: null,
      }
    }

    const created = await agent.createSession(
      task.workspacePath,
      task.ask ? { dispatchAsk: task.ask } : undefined
    )
    const sessionId = created.success ? created.session?.id ?? null : null
    if (!sessionId) {
      return {
        report: {
          kind: 'failed',
          error: `无法新建本机会话：${created.error ?? '未知原因'}`,
        },
        sessionId: null,
      }
    }

    // 派活会话固定「无本地审批门」：模式是 auto，notify 关掉审批推送
    await agent.setSessionPermission(sessionId, { mode: 'auto', grants: [] })
    this.running.set(task.taskId, { agent, sessionId })

    try {
      const result = await agent.chat(sessionId, task.prompt)
      if (!result.success) {
        return {
          report: { kind: 'failed', error: this.describeFailure(result), localSessionId: sessionId },
          sessionId,
        }
      }
      return {
        report: {
          kind: 'done',
          summary: this.summarize(result),
          files: this.changedFiles(result, task.workspacePath),
          usage: result.usage ? { totalTokens: result.usage.totalTokens } : undefined,
          localSessionId: sessionId,
        },
        sessionId,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logger.warn('[Dispatch] task run failed', error)
      return {
        report: { kind: 'failed', error: message.slice(0, 2000), localSessionId: sessionId },
        sessionId,
      }
    } finally {
      this.running.delete(task.taskId)
    }
  }

  /** 取消：真正 abort 本地那一轮，而不是只把状态写掉 */
  async cancel(taskId: string): Promise<boolean> {
    const entry = this.running.get(taskId)
    if (!entry) return false
    await entry.agent.abort(entry.sessionId).catch((error: unknown) => {
      this.deps.logger.warn('[Dispatch] abort failed', error)
    })
    return true
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId)
  }

  private describeFailure(result: DispatchChatResult): string {
    if (result.errorCode === 'output-truncated') {
      return `本地 Agent 输出被截断（上限 ${result.outputLimit ?? 0} tokens），任务没跑完。`
    }
    if (result.errorCode === 'empty-response') return '本地 Agent 没有产生任何回复。'
    return (result.error ?? '本地 Agent 执行失败').slice(0, 2000)
  }

  private summarize(result: DispatchChatResult): string {
    const text = (result.response ?? '').trim()
    if (!text) return '本地 Agent 执行完成，但没有文字总结。'
    return text.slice(0, SUMMARY_LIMIT)
  }

  /** 只上报**相对工作区**的路径：绝对路径不出本机 */
  private changedFiles(result: DispatchChatResult, workspacePath: string): string[] {
    const root = path.resolve(workspacePath)
    const files: string[] = []
    for (const edit of result.edits ?? []) {
      const relative = path.relative(root, path.resolve(edit.path))
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
      files.push(relative.split(path.sep).join('/'))
      if (files.length >= 200) break
    }
    return files
  }
}
