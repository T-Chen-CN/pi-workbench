/**
 * 主进程 `worker_threads` 轻量执行器。
 *
 * 将重 CPU / 同步解压 / 仓库全量扫描隔离到工作线程，避免卡住 Electron GUI 主线程。
 * 在源码直跑环境（如 Vitest 加载 `.ts` 文件、不存在编译后 `.js` 兄弟文件）自动回退到调用方提供的进程内异步函数，
 * 在已编译的 `dist-electron/*.js` 运行时则始终走真实 `Worker` 线程。
 */

import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'

export interface WorkerRequestMessage {
  type: 'req'
  id: number
  method: string
  payload: unknown
}

export interface WorkerResponseMessage {
  type: 'res'
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

export interface WorkerCallbackMessage {
  type: 'cb'
  /** 发起回调的请求 ID：严格路由回对应挂起调用，防止并发请求串线 */
  requestId: number
  callId: number
  name: string
  payload: unknown
}

export interface WorkerCallbackReplyMessage {
  type: 'cb-res'
  callId: number
  ok: boolean
  result?: unknown
  error?: string
}

export type WorkerCallbackHandler = (name: string, payload: unknown) => Promise<unknown>

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  onCallback?: WorkerCallbackHandler
}

const DEFAULT_TIMEOUT_MS = 60_000
const activePools = new Set<WorkerClient>()

export class WorkerClient {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private disposed = false

  constructor(
    private readonly scriptUrl: URL,
    private readonly name: string
  ) {
    activePools.add(this)
  }

  /** 检查编译后的 JS Worker 脚本是否可用（Vitest 直接执行 .ts 时为 false） */
  isWorkerAvailable(): boolean {
    if (this.disposed) return false
    try {
      const filePath = fileURLToPath(this.scriptUrl)
      return filePath.endsWith('.js') && fs.existsSync(filePath)
    } catch {
      return false
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(this.scriptUrl)
    worker.unref()
    worker.on('message', (msg: WorkerResponseMessage | WorkerCallbackMessage) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'res') {
        const entry = this.pending.get(msg.id)
        if (!entry) return
        this.pending.delete(msg.id)
        clearTimeout(entry.timer)
        if (msg.ok) entry.resolve(msg.result)
        else entry.reject(new Error(msg.error || `Worker ${this.name} call failed`))
        return
      }
      if (msg.type === 'cb') {
        void this.handleCallback(worker, msg)
      }
    })
    worker.on('error', (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)))
      if (this.worker === worker) this.worker = null
    })
    worker.on('exit', (code) => {
      if (code !== 0) {
        this.failAll(new Error(`Worker ${this.name} exited with code ${code}`))
      } else {
        this.failAll(new Error(`Worker ${this.name} terminated`))
      }
      if (this.worker === worker) this.worker = null
    })
    this.worker = worker
    return worker
  }

  private async handleCallback(worker: Worker, msg: WorkerCallbackMessage): Promise<void> {
    // 严格按 requestId 路由回发起回调的原始请求，避免并发调用时串线
    const handler =
      typeof msg.requestId === 'number'
        ? this.pending.get(msg.requestId)?.onCallback
        : undefined
    const reply = (payload: WorkerCallbackReplyMessage) => {
      try {
        worker.postMessage(payload)
      } catch {
        // worker 已退出
      }
    }
    if (!handler) {
      reply({ type: 'cb-res', callId: msg.callId, ok: false, error: `No handler for ${msg.name}` })
      return
    }
    try {
      const result = await handler(msg.name, msg.payload)
      reply({ type: 'cb-res', callId: msg.callId, ok: true, result })
    } catch (error) {
      reply({
        type: 'cb-res',
        callId: msg.callId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  call<T>(
    method: string,
    payload: unknown,
    options?: { timeoutMs?: number; onCallback?: WorkerCallbackHandler }
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error(`Worker ${this.name} is disposed`))
    }
    const worker = this.ensureWorker()
    const id = this.nextId++
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 超时后重建 worker，防止被死循环或恶意文档卡死的线程继续占用槽位
        void this.recycle()
        reject(new Error(`Worker ${this.name}.${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        onCallback: options?.onCallback,
      })
      const req: WorkerRequestMessage = { type: 'req', id, method, payload }
      worker.postMessage(req)
    })
  }

  private async recycle(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (worker) {
      await worker.terminate().catch(() => undefined)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    activePools.delete(this)
    this.failAll(new Error(`Worker ${this.name} disposed`))
    await this.recycle()
  }
}

/** 退出时回收所有后台工作线程 */
export async function disposeAllWorkers(): Promise<void> {
  await Promise.allSettled([...activePools].map((pool) => pool.dispose()))
}
