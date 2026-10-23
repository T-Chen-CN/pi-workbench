/**
 * 工作区元数据存储（E-04）
 *
 * 优先使用 node:sqlite（Electron 44 / Node 24 内置）；不可用时回退到同名 JSON 文件。
 * 目前只记录最近打开时间与次数，供最近工作区排序使用。
 */

import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'
import { writeJsonAtomicSync } from './atomic-json.js'

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
  /** 当前实现：sqlite 或 json */
  kind: 'sqlite' | 'json'
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

interface StoreOptions {
  forceJson?: boolean
  now?: () => number
}

function createJsonStore(filePath: string, now: () => number): WorkspaceStore {
  const statePath = `${filePath}.json`
  const read = (): WorkspaceRecord[] => {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
      if (!Array.isArray(raw)) return []
      return raw.filter(
        (item): item is WorkspaceRecord =>
          item && typeof item.path === 'string' && typeof item.openedAt === 'number'
      )
    } catch {
      return []
    }
  }
  const write = (records: WorkspaceRecord[]): void => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    writeJsonAtomicSync(statePath, records)
  }
  let records = read()

  return {
    kind: 'json',
    recordOpen(workspacePath, at = now()) {
      const existing = records.find((item) => item.path === workspacePath)
      if (existing) {
        existing.openedAt = at
        existing.openCount += 1
      } else {
        records.push({ path: workspacePath, openedAt: at, openCount: 1 })
      }
      write(records)
    },
    list: () => [...records].sort((a, b) => b.openedAt - a.openedAt),
    listRecent: (limit = 10) =>
      [...records]
        .sort((a, b) => b.openedAt - a.openedAt)
        .slice(0, limit)
        .map((item) => item.path),
    remove(workspacePath) {
      records = records.filter((item) => item.path !== workspacePath)
      write(records)
    },
    close() {},
  }
}

export function createWorkspaceStore(dbPath: string, options: StoreOptions = {}): WorkspaceStore {
  const now = options.now ?? (() => Date.now())
  if (options.forceJson) return createJsonStore(dbPath, now)

  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
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
      kind: 'sqlite',
      recordOpen(workspacePath, at = now()) {
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
  } catch (error) {
    console.warn('[WorkspaceStore] node:sqlite unavailable, falling back to JSON:', error)
    return createJsonStore(dbPath, now)
  }
}
