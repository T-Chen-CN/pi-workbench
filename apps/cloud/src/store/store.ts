/**
 * 云端持久化：账号、设备、配对码、工单、工单 diff、工作单元、云端配置、客户端游标。
 *
 * 使用 Node 24 内置 `node:sqlite`（`cloud.db`，WAL 模式 + 事务），单条记录按行读写、
 * `task_diffs` 独立分表避免写入放大与快照泄漏。
 * 首次在旧目录启动时自动将历史 `*.json` 与 `task-diffs/*.json` 一次性迁移入库（保留原文件作备份）。
 * 会话 JSONL 不在这里——那是 SDK 的 `agentDir/sessions`，也是唯一真相源（F-42）。
 */

import { timingSafeEqual } from 'crypto'
import { promises as fs } from 'fs'
import { createRequire } from 'module'
import * as path from 'path'
import type { DatabaseSync as SqliteDatabaseSync } from 'node:sqlite'
import type {
  CloudWorkspaceInfo,
  CloudTaskResult,
  CloudTaskSnapshot,
} from 'pi-bridge'
import { readJson } from './atomic.js'
import { verifyToken, type TokenHash } from '../auth/credentials.js'
import type { AuthorizationRecord } from '../tasks/authorization.js'

const requireFromHere = createRequire(import.meta.url)

function openSqliteDatabase(dbPath: string): SqliteDatabaseSync {
  const { DatabaseSync } = requireFromHere('node:sqlite') as typeof import('node:sqlite')
  return new DatabaseSync(dbPath)
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

export interface AccountRecord {
  passwordHash: string
  salt: string
  createdAt: number
  updatedAt: number
  /** 服务端会话版本号；登出后递增，令已签发的旧 Cookie 立即失效 */
  sessionVersion?: number
}

export interface DeviceRecord {
  id: string
  name: string
  platform: string
  /** 设备执行通道 token（最小权限：仅 /device/ws、工作区上报与自吊销） */
  token: TokenHash
  /** 桌面用户控制面 token（用于 /client/ws 与管理 REST；缺失时拒绝控制面鉴权，需重新配对） */
  clientToken?: TokenHash
  createdAt: number
  lastSeenAt: number
  workspaces: CloudWorkspaceInfo[]
  revokedAt: number | null
}

export interface PairingCodeRecord {
  /** 只存哈希：码本身只在生成响应里出现一次 */
  hash: string
  salt: string
  createdAt: number
  expiresAt: number
  usedAt: number | null
}

/**
 * 云端模型配置；`credentialCipher` 是 AES-256-GCM 密文，明文永不落盘。
 *
 * 旧记录（`provider` + `apiUrl` + `apiKeyCipher`）在读取时整体作废，必须重配（D20）：
 * 白名单换了，旧端点对应的 provider 无法可靠映射到 catalog。
 */
export interface CloudConfigRecord {
  providerId: string
  model: string
  credentialCipher: string
  updatedAt: number
  /** OAuth 刷新等仅更新凭证的时间戳；与 `updatedAt` 分离，避免触发 AgentManager 重建 */
  credentialUpdatedAt?: number
}

/** 旧记录形态（只用于识别并丢弃） */
function isLegacyConfigRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.provider === 'string' || typeof record.apiUrl === 'string'
}

export interface UnitRecord {
  unitId: string
  deviceId: string
  workspacePath: string
  /** 创建该工作单元时绑定的授权 ID，用于约束 sameUnit 后续派单边界 */
  authorizationId?: string
  /** device 侧维护的 worktree 台账回执，用于 Git 视图与回收 */
  worktreePath?: string
  branch?: string
  createdAt: number
  /** 已回收（设备回执后落盘）；脏树保留时保持 null */
  closedAt: number | null
  /** 已发出回收请求、还没收到设备回执（防止 UI 提前显示“已回收”） */
  closeRequestedAt?: number
  /** 最近一次回收因脏树被拒的时间；UI 标「待清理」 */
  dirtyAt?: number
}

interface AccountsFile {
  account: AccountRecord | null
}

interface DevicesFile {
  devices: DeviceRecord[]
}

interface PairingFile {
  codes: PairingCodeRecord[]
}

interface TasksFile {
  tasks: CloudTaskSnapshot[]
}

interface UnitsFile {
  units: UnitRecord[]
}

interface ConfigFile {
  config: CloudConfigRecord | null
}

interface AuthorizationsFile {
  items: AuthorizationRecord[]
}

interface ClientStateFile {
  /** 最后一个客户端断开连接的时间；重连快照据此生成「你离开期间…」汇总（F-51 / A-23） */
  lastClientLeftAt: number | null
  /** 服务端记录的最后已读游标（F-52 / C-03c） */
  lastReadSeq?: number
  /** 最后标记已读的时间戳（服务端重启 seq 归零后用于兜底计算未读） */
  lastReadAt?: number | null
}

const ACTIVE_TASK_STATUSES = new Set(['queued', 'assigned', 'running', 'waiting_human'])
const KV_ACCOUNT = 'account'
const KV_CONFIG = 'cloud_config'
const KV_CLIENT_STATE = 'client_state'
const KV_MIGRATED = 'legacy_json_migrated'

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000

function parseJsonSafe<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

export class CloudStore {
  private closed = false
  private accountCache: AccountRecord | null
  private devicesCache: DeviceRecord[]
  private pairingCache: PairingCodeRecord[]
  private tasksCache: CloudTaskSnapshot[]
  private unitsCache: UnitRecord[]
  private configCache: unknown
  private authorizationsCache: AuthorizationRecord[]
  private clientStateCache: ClientStateFile

  private constructor(
    private readonly db: SqliteDatabaseSync,
    initial: {
      account: AccountRecord | null
      devices: DeviceRecord[]
      pairing: PairingCodeRecord[]
      tasks: CloudTaskSnapshot[]
      units: UnitRecord[]
      config: unknown
      authorizations: AuthorizationRecord[]
      clientState: ClientStateFile
    }
  ) {
    this.accountCache = initial.account
    this.devicesCache = initial.devices
    this.pairingCache = initial.pairing
    this.tasksCache = initial.tasks
    this.unitsCache = initial.units
    this.configCache = initial.config
    this.authorizationsCache = initial.authorizations
    this.clientStateCache = initial.clientState
  }

  static async open(dataDir: string): Promise<CloudStore> {
    await fs.mkdir(dataDir, { recursive: true })
    const dbPath = path.join(dataDir, 'cloud.db')
    const db = openSqliteDatabase(dbPath)
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS kv_state (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          data_json TEXT NOT NULL,
          revoked_at INTEGER,
          last_seen_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pairing_codes (
          hash TEXT PRIMARY KEY,
          data_json TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS authorizations (
          id TEXT PRIMARY KEY,
          data_json TEXT NOT NULL,
          confirmed_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          status TEXT NOT NULL,
          idempotency_key TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          data_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_device_status
          ON tasks(device_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_idempotency
          ON tasks(idempotency_key);

        CREATE TABLE IF NOT EXISTS task_diffs (
          task_id TEXT PRIMARY KEY,
          diff_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS units (
          unit_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          closed_at INTEGER,
          created_at INTEGER NOT NULL,
          data_json TEXT NOT NULL
        );
      `)

      await CloudStore.migrateLegacyJsonIfNeeded(db, dataDir)

      const kvStmt = db.prepare('SELECT value_json FROM kv_state WHERE key = ?')
      const accountRow = kvStmt.get(KV_ACCOUNT) as { value_json?: string } | undefined
      const configRow = kvStmt.get(KV_CONFIG) as { value_json?: string } | undefined
      const clientRow = kvStmt.get(KV_CLIENT_STATE) as { value_json?: string } | undefined

      const devices = (db.prepare('SELECT data_json FROM devices').all() as Array<{ data_json: string }>)
        .map((row) => parseJsonSafe<DeviceRecord | null>(row.data_json, null))
        .filter((item): item is DeviceRecord => item !== null)

      const pairing = (
        db.prepare('SELECT data_json FROM pairing_codes').all() as Array<{ data_json: string }>
      )
        .map((row) => parseJsonSafe<PairingCodeRecord | null>(row.data_json, null))
        .filter((item): item is PairingCodeRecord => item !== null)

      const tasks = (
        db.prepare('SELECT data_json FROM tasks ORDER BY created_at ASC').all() as Array<{
          data_json: string
        }>
      )
        .map((row) => parseJsonSafe<CloudTaskSnapshot | null>(row.data_json, null))
        .filter((item): item is CloudTaskSnapshot => item !== null)

      const units = (
        db.prepare('SELECT data_json FROM units ORDER BY created_at ASC').all() as Array<{
          data_json: string
        }>
      )
        .map((row) => parseJsonSafe<UnitRecord | null>(row.data_json, null))
        .filter((item): item is UnitRecord => item !== null)

      const authorizations = (
        db.prepare('SELECT data_json FROM authorizations').all() as Array<{ data_json: string }>
      )
        .map((row) => parseJsonSafe<AuthorizationRecord | null>(row.data_json, null))
        .filter((item): item is AuthorizationRecord => item !== null)

      return new CloudStore(db, {
        account: parseJsonSafe<AccountRecord | null>(accountRow?.value_json, null),
        devices,
        pairing,
        tasks,
        units,
        config: parseJsonSafe<unknown>(configRow?.value_json, null),
        authorizations,
        clientState: parseJsonSafe<ClientStateFile>(clientRow?.value_json, {
          lastClientLeftAt: null,
        }),
      })
    } catch (error) {
      try {
        db.close()
      } catch {
        // ignore close failure
      }
      throw error
    }
  }

  /**
   * 首次升级自动把旧 `*.json` 与 `task-diffs/*.json` 一次性导入 SQLite，保留原文件作回滚备份。
   * 必须用 INSERT OR IGNORE，确保不覆盖库内已存在的新数据。
   */
  private static async migrateLegacyJsonIfNeeded(
    db: SqliteDatabaseSync,
    dataDir: string
  ): Promise<void> {
    const marker = db.prepare('SELECT 1 FROM kv_state WHERE key = ?').get(KV_MIGRATED)
    if (marker) return

    const file = (name: string) => path.join(dataDir, name)
    const legacyPaths = [
      file('accounts.json'),
      file('devices.json'),
      file('pairing.json'),
      file('tasks.json'),
      file('units.json'),
      file('config.json'),
      file('authorizations.json'),
      file('client-state.json'),
    ]
    const diffsDir = file('task-diffs')

    const checks = await Promise.all([...legacyPaths.map(fileExists), fileExists(diffsDir)])
    const hasAnyLegacy = checks.some(Boolean)

    if (!hasAnyLegacy) {
      db.prepare('INSERT OR IGNORE INTO kv_state (key, value_json, updated_at) VALUES (?, ?, ?)').run(
        KV_MIGRATED,
        JSON.stringify({ migratedAt: Date.now(), hadLegacyFiles: false }),
        Date.now()
      )
      return
    }

    const [
      accountsDoc,
      devicesDoc,
      pairingDoc,
      tasksDoc,
      unitsDoc,
      configDoc,
      authsDoc,
      clientStateDoc,
    ] = await Promise.all([
      readJson<AccountsFile>(file('accounts.json'), { account: null }),
      readJson<DevicesFile>(file('devices.json'), { devices: [] }),
      readJson<PairingFile>(file('pairing.json'), { codes: [] }),
      readJson<TasksFile>(file('tasks.json'), { tasks: [] }),
      readJson<UnitsFile>(file('units.json'), { units: [] }),
      readJson<ConfigFile>(file('config.json'), { config: null }),
      readJson<AuthorizationsFile>(file('authorizations.json'), { items: [] }),
      readJson<ClientStateFile>(file('client-state.json'), { lastClientLeftAt: null }),
    ])

    const legacyDiffs: Array<{ taskId: string; diff: NonNullable<CloudTaskResult['diff']> }> = []
    if (checks[checks.length - 1]) {
      try {
        const entries = await fs.readdir(diffsDir)
        for (const entry of entries) {
          if (!entry.endsWith('.json')) continue
          const taskId = entry.slice(0, -5)
          if (!/^[A-Za-z0-9._-]+$/.test(taskId)) continue
          const diff = await readJson<NonNullable<CloudTaskResult['diff']> | null>(
            path.join(diffsDir, entry),
            null
          )
          if (diff && typeof diff.excerpt === 'string' && typeof diff.bytes === 'number') {
            legacyDiffs.push({ taskId, diff })
          }
        }
      } catch {
        // ignore unreadable legacy diff directory
      }
    }

    const now = Date.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      const insertKv = db.prepare(
        'INSERT OR IGNORE INTO kv_state (key, value_json, updated_at) VALUES (?, ?, ?)'
      )
      if (accountsDoc?.account) {
        insertKv.run(KV_ACCOUNT, JSON.stringify(accountsDoc.account), now)
      }
      if (configDoc?.config !== undefined && configDoc?.config !== null) {
        insertKv.run(KV_CONFIG, JSON.stringify(configDoc.config), now)
      }
      if (clientStateDoc && typeof clientStateDoc === 'object') {
        insertKv.run(KV_CLIENT_STATE, JSON.stringify(clientStateDoc), now)
      }

      const insertDevice = db.prepare(
        'INSERT OR IGNORE INTO devices (id, data_json, revoked_at, last_seen_at) VALUES (?, ?, ?, ?)'
      )
      for (const device of devicesDoc?.devices ?? []) {
        if (!device?.id) continue
        insertDevice.run(
          device.id,
          JSON.stringify(device),
          device.revokedAt ?? null,
          device.lastSeenAt ?? now
        )
      }

      const insertPairing = db.prepare(
        'INSERT OR IGNORE INTO pairing_codes (hash, data_json, expires_at, used_at) VALUES (?, ?, ?, ?)'
      )
      for (const code of pairingDoc?.codes ?? []) {
        if (!code?.hash) continue
        insertPairing.run(
          code.hash,
          JSON.stringify(code),
          code.expiresAt ?? now,
          code.usedAt ?? null
        )
      }

      const insertAuth = db.prepare(
        'INSERT OR IGNORE INTO authorizations (id, data_json, confirmed_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)'
      )
      for (const auth of authsDoc?.items ?? []) {
        if (!auth?.id) continue
        insertAuth.run(
          auth.id,
          JSON.stringify(auth),
          auth.confirmedAt ?? now,
          auth.expiresAt ?? now,
          auth.revokedAt ?? null
        )
      }

      const insertTask = db.prepare(
        'INSERT OR IGNORE INTO tasks (id, device_id, status, idempotency_key, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      const insertDiff = db.prepare(
        'INSERT OR IGNORE INTO task_diffs (task_id, diff_json, updated_at) VALUES (?, ?, ?)'
      )
      for (const rawTask of tasksDoc?.tasks ?? []) {
        if (!rawTask?.id) continue
        let task = rawTask
        if (rawTask.progress?.diff) {
          insertDiff.run(rawTask.id, JSON.stringify(rawTask.progress.diff), now)
          const { diff: _stripped, ...restProgress } = rawTask.progress
          task = { ...rawTask, progress: restProgress }
        }
        insertTask.run(
          task.id,
          task.spec?.deviceId ?? '',
          task.status ?? 'queued',
          task.idempotencyKey ?? null,
          task.createdAt ?? now,
          task.updatedAt ?? now,
          JSON.stringify(task)
        )
      }

      for (const item of legacyDiffs) {
        insertDiff.run(item.taskId, JSON.stringify(item.diff), now)
      }

      const insertUnit = db.prepare(
        'INSERT OR IGNORE INTO units (unit_id, device_id, closed_at, created_at, data_json) VALUES (?, ?, ?, ?, ?)'
      )
      for (const unit of unitsDoc?.units ?? []) {
        if (!unit?.unitId) continue
        insertUnit.run(
          unit.unitId,
          unit.deviceId ?? '',
          unit.closedAt ?? null,
          unit.createdAt ?? now,
          JSON.stringify(unit)
        )
      }

      insertKv.run(
        KV_MIGRATED,
        JSON.stringify({ migratedAt: now, hadLegacyFiles: true }),
        now
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  private runTransaction<T>(fn: () => T): T {
    if (this.closed) throw new Error('CloudStore is closed')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // ignore rollback error
      }
      throw error
    }
  }

  private upsertKv(key: string, value: unknown, now = Date.now()): void {
    this.db
      .prepare(
        'INSERT INTO kv_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at'
      )
      .run(key, JSON.stringify(value), now)
  }

  // ------------------------------ 账号 ------------------------------

  getAccount(): AccountRecord | null {
    return this.accountCache
  }

  /**
   * 创建管理员账号：只允许创建一次。
   * 判重与写入在同一次 SQLite 事务里完成，并发请求只有一个成功。
   */
  async createAccount(record: AccountRecord): Promise<boolean> {
    if (this.accountCache) return false
    const created = this.runTransaction(() => {
      if (this.accountCache) return false
      this.upsertKv(KV_ACCOUNT, record)
      return true
    })
    if (created) this.accountCache = record
    return created
  }

  async updateAccount(record: AccountRecord): Promise<void> {
    this.runTransaction(() => {
      this.upsertKv(KV_ACCOUNT, record)
    })
    this.accountCache = record
  }

  getSessionVersion(): number {
    return this.accountCache?.sessionVersion ?? 1
  }

  /** 递增管理员会话版本号，使旧的签名 Cookie 立即作废 */
  async bumpSessionVersion(): Promise<number> {
    if (!this.accountCache) return 1
    const nextVersion = (this.accountCache.sessionVersion ?? 1) + 1
    const nextAccount: AccountRecord = {
      ...this.accountCache,
      sessionVersion: nextVersion,
      updatedAt: Date.now(),
    }
    this.runTransaction(() => {
      this.upsertKv(KV_ACCOUNT, nextAccount)
    })
    this.accountCache = nextAccount
    return nextVersion
  }

  // ------------------------------ 设备 ------------------------------

  listDevices(options?: { includeRevoked?: boolean }): DeviceRecord[] {
    if (options?.includeRevoked) return this.devicesCache
    return this.devicesCache.filter((device) => device.revokedAt === null)
  }

  findDevice(id: string): DeviceRecord | undefined {
    return this.devicesCache.find((device) => device.id === id)
  }

  findDeviceByToken(token: string): DeviceRecord | undefined {
    return this.devicesCache.find((device) =>
      device.revokedAt ? false : verifyToken(token, device.token)
    )
  }

  /**
   * 桌面控制面鉴权：只认独立签发的 `clientToken`，严格拒绝仅限执行通道的设备 `token`；
   * 未分离 `clientToken` 的旧配对记录必须重新配对，绝不回退执行通道 token。
   */
  findDeviceByClientToken(token: string): DeviceRecord | undefined {
    return this.devicesCache.find((device) => {
      if (device.revokedAt || !device.clientToken) return false
      return verifyToken(token, device.clientToken)
    })
  }

  async addDevice(record: DeviceRecord): Promise<void> {
    this.runTransaction(() => {
      this.db
        .prepare(
          'INSERT INTO devices (id, data_json, revoked_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, revoked_at = excluded.revoked_at, last_seen_at = excluded.last_seen_at'
        )
        .run(record.id, JSON.stringify(record), record.revokedAt ?? null, record.lastSeenAt)
    })
    this.devicesCache = [...this.devicesCache.filter((item) => item.id !== record.id), record]
  }

  async updateDevice(id: string, patch: Partial<DeviceRecord>): Promise<DeviceRecord | null> {
    const existing = this.devicesCache.find((device) => device.id === id)
    if (!existing) return null
    const updated: DeviceRecord = { ...existing, ...patch }
    this.runTransaction(() => {
      this.db
        .prepare('UPDATE devices SET data_json = ?, revoked_at = ?, last_seen_at = ? WHERE id = ?')
        .run(JSON.stringify(updated), updated.revokedAt ?? null, updated.lastSeenAt, id)
    })
    this.devicesCache = this.devicesCache.map((device) => (device.id === id ? updated : device))
    return updated
  }

  async revokeAllDevices(now = Date.now()): Promise<void> {
    const next = this.devicesCache.map((device) => ({ ...device, revokedAt: now }))
    this.runTransaction(() => {
      const stmt = this.db.prepare('UPDATE devices SET data_json = ?, revoked_at = ? WHERE id = ?')
      for (const device of next) {
        stmt.run(JSON.stringify(device), now, device.id)
      }
    })
    this.devicesCache = next
  }

  // ------------------------------ 配对码 ------------------------------

  async issuePairingCode(input: { codeHash: string; salt: string; now?: number }): Promise<void> {
    const now = input.now ?? Date.now()
    const record: PairingCodeRecord = {
      hash: input.codeHash,
      salt: input.salt,
      createdAt: now,
      expiresAt: now + PAIRING_CODE_TTL_MS,
      usedAt: null,
    }
    this.runTransaction(() => {
      this.db
        .prepare('DELETE FROM pairing_codes WHERE used_at IS NOT NULL OR expires_at <= ?')
        .run(now)
      this.db
        .prepare(
          'INSERT OR REPLACE INTO pairing_codes (hash, data_json, expires_at, used_at) VALUES (?, ?, ?, ?)'
        )
        .run(record.hash, JSON.stringify(record), record.expiresAt, null)
    })
    this.pairingCache = [
      ...this.pairingCache.filter((code) => !code.usedAt && code.expiresAt > now),
      record,
    ]
  }

  /**
   * 消费配对码：TTL + 一次性（事务内 CAS 写 usedAt）。
   * 返回码记录或 null；null 时不区分「不存在 / 已过期 / 已用过」。
   */
  async consumePairingCode(
    candidateHash: string,
    now = Date.now()
  ): Promise<PairingCodeRecord | null> {
    let matched: PairingCodeRecord | null = null
    for (const code of this.pairingCache) {
      if (code.usedAt || code.expiresAt <= now) continue
      if (!constantTimeStringEqual(code.hash, candidateHash)) continue
      matched = { ...code, usedAt: now }
      break
    }
    if (!matched) return null
    const consumed = matched
    this.runTransaction(() => {
      this.db
        .prepare('UPDATE pairing_codes SET data_json = ?, used_at = ? WHERE hash = ?')
        .run(JSON.stringify(consumed), now, consumed.hash)
    })
    this.pairingCache = this.pairingCache.map((code) =>
      code.hash === consumed.hash ? consumed : code
    )
    return consumed
  }

  listPairingCodes(now = Date.now()): PairingCodeRecord[] {
    return this.pairingCache.filter((code) => !code.usedAt && code.expiresAt > now)
  }

  // ------------------------------ 工单 ------------------------------

  listTasks(): CloudTaskSnapshot[] {
    return this.tasksCache
  }

  findTask(id: string): CloudTaskSnapshot | undefined {
    return this.tasksCache.find((task) => task.id === id)
  }

  /** 将脱敏 diff 单独存盘到 task_diffs 表，避免把大体积 diff 塞进 tasks 行与前端快照 */
  async saveTaskDiff(
    taskId: string,
    diff: NonNullable<CloudTaskResult['diff']>
  ): Promise<void> {
    if (!/^[A-Za-z0-9._-]+$/.test(taskId)) return
    const now = Date.now()
    this.runTransaction(() => {
      this.db
        .prepare(
          'INSERT INTO task_diffs (task_id, diff_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET diff_json = excluded.diff_json, updated_at = excluded.updated_at'
        )
        .run(taskId, JSON.stringify(diff), now)
    })
  }

  async loadTaskDiff(taskId: string): Promise<NonNullable<CloudTaskResult['diff']> | undefined> {
    if (this.closed || !/^[A-Za-z0-9._-]+$/.test(taskId)) return undefined
    const row = this.db
      .prepare('SELECT diff_json FROM task_diffs WHERE task_id = ?')
      .get(taskId) as { diff_json?: string } | undefined
    if (!row?.diff_json) return undefined
    const parsed = parseJsonSafe<NonNullable<CloudTaskResult['diff']> | null>(row.diff_json, null)
    if (parsed && typeof parsed.excerpt === 'string' && typeof parsed.bytes === 'number') {
      return parsed
    }
    return undefined
  }

  async saveTask(task: CloudTaskSnapshot): Promise<void> {
    // 强制剥离大体积 diff 正文并转存独立 task_diffs 表，杜绝写入放大与前端快照泄漏
    const inlineDiff = task.progress.diff
    let storedTask = task
    if (inlineDiff) {
      const { diff: _stripped, ...restProgress } = task.progress
      storedTask = { ...task, progress: restProgress }
    }

    const nextAll = [...this.tasksCache.filter((item) => item.id !== storedTask.id), storedTask]
    let prunedList = nextAll
    const evictedIds: string[] = []
    // 控制终态工单历史上限，防止数据库与 snapshot 无限膨胀
    if (nextAll.length > 250) {
      const active = nextAll.filter((t) => ACTIVE_TASK_STATUSES.has(t.status))
      const terminalSorted = nextAll
        .filter((t) => !ACTIVE_TASK_STATUSES.has(t.status))
        .sort((a, b) => b.updatedAt - a.updatedAt)
      const keptTerminal = terminalSorted.slice(0, 200)
      for (const removed of terminalSorted.slice(200)) {
        evictedIds.push(removed.id)
      }
      prunedList = [...keptTerminal, ...active]
    }

    const now = Date.now()
    this.runTransaction(() => {
      if (inlineDiff && /^[A-Za-z0-9._-]+$/.test(storedTask.id)) {
        this.db
          .prepare(
            'INSERT INTO task_diffs (task_id, diff_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET diff_json = excluded.diff_json, updated_at = excluded.updated_at'
          )
          .run(storedTask.id, JSON.stringify(inlineDiff), now)
      }
      this.db
        .prepare(
          'INSERT INTO tasks (id, device_id, status, idempotency_key, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id, status = excluded.status, idempotency_key = excluded.idempotency_key, created_at = excluded.created_at, updated_at = excluded.updated_at, data_json = excluded.data_json'
        )
        .run(
          storedTask.id,
          storedTask.spec.deviceId,
          storedTask.status,
          storedTask.idempotencyKey ?? null,
          storedTask.createdAt,
          storedTask.updatedAt,
          JSON.stringify(storedTask)
        )
      if (evictedIds.length > 0) {
        const delTask = this.db.prepare('DELETE FROM tasks WHERE id = ?')
        const delDiff = this.db.prepare('DELETE FROM task_diffs WHERE task_id = ?')
        for (const id of evictedIds) {
          delTask.run(id)
          delDiff.run(id)
        }
      }
    })
    this.tasksCache = prunedList
  }

  /** 同一设备上的待执行工单按入队顺序（FIFO） */
  queuedTasksFor(deviceId: string): CloudTaskSnapshot[] {
    return this.tasksCache
      .filter((task) => task.spec.deviceId === deviceId && task.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  // ------------------------------ 工作单元 ------------------------------

  listUnits(): UnitRecord[] {
    return this.unitsCache
  }

  findUnit(unitId: string): UnitRecord | undefined {
    return this.unitsCache.find((unit) => unit.unitId === unitId)
  }

  async saveUnit(unit: UnitRecord): Promise<void> {
    this.runTransaction(() => {
      this.db
        .prepare(
          'INSERT INTO units (unit_id, device_id, closed_at, created_at, data_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(unit_id) DO UPDATE SET device_id = excluded.device_id, closed_at = excluded.closed_at, created_at = excluded.created_at, data_json = excluded.data_json'
        )
        .run(
          unit.unitId,
          unit.deviceId,
          unit.closedAt ?? null,
          unit.createdAt,
          JSON.stringify(unit)
        )
    })
    this.unitsCache = [...this.unitsCache.filter((item) => item.unitId !== unit.unitId), unit]
  }

  /** 在事务内增量修改单元，避免并发帧（如 task_worktree vs unit_closed）互相覆写 closedAt */
  async patchUnit(
    unitId: string,
    mutate: (unit: UnitRecord) => UnitRecord
  ): Promise<UnitRecord | undefined> {
    const existing = this.unitsCache.find((unit) => unit.unitId === unitId)
    if (!existing) return undefined
    const updated = mutate(existing)
    this.runTransaction(() => {
      this.db
        .prepare('UPDATE units SET device_id = ?, closed_at = ?, data_json = ? WHERE unit_id = ?')
        .run(updated.deviceId, updated.closedAt ?? null, JSON.stringify(updated), unitId)
    })
    this.unitsCache = this.unitsCache.map((unit) => (unit.unitId === unitId ? updated : unit))
    return updated
  }

  /**
   * 设备回执：`dirty` 时不写 `closedAt`（保留 = 还要用户处理），只记 `dirtyAt`；
   * 带 `error` 的回执也不能写：删树失败却标已回收，就是“云端说回收了、磁盘还在”。
   */
  async settleUnitClose(
    unitId: string,
    input: {
      removed: boolean
      dirty: boolean
      worktreePath?: string
      branch?: string
      error?: string
    },
    now = Date.now()
  ): Promise<void> {
    const failed = Boolean(input.error)
    await this.patchUnit(unitId, (unit) => {
      const next: UnitRecord = { ...unit }
      delete next.closeRequestedAt
      if (input.worktreePath) next.worktreePath = input.worktreePath
      if (input.branch) next.branch = input.branch
      if (failed) return next
      if (input.dirty) {
        next.dirtyAt = now
        next.closedAt = unit.closedAt
      } else {
        next.dirtyAt = undefined
        next.closedAt = unit.closedAt ?? now
      }
      return next
    })
  }

  // ------------------------------ 云端配置 ------------------------------

  getCloudConfig(): CloudConfigRecord | null {
    const stored = this.configCache
    // 旧配置整体丢弃：不返回、不迁移，UI 看到的是「未配置」（D20）
    if (isLegacyConfigRecord(stored)) return null
    return stored as CloudConfigRecord | null
  }

  async saveCloudConfig(record: CloudConfigRecord): Promise<void> {
    const prev = this.configCache as { updatedAt?: number } | null
    const prevStamp = typeof prev?.updatedAt === 'number' ? prev.updatedAt : 0
    // 保证相邻两次保存的时间戳严格递增：SQLite 写入在亚毫秒内完成，相同 ms 会被轮换逻辑误判为同一份配置
    const nextRecord: CloudConfigRecord =
      record.updatedAt <= prevStamp
        ? { ...record, updatedAt: prevStamp + 1 }
        : record
    this.runTransaction(() => {
      this.upsertKv(KV_CONFIG, nextRecord)
    })
    this.configCache = nextRecord
  }

  async clearCloudConfig(): Promise<void> {
    this.runTransaction(() => {
      this.upsertKv(KV_CONFIG, null)
    })
    this.configCache = null
  }

  /** 只换凭证，保留 provider / 模型（OAuth 刷新走此路径；绝不改 updatedAt，否则会触发 AgentManager 无谓重建） */
  async saveCloudCredential(providerId: string, credentialCipher: string): Promise<void> {
    const record = this.getCloudConfig()
    if (!record || record.providerId !== providerId) return
    const next: CloudConfigRecord = {
      ...record,
      credentialCipher,
      credentialUpdatedAt: Date.now(),
    }
    this.runTransaction(() => {
      this.upsertKv(KV_CONFIG, next)
    })
    this.configCache = next
  }

  // ------------------------------ 方案授权 ------------------------------

  listAuthorizations(): AuthorizationRecord[] {
    return this.authorizationsCache
  }

  findAuthorization(id: string): AuthorizationRecord | undefined {
    return this.authorizationsCache.find((item) => item.id === id)
  }

  /** 当前仍有效的授权（未撤销、未过期），按确认时间倒序 */
  activeAuthorizations(now = Date.now()): AuthorizationRecord[] {
    return this.authorizationsCache
      .filter((item) => !item.revokedAt && item.expiresAt > now)
      .sort((a, b) => b.confirmedAt - a.confirmedAt)
  }

  /** 在事务内原子执行授权校验与扣减，避免并发 dispatch 绕过配额（TOCTOU） */
  async updateAuthorization(
    id: string,
    mutate: (current: AuthorizationRecord | undefined) => AuthorizationRecord | undefined
  ): Promise<AuthorizationRecord | undefined> {
    const existing = this.authorizationsCache.find((item) => item.id === id)
    const next = mutate(existing)
    if (!next) return undefined
    this.runTransaction(() => {
      this.db
        .prepare(
          'INSERT INTO authorizations (id, data_json, confirmed_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, confirmed_at = excluded.confirmed_at, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at'
        )
        .run(
          next.id,
          JSON.stringify(next),
          next.confirmedAt,
          next.expiresAt,
          next.revokedAt ?? null
        )
    })
    this.authorizationsCache = [
      ...this.authorizationsCache.filter((item) => item.id !== id),
      next,
    ]
    return next
  }

  async saveAuthorization(record: AuthorizationRecord): Promise<void> {
    this.runTransaction(() => {
      this.db
        .prepare(
          'INSERT INTO authorizations (id, data_json, confirmed_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, confirmed_at = excluded.confirmed_at, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at'
        )
        .run(
          record.id,
          JSON.stringify(record),
          record.confirmedAt,
          record.expiresAt,
          record.revokedAt ?? null
        )
    })
    this.authorizationsCache = [
      ...this.authorizationsCache.filter((item) => item.id !== record.id),
      record,
    ]
  }

  async revokeAuthorization(id: string, now = Date.now()): Promise<void> {
    const existing = this.authorizationsCache.find((item) => item.id === id)
    if (!existing) return
    const next: AuthorizationRecord = { ...existing, revokedAt: existing.revokedAt ?? now }
    this.runTransaction(() => {
      this.db
        .prepare('UPDATE authorizations SET data_json = ?, revoked_at = ? WHERE id = ?')
        .run(JSON.stringify(next), next.revokedAt ?? now, id)
    })
    this.authorizationsCache = this.authorizationsCache.map((item) =>
      item.id === id ? next : item
    )
  }

  // ------------------------------ 客户端离线游标（F-51） ------------------------------

  getLastClientLeftAt(): number | null {
    return this.clientStateCache.lastClientLeftAt
  }

  async setLastClientLeftAt(at: number | null): Promise<void> {
    if (this.clientStateCache.lastClientLeftAt === at) return
    const next: ClientStateFile = { ...this.clientStateCache, lastClientLeftAt: at }
    this.runTransaction(() => {
      this.upsertKv(KV_CLIENT_STATE, next)
    })
    this.clientStateCache = next
  }

  getReadState(): { lastReadSeq: number; lastReadAt: number | null } {
    const state = this.clientStateCache
    return {
      lastReadSeq:
        typeof state.lastReadSeq === 'number' &&
        Number.isFinite(state.lastReadSeq) &&
        state.lastReadSeq > 0
          ? Math.floor(state.lastReadSeq)
          : 0,
      lastReadAt:
        typeof state.lastReadAt === 'number' && Number.isFinite(state.lastReadAt)
          ? state.lastReadAt
          : null,
    }
  }

  async setReadState(lastReadSeq: number, lastReadAt: number): Promise<void> {
    const normalizedSeq = Math.max(0, Math.floor(lastReadSeq))
    const next: ClientStateFile = {
      ...this.clientStateCache,
      lastReadSeq: normalizedSeq,
      lastReadAt,
    }
    this.runTransaction(() => {
      this.upsertKv(KV_CLIENT_STATE, next)
    })
    this.clientStateCache = next
  }

  /** 退出流程用：主动触发 WAL checkpoint 确保变更落主库文件 */
  async flush(): Promise<void> {
    if (this.closed) return
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    } catch {
      // ignore checkpoint failure on shutdown
    }
  }

  /** 关闭 SQLite 句柄（幂等；必须先 checkpoint 再关闭以释放 WAL/SHM 文件锁） */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // ignore
    }
    try {
      this.db.close()
    } catch {
      // ignore
    }
  }
}
