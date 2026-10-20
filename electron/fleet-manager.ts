/**
 * Fleet 后台任务管理器。
 *
 * 任务在独立的 git worktree 中运行自己的 Agent 实例，队列默认一次执行一个。
 * 任务状态与输出持久化到 FleetStore，日志写入 {appDir}/logs/fleet-{id}.log。
 */
import * as fs from 'fs'
import * as path from 'path'
import type { FleetStore, FleetTask } from './fleet-store'
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
    options?: { onTextDelta?: (delta: string) => void }
  ) => Promise<{ success: boolean; response?: string; error?: string }>
  dispose: () => Promise<void> | void
}

export interface FleetManagerOptions {
  store: FleetStore
  worktrees: FleetWorktree
  createAgent: () => FleetAgent | Promise<FleetAgent>
  getApiConfig: () => Promise<FleetApiConfig | null>
  agentDir: string
  logDir: string
  maxConcurrent?: number
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

export class FleetManager {
  private readonly options: FleetManagerOptions
  private readonly active = new Map<string, FleetAgent>()
  private activeCount = 0
  private pumping = false

  constructor(options: FleetManagerOptions) {
    this.options = options
    this.recoverInterruptedTasks()
  }

  /** 上次进程退出时仍在运行的任务不可能继续，启动时标记为失败 */
  private recoverInterruptedTasks(): void {
    for (const task of this.options.store.all()) {
      if (task.status !== 'running') continue
      this.options.store.update(task.id, {
        status: 'failed',
        finishedAt: this.now(),
        error: 'Task was interrupted by application exit',
      })
    }
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
    if (!workspaceDir || !name.trim() || !prompt.trim()) {
      return { success: false, error: 'Workspace, task name and prompt are required' }
    }

    const apiConfig = await this.options.getApiConfig()
    if (!apiConfig?.apiKey) {
      return { success: false, error: 'API key not configured. Please set it in Settings.' }
    }

    const now = this.now()
    const id = `fleet-${now}-${Math.random().toString(36).slice(2, 8)}`
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

  async cancel(id: string): Promise<{ success: boolean; error?: string }> {
    const task = this.options.store.get(id)
    if (!task) return { success: false, error: 'Task not found' }
    if (task.status !== 'queued' && task.status !== 'running') {
      return { success: false, error: `Task is already ${task.status}` }
    }

    const updated = this.options.store.update(id, {
      status: 'cancelled',
      finishedAt: this.now(),
    })
    if (updated) this.emit(updated)

    const agent = this.active.get(id)
    if (agent) {
      try {
        await agent.dispose()
      } catch (error) {
        console.warn('[Fleet] Failed to abort task agent:', error)
      }
    }

    return { success: true }
  }

  async cleanupWorktree(id: string): Promise<{ success: boolean; error?: string }> {
    const task = this.options.store.get(id)
    if (!task) return { success: false, error: 'Task not found' }
    if (task.status === 'queued' || task.status === 'running') {
      return { success: false, error: 'Cannot clean up a task that is still queued or running' }
    }
    if (task.worktreeRemoved) return { success: true }

    const result = await this.options.worktrees.cleanup(task.workspace, task.worktree)
    if (!result.success) {
      return { success: false, error: result.error || 'Failed to remove worktree' }
    }

    const updated = this.options.store.update(id, { worktreeRemoved: true })
    if (updated) this.emit(updated)
    return { success: true }
  }

  async disposeAll(): Promise<void> {
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

  /** 从队列中取出任务并执行（默认并发 1） */
  private pump(): void {
    if (this.pumping) return
    this.pumping = true

    try {
      const max = this.options.maxConcurrent ?? 1
      while (this.activeCount < max) {
        const next = this.options.store
          .all()
          .filter((task) => task.status === 'queued')
          .sort((a, b) => a.createdAt - b.createdAt)[0]
        if (!next) break

        const updated = this.options.store.update(next.id, {
          status: 'running',
          startedAt: this.now(),
        })
        if (!updated) break

        this.activeCount++
        this.emit(updated)

        void this.run(updated).finally(() => {
          this.activeCount = Math.max(0, this.activeCount - 1)
          this.pump()
        })
      }
    } finally {
      this.pumping = false
    }
  }

  private async run(task: FleetTask): Promise<void> {
    const logPath = path.join(this.options.logDir, `fleet-${task.id}.log`)
    const append = (text: string): void => {
      try {
        fs.mkdirSync(this.options.logDir, { recursive: true })
        fs.appendFileSync(logPath, text, 'utf-8')
      } catch (error) {
        console.warn('[Fleet] Failed to write task log:', error)
      }
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

      const initialized = await agent.initialize({
        workspaceDir: task.worktree,
        agentDir: this.options.agentDir,
        apiConfig,
      })
      if (!initialized.success) {
        throw new Error(initialized.error || 'Failed to initialize agent')
      }

      append(`[prompt]\n${task.prompt}\n\n[response]\n`)

      const result = await agent.chat(task.prompt, {
        onTextDelta: (delta) => {
          output = (output + delta).slice(-MAX_STREAM_BUFFER)
          append(delta)
        },
      })

      if (!result.success) {
        throw new Error(result.error || 'Agent failed')
      }

      // 运行期间被取消时保持 cancelled 状态
      const current = this.options.store.get(task.id)
      if (current?.status === 'cancelled') {
        append(`\n[${new Date(this.now()).toISOString()}] cancelled\n`)
        return
      }

      const finalText = (result.response ?? output).slice(-MAX_OUTPUT_CHARS)
      const updated = this.options.store.update(task.id, {
        status: 'succeeded',
        finishedAt: this.now(),
        output: finalText,
        error: undefined,
      })
      if (updated) this.emit(updated)
      append(`\n[${new Date(this.now()).toISOString()}] succeeded\n`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const current = this.options.store.get(task.id)
      if (current?.status === 'cancelled') {
        append(`\n[${new Date(this.now()).toISOString()}] cancelled\n`)
        return
      }

      const updated = this.options.store.update(task.id, {
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
}
