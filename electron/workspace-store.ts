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
export function importRecentWorkspaces(store: WorkspaceStore, recent: string[], now = Date.now()): void {
  if (store.list().length > 0) return
  const candidates = [...new Set(recent.filter((item) => typeof item === 'string' && item))]
  for (let i = candidates.length - 1; i >= 0; i--) {
    store.recordOpen(candidates[i], now - i * 1000)
  }
}

function comparePathKey(workspacePath: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return workspacePath
  // Windows 路径大小写不敏感，且统一分隔符与尾随斜杠用于判重，避免 C:\Repo 与 c:\repo 重复入库
  const unified = workspacePath.replace(/\//g, '\\').replace(/\\+$/, '')
  return (unified || workspacePath).toLowerCase()
}

export function createWorkspaceStore(
  dbPath: string,
  platform: NodeJS.Platform = process.platform
): WorkspaceStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const requireFromHere = createRequire(import.meta.url)
  const { DatabaseSync } = requireFromHere('node:sqlite') as typeof import('node:sqlite')
  const db = new DatabaseSync(dbPath)
  // 启用 WAL + busy_timeout：缩短主进程写盘停顿并避免多窗口/更新瞬态锁冲突
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
  db.exec(
    'CREATE TABLE IF NOT EXISTS workspaces (' +
      'path TEXT PRIMARY KEY, opened_at INTEGER NOT NULL, open_count INTEGER NOT NULL DEFAULT 1)'
  )

  const upsert = db.prepare(
    'INSERT INTO workspaces (path, opened_at, open_count) VALUES (?, ?, 1) ' +
      'ON CONFLICT(path) DO UPDATE SET opened_at = excluded.opened_at, ' +
      'open_count = workspaces.open_count + 1'
  )
  const updateExisting = db.prepare(
    'UPDATE workspaces SET opened_at = ?, open_count = ? WHERE path = ?'
  )
  const listStmt = db.prepare(
    'SELECT path, opened_at, open_count FROM workspaces ORDER BY opened_at DESC, rowid DESC'
  )
  const removeStmt = db.prepare('DELETE FROM workspaces WHERE path = ?')
  const maxStmt = db.prepare('SELECT MAX(opened_at) AS maxAt FROM workspaces')

  // 同一毫秒内连续打开两个工作区时时间戳会撞车，靠 rowid 兜底排不出「谁更近」。
  // 记录时保证严格递增，让「刚打开的在最前」在任何时钟精度下都成立。
  let lastOpenedAt = Number((maxStmt.get() as { maxAt: number | null } | undefined)?.maxAt ?? 0) || 0

  type RawRow = { path: string; opened_at: number; open_count: number }

  const listDeduped = (): WorkspaceRecord[] => {
    const rows = listStmt.all() as RawRow[]
    const seen = new Set<string>()
    const records: WorkspaceRecord[] = []
    for (const row of rows) {
      const value = String(row.path)
      const key = comparePathKey(value, platform)
      if (seen.has(key)) continue
      seen.add(key)
      records.push({
        path: value,
        openedAt: Number(row.opened_at) || 0,
        openCount: Number(row.open_count) || 1,
      })
    }
    return records
  }

  return {
    recordOpen(workspacePath, at) {
      const openedAt = at ?? Math.max(Date.now(), lastOpenedAt + 1)
      lastOpenedAt = Math.max(lastOpenedAt, openedAt)
      if (platform === 'win32') {
        const key = comparePathKey(workspacePath, platform)
        const matches = (listStmt.all() as RawRow[]).filter(
          (row) => comparePathKey(String(row.path), platform) === key
        )
        if (matches.length > 0) {
          const primary = matches[0]
          const totalCount =
            matches.reduce((sum, row) => sum + (Number(row.open_count) || 1), 0) + 1
          for (let i = 1; i < matches.length; i += 1) {
            removeStmt.run(String(matches[i].path))
          }
          updateExisting.run(openedAt, totalCount, String(primary.path))
          return
        }
      }
      upsert.run(workspacePath, openedAt)
    },
    list() {
      return listDeduped()
    },
    listRecent(limit = 10) {
      return listDeduped()
        .slice(0, limit)
        .map((record) => record.path)
    },
    remove(workspacePath) {
      if (platform === 'win32') {
        const key = comparePathKey(workspacePath, platform)
        const matches = (listStmt.all() as RawRow[]).filter(
          (row) => comparePathKey(String(row.path), platform) === key
        )
        for (const row of matches) {
          removeStmt.run(String(row.path))
        }
        return
      }
      removeStmt.run(workspacePath)
    },
    close() {
      db.close()
    }
  }
}
