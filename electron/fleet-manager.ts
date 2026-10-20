/**
 * Fleet 后台任务管理器。
 *
 * 任务在独立的 git worktree 中运行自己的 Agent 实例，队列默认一次执行一个。
 * 任务状态与输出持久化到 FleetStore，日志写入 {appDir}/logs/fleet-{id}.log。
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { isAllowedStatusTransition, type FleetStore, type FleetTask } from './fleet-store'
import type { FleetWorktree } from './fleet-worktree'

export interface FleetApiConfig {
  provider: string
  apiUrl: string
  apiKey: string
  selectedModel: string
}

export interface FleetAgentInitConfig {
  workspaceDir: string
  agentDir: string
  apiConfig: FleetApiConfig
}

export interface FleetAgent {
  initialize: (config: FleetAgentInitConfig) => Promise<{ success: boolean; error?: string }>
  chat: (
    message: string,
    options?: { onTextDelta?: (delta: string) => void; timeoutMs?: number }
  ) => Promise<{ success: boolean; response?: string; error?: string }>
  /** 中止当前请求（AgentManager 支持）；用于取消时让工具调用尽快停下 */
  abort?: () => Promise<void> | void
  dispose: () => Promise<void> | void
}

export interface FleetManagerOptions {
  store: FleetStore
  worktrees: FleetWorktree
  createAgent: () => FleetAgent | Promise<FleetAgent>
  getApiConfig: () => Promise<FleetApiConfig | null>
  agentDir: string
  logDir: string
  /** 每个工作区同时运行的任务数（默认 1），工作区之间互不排队 */
  maxConcurrent?: number
  /** 全局同时运行的任务上限（默认 4），避免多个工作区一起压满机器 */
  maxTotalConcurrent?: number
  onUpdate?: (task: FleetTask) => void
  now?: () => number
}

export interface CreateTaskResult {
  success: boolean
  task?: FleetTask
  error?: string
}

const MAX_OUTPUT_CHARS = 100_000
const MAX_STREAM_BUFFER = 200_000
const MAX_LOG_BYTES = 5 * 1024 * 1024
/** 后台任务允许更长的单轮执行时间，同时避免永久挂起堵住队列 */
const FLEET_TASK_TIMEOUT_MS = 30 * 60_000

export class FleetManager {
  private readonly options: FleetManagerOptions
  private readonly active = new Map<string, FleetAgent>()
  private readonly activeByWorkspace = new Map<string, number>()
  private activeCount = 0
  private pumping = false
  /** 应用正在退出：不再调度新任务，也不再写入已关闭的 store */
  private disposed = false

  constructor(options: FleetManagerOptions) {
    this.options = options
    this.recoverInterruptedTasks()
    // 上次退出时仍在排队的任务继续执行，不需要用户重新创建
    if (this.options.store.all().some((task) => task.status === 'queued')) {
      void this.pump()
    }
  }

  /** 上次进程退出时仍在运行的任务不可能继续，启动时标记为失败 */
  private recoverInterruptedTasks(): void {
    for (const task of this.options.store.all()) {
      if (task.status !== 'running') continue
      this.updateTask(task.id, {
        status: 'failed',
        finishedAt: this.now(),
        error: 'Task was interrupted by application exit',
      })
    }
  }

  /** 带状态机校验的更新：终态不可回退，非法迁移返回 null */
  private updateTask(id: string, patch: Partial<FleetTask>): FleetTask | null {
    const current = this.options.store.get(id)
    if (!current) return null
    if (patch.status && !isAllowedStatusTransition(current.status, patch.status)) {
      console.warn(`[Fleet] Rejected status transition ${current.status} -> ${patch.status} (${id})`)
      return null
    }
    return this.options.store.update(id, patch)
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  private emit(task: FleetTask): void {
    this.options.onUpdate?.(task)
  }

  async createTask(
    workspaceDir: string,
    name: string,
    prompt: string
  ): Promise<CreateTaskResult> {
    if (this.disposed) {
      return { success: false, error: 'Application is shutting down' }
    }
    if (!workspaceDir || !name.trim() || !prompt.trim()) {
      return { success: false, error: 'Workspace, task name and prompt are required' }
    }

    const apiConfig = await this.options.getApiConfig()
    if (!apiConfig?.apiKey) {
      return { success: false, error: 'API key not configured. Please set it in Settings.' }
    }

    const now = this.now()
    const id = `fleet-${randomUUID()}`
    const worktree = await this.options.worktrees.create(workspaceDir, name, id)
    if (!worktree.success || !worktree.worktree || !worktree.branch) {
      return { success: false, error: worktree.error || 'Failed to create worktree' }
    }

    const task: FleetTask = {
      id,
      workspace: workspaceDir,
      name: name.trim(),
      prompt: prompt.trim(),
      status: 'queued',
      worktree: worktree.worktree,
      branch: worktree.branch,
      createdAt: now,
      updatedAt: now,
      output: '',
    }

    this.options.store.insert(task)
    this.emit(task)
    void this.pump()
    return { success: true, task }
  }

  list(workspaceDir: string): FleetTask[] {
    return this.options.store.list(workspaceDir)
  }

  get(id: string): FleetTask | null {
    return this.options.store.get(id)
  }

  async cancel(
    id: string,
    workspaceDir?: string
  ): Promise<{ success: boolean; error?: string }> {
    const task = this.options.store.get(id)
    if (!task || (workspaceDir && task.workspace !== workspaceDir)) {
      return { success: false, error: 'Task not found' }
    }
    if (task.status !== 'queued' && task.status !== 'running') {
      return { success: false, error: `Task is already ${task.status}` }
    }

    const updated = this.updateTask(id, {
      status: 'cancelled',
      finishedAt: this.now(),
    })
    if (updated) this.emit(updated)

    const agent = this.active.get(id)
    if (agent) {
      try {
        // 先 abort 让模型请求与工具调用停下，再释放会话
        if (typeof agent.abort === 'function') {
          await agent.abort()
        }
      } catch (error) {
        console.warn('[Fleet] Failed to abort task agent:', error)
      }
      try {
        await agent.dispose()
      } catch (error) {
        console.warn('[Fleet] Failed to dispose task agent:', error)
      }
    }

    return { success: true }
  }

  async cleanupWorktree(
    id: string,
    workspaceDir?: string
  ): Promise<{ success: boolean; error?: string }> {
    const task = this.options.store.get(id)
    if (!task || (workspaceDir && task.workspace !== workspaceDir)) {
      return { success: false, error: 'Task not found' }
    }
    if (task.status === 'queued' || task.status === 'running') {
      return { success: false, error: 'Cannot clean up a task that is still queued or running' }
    }
    if (task.worktreeRemoved) return { success: true }

    const result = await this.options.worktrees.cleanup(task.workspace, task.worktree)
    if (!result.success) {
      return { success: false, error: result.error || 'Failed to remove worktree' }
    }

    const updated = this.updateTask(id, { worktreeRemoved: true })
    if (updated) this.emit(updated)
    return { success: true }
  }

  async disposeAll(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const agents = [...this.active.entries()]
    this.active.clear()
    for (const [, agent] of agents) {
      try {
        await agent.dispose()
      } catch {
        // ignore
      }
    }
    this.options.store.close()
  }

  /** 从队列中取出任务并执行：每个工作区默认并发 1，工作区之间相互独立 */
  private pump(): void {
    if (this.pumping || this.disposed) return
    this.pumping = true

    try {
      const perWorkspace = this.options.maxConcurrent ?? 1
      const total = this.options.maxTotalConcurrent ?? Math.max(perWorkspace, 4)

      while (this.activeCount < total) {
        const queued = this.options.store
          .all()
          .filter((task) => task.status === 'queued')
          .sort((a, b) => a.createdAt - b.createdAt)

        const next = queued.find(
          (task) => (this.activeByWorkspace.get(task.workspace) ?? 0) < perWorkspace
        )
        if (!next) break

        const updated = this.updateTask(next.id, {
          status: 'running',
          startedAt: this.now(),
        })
        if (!updated) break

        this.activeCount++
        this.activeByWorkspace.set(
          updated.workspace,
          (this.activeByWorkspace.get(updated.workspace) ?? 0) + 1
        )
        this.emit(updated)

        void this.run(updated).finally(() => {
          this.activeCount = Math.max(0, this.activeCount - 1)
          const remaining = (this.activeByWorkspace.get(updated.workspace) ?? 1) - 1
          if (remaining <= 0) {
            this.activeByWorkspace.delete(updated.workspace)
          } else {
            this.activeByWorkspace.set(updated.workspace, remaining)
          }
          this.pump()
        })
      }
    } finally {
      this.pumping = false
    }
  }

  private async run(task: FleetTask): Promise<void> {
    const logPath = path.join(this.options.logDir, `fleet-${task.id}.log`)
    const append = this.createLogAppender(logPath)

    // 任务在调度后、真正开始前被取消：不再创建 Agent
    if (this.options.store.get(task.id)?.status === 'cancelled') {
      return
    }

    append(`[${new Date(this.now()).toISOString()}] task ${task.id} (${task.name}) started\n`)

    let output = ''
    let agent: FleetAgent | null = null

    try {
      const apiConfig = await this.options.getApiConfig()
      if (!apiConfig?.apiKey) {
        throw new Error('API key not configured')
      }

      agent = await this.options.createAgent()
      this.active.set(task.id, agent)

      // 每个任务使用独立的 agent 目录，避免并发任务互相覆盖 models.json
      const taskAgentDir = path.join(this.options.agentDir, 'fleet', task.id)

      const initialized = await agent.initialize({
        workspaceDir: task.worktree,
        agentDir: taskAgentDir,
        apiConfig,
      })
      if (!initialized.success) {
        throw new Error(initialized.error || 'Failed to initialize agent')
      }

      // 初始化期间被取消时不再发送 prompt
      if (this.options.store.get(task.id)?.status === 'cancelled') {
        append(`\n[${new Date(this.now()).toISOString()}] cancelled\n`)
        return
      }

      append(`[prompt]\n${task.prompt}\n\n[response]\n`)

      const result = await agent.chat(task.prompt, {
        onTextDelta: (delta) => {
          output = (output + delta).slice(-MAX_STREAM_BUFFER)
          append(delta)
        },
        timeoutMs: FLEET_TASK_TIMEOUT_MS,
      })

      if (!result.success) {
        throw new Error(result.error || 'Agent failed')
      }

      // 应用正在退出时不再写入已关闭的 store
      if (this.disposed) return

      // 运行期间被取消时保持 cancelled 状态
      const current = this.options.store.get(task.id)
      if (current?.status === 'cancelled') {
        append(`\n[${new Date(this.now()).toISOString()}] cancelled\n`)
        return
      }

      const finalText = (result.response ?? output).slice(-MAX_OUTPUT_CHARS)
      const updated = this.updateTask(task.id, {
        status: 'succeeded',
        finishedAt: this.now(),
        output: finalText,
        error: undefined,
      })
      if (updated) this.emit(updated)
      append(`\n[${new Date(this.now()).toISOString()}] succeeded\n`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.disposed) return
      const current = this.options.store.get(task.id)
      if (current?.status === 'cancelled') {
        append(`\n[${new Date(this.now()).toISOString()}] cancelled\n`)
        return
      }

      const updated = this.updateTask(task.id, {
        status: 'failed',
        finishedAt: this.now(),
        error: message,
        output: output.slice(-MAX_OUTPUT_CHARS),
      })
      if (updated) this.emit(updated)
      append(`\n[${new Date(this.now()).toISOString()}] failed: ${message}\n`)
    } finally {
      this.active.delete(task.id)
      if (agent) {
        try {
          await agent.dispose()
        } catch {
          // ignore
        }
      }
    }
  }

  /** 日志追加：单个文件超过上限时轮转为 .1，避免无限增长 */
  private createLogAppender(logPath: string): (text: string) => void {
    let logBytes = 0
    try {
      fs.mkdirSync(this.options.logDir, { recursive: true })
      logBytes = fs.statSync(logPath).size
    } catch {
      logBytes = 0
    }

    return (text: string): void => {
      if (!text) return
      try {
        fs.mkdirSync(this.options.logDir, { recursive: true })
        fs.appendFileSync(logPath, text, 'utf-8')
        logBytes += Buffer.byteLength(text, 'utf-8')
        if (logBytes > MAX_LOG_BYTES) {
          const rotated = `${logPath}.1`
          fs.rmSync(rotated, { force: true })
          fs.renameSync(logPath, rotated)
          logBytes = 0
        }
      } catch (error) {
        console.warn('[Fleet] Failed to write task log:', error)
      }
    }
  }
}
