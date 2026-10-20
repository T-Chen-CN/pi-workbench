/**
 * Fleet 任务存储。
 *
 * 优先使用 Electron 内置的 node:sqlite（Electron 44 / Node 24 自带，无需原生依赖）；
 * 若运行环境不支持，则回退到同目录下的 JSON 文件，保证任务记录不丢失。
 */
import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'

export type FleetTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface FleetTask {
  id: string
  workspace: string
  name: string
  prompt: string
  status: FleetTaskStatus
  worktree: string
  branch: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
  output: string
  worktreeRemoved?: boolean
}

export interface FleetStore {
  insert(task: FleetTask): void
  update(id: string, patch: Partial<FleetTask>): FleetTask | null
  get(id: string): FleetTask | null
  /** 某工作区的任务，按创建时间倒序 */
  list(workspace: string): FleetTask[]
  /** 全部任务（队列调度用） */
  all(): FleetTask[]
  close(): void
}

/** node:sqlite 的最小类型声明（@types/node 20 尚未包含） */
interface SqliteStatement {
  run: (...params: unknown[]) => unknown
  get: (...params: unknown[]) => unknown
  all: (...params: unknown[]) => unknown[]
}

interface SqliteDatabase {
  exec: (sql: string) => void
  prepare: (sql: string) => SqliteStatement
  close: () => void
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase
}

const requireFromHere = createRequire(import.meta.url)

function tryCreateSqlite(filePath: string): SqliteDatabase | null {
  try {
    const sqlite = requireFromHere('node:sqlite') as SqliteModule
    const db = new sqlite.DatabaseSync(filePath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_tasks (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `)
    return db
  } catch (error) {
    console.warn('[Fleet] node:sqlite unavailable, falling back to JSON:', error)
    return null
  }
}

export class SqliteFleetStore implements FleetStore {
  private readonly db: SqliteDatabase

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const db = tryCreateSqlite(filePath)
    if (!db) throw new Error('node:sqlite is not available')
    this.db = db
  }

  insert(task: FleetTask): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO fleet_tasks (id, workspace, status, updated_at, data) VALUES (?, ?, ?, ?, ?)'
      )
      .run(task.id, task.workspace, task.status, task.updatedAt, JSON.stringify(task))
  }

  update(id: string, patch: Partial<FleetTask>): FleetTask | null {
    const current = this.get(id)
    if (!current) return null
    const next: FleetTask = { ...current, ...patch, updatedAt: Date.now() }
    this.insert(next)
    return next
  }

  get(id: string): FleetTask | null {
    const row = this.db.prepare('SELECT data FROM fleet_tasks WHERE id = ?').get(id) as
      | { data: string }
      | undefined
    return row ? (JSON.parse(row.data) as FleetTask) : null
  }

  list(workspace: string): FleetTask[] {
    const rows = this.db
      .prepare('SELECT data FROM fleet_tasks WHERE workspace = ? ORDER BY updated_at DESC')
      .all(workspace) as Array<{ data: string }>
    return rows.map((row) => JSON.parse(row.data) as FleetTask)
  }

  all(): FleetTask[] {
    const rows = this.db
      .prepare('SELECT data FROM fleet_tasks ORDER BY updated_at DESC')
      .all() as Array<{ data: string }>
    return rows.map((row) => JSON.parse(row.data) as FleetTask)
  }

  close(): void {
    this.db.close()
  }
}

export class JsonFleetStore implements FleetStore {
  private readonly filePath: string
  private tasks: FleetTask[]

  constructor(filePath: string) {
    this.filePath = filePath
    this.tasks = this.load()
  }

  private load(): FleetTask[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as unknown
      return Array.isArray(parsed) ? (parsed as FleetTask[]) : []
    } catch {
      return []
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.tasks, null, 2), 'utf-8')
    } catch (error) {
      console.warn('[Fleet] Failed to persist tasks:', error)
    }
  }

  insert(task: FleetTask): void {
    const index = this.tasks.findIndex((item) => item.id === task.id)
    if (index >= 0) {
      this.tasks[index] = task
    } else {
      this.tasks.push(task)
    }
    this.persist()
  }

  update(id: string, patch: Partial<FleetTask>): FleetTask | null {
    const index = this.tasks.findIndex((task) => task.id === id)
    if (index < 0) return null
    const next: FleetTask = { ...this.tasks[index], ...patch, updatedAt: Date.now() }
    this.tasks[index] = next
    this.persist()
    return next
  }

  get(id: string): FleetTask | null {
    return this.tasks.find((task) => task.id === id) ?? null
  }

  list(workspace: string): FleetTask[] {
    return this.tasks
      .filter((task) => task.workspace === workspace)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  all(): FleetTask[] {
    return [...this.tasks]
  }

  close(): void {
    this.persist()
  }
}

/** 优先 SQLite，失败时回退到 JSON（同一目录） */
export function createFleetStore(dbPath: string): FleetStore {
  try {
    return new SqliteFleetStore(dbPath)
  } catch (error) {
    console.warn('[Fleet] SQLite store unavailable, using JSON store:', error)
    return new JsonFleetStore(dbPath.replace(/\.db$/i, '.json'))
  }
}
