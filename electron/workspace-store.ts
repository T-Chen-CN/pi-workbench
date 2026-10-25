/**
 * 工作区元数据存储（E-04）
 *
 * 使用 Electron 44 / Node 24 内置的 node:sqlite，单一数据源为
 * `{appDir}/data/workspaces.db`；记录最近打开时间与次数。
 */

import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'

export interface WorkspaceRecord {
  path: string
  openedAt: number
  openCount: number
}

export interface WorkspaceStore {
  recordOpen: (workspacePath: string, at?: number) => void
  list: () => WorkspaceRecord[]
  listRecent: (limit?: number) => string[]
  remove: (workspacePath: string) => void
  close: () => void
}

/** 把旧版 settings 的「最新在前」列表导入空库，保留相对顺序 */
export function importRecentWorkspaces(
  store: WorkspaceStore,
  recent: string[],
  now = Date.now()
): void {
  if (store.list().length > 0) return
  const candidates = [...new Set(recent.filter((item) => typeof item === 'string' && item))]
  for (let i = candidates.length - 1; i >= 0; i--) {
    store.recordOpen(candidates[i], now - i * 1000)
  }
}

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
  DatabaseSync: new (filename: string) => SqliteDatabase
}

export function createWorkspaceStore(dbPath: string): WorkspaceStore {  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const requireFromHere = createRequire(import.meta.url)
  const sqlite = requireFromHere('node:sqlite') as SqliteModule
  const db = new sqlite.DatabaseSync(dbPath)
  db.exec(
    'CREATE TABLE IF NOT EXISTS workspaces (' +
      'path TEXT PRIMARY KEY, opened_at INTEGER NOT NULL, open_count INTEGER NOT NULL DEFAULT 1)'
  )

  const upsert = db.prepare(
    'INSERT INTO workspaces (path, opened_at, open_count) VALUES (?, ?, 1) ' +
      'ON CONFLICT(path) DO UPDATE SET opened_at = excluded.opened_at, ' +
      'open_count = workspaces.open_count + 1'
  )
  const listStmt = db.prepare(
    'SELECT path, opened_at, open_count FROM workspaces ORDER BY opened_at DESC'
  )
  const removeStmt = db.prepare('DELETE FROM workspaces WHERE path = ?')

  return {
    recordOpen(workspacePath, at = Date.now()) {
      upsert.run(workspacePath, at)
    },
    list() {
      const rows = listStmt.all() as Array<{
        path: string
        opened_at: number
        open_count: number
      }>
      return rows.map((row) => ({
        path: String(row.path),
        openedAt: Number(row.opened_at) || 0,
        openCount: Number(row.open_count) || 1,
      }))
    },
    listRecent(limit = 10) {
      const rows = listStmt.all() as Array<{ path: string }>
      return rows.slice(0, limit).map((row) => String(row.path))
    },
    remove(workspacePath) {
      removeStmt.run(workspacePath)
    },
    close() {
      db.close()
    },
  }
}
