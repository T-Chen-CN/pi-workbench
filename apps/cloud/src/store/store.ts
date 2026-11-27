/**
 * 云端持久化：账号、设备、配对码、工单、工单 diff、工作单元、云端配置、客户端游标、记忆与梦境。
 *
 * 使用 Node 24 内置 `node:sqlite`（`cloud.db`，WAL 模式 + `PRAGMA user_version` 版本化迁移 + 预编译语句缓存），
 * 所有读写直查 SQLite（无全表 JS 数组副本），支持 `SAVEPOINT` 嵌套事务与 SQL 级原子 CAS。
 * 首次在旧目录启动时自动将历史 `*.json` 与 `task-diffs/*.json` 一次性迁移入库（保留原文件作备份）。
 * 会话 JSONL 不在这里——那是 SDK 的 `agentDir/sessions`，也是唯一真相源（F-42）。
 */

import { timingSafeEqual } from 'crypto'
import { promises as fs } from 'fs'
import { createRequire } from 'module'
import * as path from 'path'
import type {
  DatabaseSync as SqliteDatabaseSync,
  StatementSync as SqliteStatementSync,
} from 'node:sqlite'
import type {
  CloudWorkspaceInfo,
  CloudTaskResult,
  CloudTaskSnapshot,
} from 'pi-bridge'
import { readJson } from './atomic.js'
import { extractTokenKid, verifyToken, type TokenHash } from '../auth/credentials.js'
import type { AuthorizationRecord } from '../tasks/authorization.js'
import type {
  CloudDreamRecord,
  CloudMemoryItem,
  CloudMemoryKind,
  CloudMemorySource,
} from '../memory/memory-store.js'

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

/**
 * 云端 MCP 服务器持久化记录；`configCipher` 是 AES-256-GCM 密文（完整 `McpServerConfig` JSON），
 * `env`、`headers`、`command`/`args`/`cwd`、`url` 均不以明文落入 `cloud.db`。
 */
export interface CloudMcpServerRecord {
  id: string
  name: string
  transport: string
  enabled: boolean
  configCipher: string
  updatedAt: number
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

export const CLOUD_DB_SCHEMA_VERSION = 3
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000
export const MAX_ACTIVE_PAIRING_CODES = 5
export const MAX_CLOSED_UNITS_RETENTION = 500
export const MAX_EXPIRED_AUTHORIZATIONS_RETENTION = 500
const MAX_STORED_TASKS_THRESHOLD = 250
const MAX_KEPT_TERMINAL_TASKS = 200
const MAX_STORED_DREAMS = 50

const KV_ACCOUNT = 'account'
const KV_CONFIG = 'cloud_config'
const KV_CLIENT_STATE = 'client_state'
const KV_MIGRATED = 'legacy_json_migrated'
const KV_TASK_SEQ = 'task_seq'

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

function readSchemaVersion(db: SqliteDatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return Number(row?.user_version ?? 0)
}

function parseTaskNumericId(taskId: string): number {
  const match = /^T-(\d+)$/.exec(taskId)
  if (!match) return 0
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) && value > 0 ? value : 0
}

interface MemoryDbRow {
  id: string
  kind: string
  content: string
  tags_json: string
  source: string
  pinned: number
  created_at: number
  updated_at: number
}

interface DreamDbRow {
  id: string
  at: number
  trigger: string
  summary: string
  added: number
  merged: number
  removed: number
}

interface McpServerDbRow {
  id: string
  name: string
  transport: string
  enabled: number
  config_cipher: string
  updated_at: number
}

function rowToMcpServerRecord(row: McpServerDbRow): CloudMcpServerRecord {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    enabled: Boolean(row.enabled),
    configCipher: row.config_cipher,
    updatedAt: row.updated_at,
  }
}

function rowToMemoryItem(row: MemoryDbRow): CloudMemoryItem {
  return {
    id: row.id,
    kind: row.kind as CloudMemoryKind,
    content: row.content,
    tags: parseJsonSafe<string[]>(row.tags_json, []),
    source: row.source as CloudMemorySource,
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToDreamRecord(row: DreamDbRow): CloudDreamRecord {
  return {
    id: row.id,
    at: row.at,
    trigger: row.trigger === 'idle' ? 'idle' : 'manual',
    summary: row.summary,
    added: row.added,
    merged: row.merged,
    removed: row.removed,
  }
}

interface PreparedStatements {
  getKv: SqliteStatementSync
  upsertKv: SqliteStatementSync
  insertKvIfAbsent: SqliteStatementSync

  listDevicesAll: SqliteStatementSync
  listDevicesActive: SqliteStatementSync
  getDevice: SqliteStatementSync
  findDevicesByTokenKid: SqliteStatementSync
  findDevicesWithoutTokenKid: SqliteStatementSync
  findDevicesByClientTokenKid: SqliteStatementSync
  findDevicesWithoutClientTokenKid: SqliteStatementSync
  upsertDevice: SqliteStatementSync
  updateDevice: SqliteStatementSync

  deleteStalePairingCodes: SqliteStatementSync
  upsertPairingCode: SqliteStatementSync
  listActivePairingCodes: SqliteStatementSync
  deletePairingCodeByHash: SqliteStatementSync
  consumePairingCodeCas: SqliteStatementSync

  listTasks: SqliteStatementSync
  getTask: SqliteStatementSync
  findTaskByIdempotencyKey: SqliteStatementSync
  listQueuedTasksForDevice: SqliteStatementSync
  countTasks: SqliteStatementSync
  selectEvictableTerminalTasks: SqliteStatementSync
  upsertTask: SqliteStatementSync
  deleteTask: SqliteStatementSync
  upsertTaskDiff: SqliteStatementSync
  getTaskDiff: SqliteStatementSync
  deleteTaskDiff: SqliteStatementSync

  listUnits: SqliteStatementSync
  getUnit: SqliteStatementSync
  upsertUnit: SqliteStatementSync
  updateUnit: SqliteStatementSync
  pruneClosedUnits: SqliteStatementSync

  listAuthorizations: SqliteStatementSync
  getAuthorization: SqliteStatementSync
  listActiveAuthorizations: SqliteStatementSync
  upsertAuthorization: SqliteStatementSync
  revokeAuthorization: SqliteStatementSync
  pruneExpiredAuthorizations: SqliteStatementSync

  listMemories: SqliteStatementSync
  getMemory: SqliteStatementSync
  countMemories: SqliteStatementSync
  upsertMemory: SqliteStatementSync
  deleteMemory: SqliteStatementSync
  clearMemories: SqliteStatementSync

  listDreams: SqliteStatementSync
  countDreams: SqliteStatementSync
  maxDreamAt: SqliteStatementSync
  insertDream: SqliteStatementSync
  pruneDreams: SqliteStatementSync

  listMcpServers: SqliteStatementSync
  getMcpServer: SqliteStatementSync
  upsertMcpServer: SqliteStatementSync
  deleteMcpServer: SqliteStatementSync
}

function prepareAllStatements(db: SqliteDatabaseSync): PreparedStatements {
  return {
    getKv: db.prepare('SELECT value_json FROM kv_state WHERE key = ?'),
    upsertKv: db.prepare(
      'INSERT INTO kv_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at'
    ),
    insertKvIfAbsent: db.prepare(
      'INSERT OR IGNORE INTO kv_state (key, value_json, updated_at) VALUES (?, ?, ?)'
    ),

    listDevicesAll: db.prepare('SELECT data_json FROM devices'),
    listDevicesActive: db.prepare('SELECT data_json FROM devices WHERE revoked_at IS NULL'),
    getDevice: db.prepare('SELECT data_json FROM devices WHERE id = ?'),
    findDevicesByTokenKid: db.prepare(
      'SELECT data_json FROM devices WHERE revoked_at IS NULL AND token_kid = ?'
    ),
    findDevicesWithoutTokenKid: db.prepare(
      'SELECT data_json FROM devices WHERE revoked_at IS NULL AND token_kid IS NULL'
    ),
    findDevicesByClientTokenKid: db.prepare(
      'SELECT data_json FROM devices WHERE revoked_at IS NULL AND client_token_kid = ?'
    ),
    findDevicesWithoutClientTokenKid: db.prepare(
      'SELECT data_json FROM devices WHERE revoked_at IS NULL AND client_token_kid IS NULL'
    ),
    upsertDevice: db.prepare(
      'INSERT INTO devices (id, data_json, revoked_at, last_seen_at, token_kid, client_token_kid) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, revoked_at = excluded.revoked_at, last_seen_at = excluded.last_seen_at, token_kid = excluded.token_kid, client_token_kid = excluded.client_token_kid'
    ),
    updateDevice: db.prepare(
      'UPDATE devices SET data_json = ?, revoked_at = ?, last_seen_at = ?, token_kid = ?, client_token_kid = ? WHERE id = ?'
    ),

    deleteStalePairingCodes: db.prepare(
      'DELETE FROM pairing_codes WHERE used_at IS NOT NULL OR expires_at <= ?'
    ),
    upsertPairingCode: db.prepare(
      'INSERT OR REPLACE INTO pairing_codes (hash, data_json, expires_at, used_at) VALUES (?, ?, ?, ?)'
    ),
    listActivePairingCodes: db.prepare(
      'SELECT hash, data_json FROM pairing_codes WHERE used_at IS NULL AND expires_at > ? ORDER BY expires_at DESC, rowid DESC'
    ),
    deletePairingCodeByHash: db.prepare('DELETE FROM pairing_codes WHERE hash = ?'),
    consumePairingCodeCas: db.prepare(
      'UPDATE pairing_codes SET data_json = ?, used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?'
    ),

    listTasks: db.prepare('SELECT data_json FROM tasks ORDER BY created_at ASC'),
    getTask: db.prepare('SELECT data_json FROM tasks WHERE id = ?'),
    findTaskByIdempotencyKey: db.prepare(
      'SELECT data_json FROM tasks WHERE idempotency_key = ? LIMIT 1'
    ),
    listQueuedTasksForDevice: db.prepare(
      "SELECT data_json FROM tasks WHERE device_id = ? AND status = 'queued' ORDER BY created_at ASC"
    ),
    countTasks: db.prepare('SELECT COUNT(*) AS cnt FROM tasks'),
    selectEvictableTerminalTasks: db.prepare(
      "SELECT id FROM tasks WHERE status NOT IN ('queued', 'assigned', 'running', 'waiting_human') ORDER BY updated_at DESC LIMIT -1 OFFSET ?"
    ),
    upsertTask: db.prepare(
      'INSERT INTO tasks (id, device_id, status, idempotency_key, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id, status = excluded.status, idempotency_key = excluded.idempotency_key, created_at = excluded.created_at, updated_at = excluded.updated_at, data_json = excluded.data_json'
    ),
    deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
    upsertTaskDiff: db.prepare(
      'INSERT INTO task_diffs (task_id, diff_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET diff_json = excluded.diff_json, updated_at = excluded.updated_at'
    ),
    getTaskDiff: db.prepare('SELECT diff_json FROM task_diffs WHERE task_id = ?'),
    deleteTaskDiff: db.prepare('DELETE FROM task_diffs WHERE task_id = ?'),

    listUnits: db.prepare('SELECT data_json FROM units ORDER BY created_at ASC'),
    getUnit: db.prepare('SELECT data_json FROM units WHERE unit_id = ?'),
    upsertUnit: db.prepare(
      'INSERT INTO units (unit_id, device_id, closed_at, created_at, data_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(unit_id) DO UPDATE SET device_id = excluded.device_id, closed_at = excluded.closed_at, created_at = excluded.created_at, data_json = excluded.data_json'
    ),
    updateUnit: db.prepare(
      'UPDATE units SET device_id = ?, closed_at = ?, data_json = ? WHERE unit_id = ?'
    ),
    pruneClosedUnits: db.prepare(
      'DELETE FROM units WHERE unit_id IN (SELECT unit_id FROM units WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT -1 OFFSET ?)'
    ),

    listAuthorizations: db.prepare('SELECT data_json FROM authorizations'),
    getAuthorization: db.prepare('SELECT data_json FROM authorizations WHERE id = ?'),
    listActiveAuthorizations: db.prepare(
      'SELECT data_json FROM authorizations WHERE revoked_at IS NULL AND expires_at > ? ORDER BY confirmed_at DESC'
    ),
    upsertAuthorization: db.prepare(
      'INSERT INTO authorizations (id, data_json, confirmed_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, confirmed_at = excluded.confirmed_at, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at'
    ),
    revokeAuthorization: db.prepare(
      'UPDATE authorizations SET data_json = ?, revoked_at = ? WHERE id = ?'
    ),
    pruneExpiredAuthorizations: db.prepare(
      'DELETE FROM authorizations WHERE id IN (SELECT id FROM authorizations WHERE revoked_at IS NOT NULL OR expires_at <= ? ORDER BY confirmed_at DESC LIMIT -1 OFFSET ?)'
    ),

    listMemories: db.prepare(
      'SELECT id, kind, content, tags_json, source, pinned, created_at, updated_at FROM memories ORDER BY pinned DESC, updated_at DESC'
    ),
    getMemory: db.prepare(
      'SELECT id, kind, content, tags_json, source, pinned, created_at, updated_at FROM memories WHERE id = ?'
    ),
    countMemories: db.prepare('SELECT COUNT(*) AS cnt FROM memories'),
    upsertMemory: db.prepare(
      'INSERT INTO memories (id, kind, content, tags_json, source, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, content = excluded.content, tags_json = excluded.tags_json, source = excluded.source, pinned = excluded.pinned, created_at = excluded.created_at, updated_at = excluded.updated_at'
    ),
    deleteMemory: db.prepare('DELETE FROM memories WHERE id = ?'),
    clearMemories: db.prepare('DELETE FROM memories'),

    listDreams: db.prepare(
      'SELECT id, at, trigger, summary, added, merged, removed FROM dreams ORDER BY at DESC'
    ),
    countDreams: db.prepare('SELECT COUNT(*) AS cnt FROM dreams'),
    maxDreamAt: db.prepare('SELECT COALESCE(MAX(at), 0) AS max_at FROM dreams'),
    insertDream: db.prepare(
      'INSERT OR REPLACE INTO dreams (id, at, trigger, summary, added, merged, removed) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ),
    pruneDreams: db.prepare(
      'DELETE FROM dreams WHERE id IN (SELECT id FROM dreams ORDER BY at DESC LIMIT -1 OFFSET ?)'
    ),

    listMcpServers: db.prepare(
      'SELECT id, name, transport, enabled, config_cipher, updated_at FROM mcp_servers ORDER BY updated_at DESC, id ASC'
    ),
    getMcpServer: db.prepare(
      'SELECT id, name, transport, enabled, config_cipher, updated_at FROM mcp_servers WHERE id = ?'
    ),
    upsertMcpServer: db.prepare(
      'INSERT INTO mcp_servers (id, name, transport, enabled, config_cipher, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, transport = excluded.transport, enabled = excluded.enabled, config_cipher = excluded.config_cipher, updated_at = excluded.updated_at'
    ),
    deleteMcpServer: db.prepare('DELETE FROM mcp_servers WHERE id = ?'),
  }
}

export class CloudStore {
  private closed = false
  private txDepth = 0
  private savepointSeq = 0
  private readonly stmts: PreparedStatements

  private constructor(private readonly db: SqliteDatabaseSync) {
    this.stmts = prepareAllStatements(db)
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
      `)

      const versionBefore = readSchemaVersion(db)
      if (versionBefore < 1) {
        CloudStore.applyMigrationV1(db)
      }

      await CloudStore.migrateLegacyJsonIfNeeded(db, dataDir)

      if (readSchemaVersion(db) < 2) {
        CloudStore.applyMigrationV2(db)
      }

      if (readSchemaVersion(db) < 3) {
        CloudStore.applyMigrationV3(db)
      }

      return new CloudStore(db)
    } catch (error) {
      try {
        db.close()
      } catch {
        // ignore close failure
      }
      throw error
    }
  }

  /** v0 → v1：基础业务表结构 */
  private static applyMigrationV1(db: SqliteDatabaseSync): void {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`
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

        PRAGMA user_version = 1;
      `)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw error
    }
  }

  /** v1 → v2：规范化索引、设备 Token KID 索引列、memories/dreams 统一入库与单调 task_seq */
  private static applyMigrationV2(db: SqliteDatabaseSync): void {
    db.exec('BEGIN IMMEDIATE')
    try {
      const deviceCols = new Set(
        (db.prepare('PRAGMA table_info(devices)').all() as Array<{ name: string }>).map((c) => c.name)
      )
      if (!deviceCols.has('token_kid')) {
        db.exec('ALTER TABLE devices ADD COLUMN token_kid TEXT')
      }
      if (!deviceCols.has('client_token_kid')) {
        db.exec('ALTER TABLE devices ADD COLUMN client_token_kid TEXT')
      }

      // 回填已有设备的 token_kid / client_token_kid
      const existingDevices = db
        .prepare('SELECT id, data_json FROM devices')
        .all() as Array<{ id: string; data_json: string }>
      const backfillDevice = db.prepare(
        'UPDATE devices SET token_kid = ?, client_token_kid = ? WHERE id = ?'
      )
      for (const row of existingDevices) {
        const parsed = parseJsonSafe<DeviceRecord | null>(row.data_json, null)
        if (!parsed) continue
        const tokenKid = parsed.token?.kid ?? null
        const clientTokenKid = parsed.clientToken?.kid ?? null
        if (tokenKid !== null || clientTokenKid !== null) {
          backfillDevice.run(tokenKid, clientTokenKid, row.id)
        }
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_devices_token_kid
          ON devices(token_kid);
        CREATE INDEX IF NOT EXISTS idx_devices_client_token_kid
          ON devices(client_token_kid);
        CREATE INDEX IF NOT EXISTS idx_tasks_created
          ON tasks(created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_tasks_status_updated
          ON tasks(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_units_closed_created
          ON units(closed_at, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_auth_active
          ON authorizations(revoked_at, expires_at, confirmed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pairing_active
          ON pairing_codes(used_at, expires_at);

        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          source TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_memories_pinned_updated
          ON memories(pinned DESC, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memories_source_updated
          ON memories(source, updated_at ASC);

        CREATE TABLE IF NOT EXISTS dreams (
          id TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          trigger TEXT NOT NULL,
          summary TEXT NOT NULL,
          added INTEGER NOT NULL,
          merged INTEGER NOT NULL,
          removed INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_dreams_at
          ON dreams(at DESC);
      `)

      // 从现有工单表初始化持久化单调序号 task_seq，避免历史工单淘汰后序号回退
      const existingTaskIds = db
        .prepare('SELECT id FROM tasks')
        .all() as Array<{ id: string }>
      let maxSeq = 0
      for (const row of existingTaskIds) {
        const num = parseTaskNumericId(row.id)
        if (num > maxSeq) maxSeq = num
      }
      db.prepare('INSERT OR IGNORE INTO kv_state (key, value_json, updated_at) VALUES (?, ?, ?)').run(
        KV_TASK_SEQ,
        JSON.stringify({ seq: maxSeq }),
        Date.now()
      )

      db.exec('PRAGMA user_version = 2')
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw error
    }
  }

  /** v2 → v3：云端 MCP 服务器加密配置表 */
  private static applyMigrationV3(db: SqliteDatabaseSync): void {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          transport TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          config_cipher TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mcp_servers_updated
          ON mcp_servers(updated_at DESC);

        PRAGMA user_version = 3;
      `)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // ignore
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

  /** 返回当前 SQLite `PRAGMA user_version` */
  getSchemaVersion(): number {
    if (this.closed) return 0
    return readSchemaVersion(this.db)
  }

  /**
   * 同步事务封装：顶层用 `BEGIN IMMEDIATE` 抢写锁，嵌套调用自动切 `SAVEPOINT` 支持部分回滚。
   */
  runTransaction<T>(fn: () => T): T {
    if (this.closed) throw new Error('CloudStore is closed')
    if (this.txDepth === 0) {
      this.db.exec('BEGIN IMMEDIATE')
      this.txDepth = 1
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
      } finally {
        this.txDepth = 0
      }
    }
    this.savepointSeq += 1
    const sp = `sp_${this.savepointSeq}`
    this.db.exec(`SAVEPOINT ${sp}`)
    this.txDepth += 1
    try {
      const result = fn()
      this.db.exec(`RELEASE SAVEPOINT ${sp}`)
      return result
    } catch (error) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`)
        this.db.exec(`RELEASE SAVEPOINT ${sp}`)
      } catch {
        // ignore rollback error
      }
      throw error
    } finally {
      this.txDepth -= 1
    }
  }

  private readKv<T>(key: string, fallback: T): T {
    if (this.closed) return fallback
    const row = this.stmts.getKv.get(key) as { value_json?: string } | undefined
    return parseJsonSafe<T>(row?.value_json, fallback)
  }

  private upsertKv(key: string, value: unknown, now = Date.now()): void {
    this.stmts.upsertKv.run(key, JSON.stringify(value), now)
  }

  // ------------------------------ 账号 ------------------------------

  getAccount(): AccountRecord | null {
    return this.readKv<AccountRecord | null>(KV_ACCOUNT, null)
  }

  /**
   * 创建管理员账号：只允许创建一次。
   * 判重与写入由 SQLite `INSERT OR IGNORE` 原子完成，并发请求只有一个成功。
   */
  async createAccount(record: AccountRecord): Promise<boolean> {
    return this.runTransaction(() => {
      const info = this.stmts.insertKvIfAbsent.run(KV_ACCOUNT, JSON.stringify(record), Date.now())
      return Number(info.changes) === 1
    })
  }

  async updateAccount(record: AccountRecord): Promise<void> {
    this.runTransaction(() => {
      this.upsertKv(KV_ACCOUNT, record)
    })
  }

  getSessionVersion(): number {
    return this.getAccount()?.sessionVersion ?? 1
  }

  /** 递增管理员会话版本号，使旧的签名 Cookie 立即作废 */
  async bumpSessionVersion(): Promise<number> {
    return this.runTransaction(() => {
      const account = this.getAccount()
      if (!account) return 1
      const nextVersion = (account.sessionVersion ?? 1) + 1
      const nextAccount: AccountRecord = {
        ...account,
        sessionVersion: nextVersion,
        updatedAt: Date.now(),
      }
      this.upsertKv(KV_ACCOUNT, nextAccount)
      return nextVersion
    })
  }

  // ------------------------------ 设备 ------------------------------

  listDevices(options?: { includeRevoked?: boolean }): DeviceRecord[] {
    if (this.closed) return []
    const rows = (
      options?.includeRevoked
        ? this.stmts.listDevicesAll.all()
        : this.stmts.listDevicesActive.all()
    ) as Array<{ data_json: string }>
    return rows
      .map((row) => parseJsonSafe<DeviceRecord | null>(row.data_json, null))
      .filter((item): item is DeviceRecord => item !== null)
  }

  findDevice(id: string): DeviceRecord | undefined {
    if (this.closed) return undefined
    const row = this.stmts.getDevice.get(id) as { data_json?: string } | undefined
    return parseJsonSafe<DeviceRecord | null>(row?.data_json, null) ?? undefined
  }

  /** O(1) 索引定位 `pk_<kid>.<secret>`；旧版无 `.` token 仅回退扫描 `token_kid IS NULL` 行 */
  findDeviceByToken(token: string): DeviceRecord | undefined {
    if (this.closed || !token) return undefined
    const kid = extractTokenKid(token)
    if (kid) {
      const indexed = this.stmts.findDevicesByTokenKid.all(kid) as Array<{ data_json: string }>
      for (const row of indexed) {
        const device = parseJsonSafe<DeviceRecord | null>(row.data_json, null)
        if (device && device.revokedAt === null && verifyToken(token, device.token)) {
          return device
        }
      }
    }
    const legacy = this.stmts.findDevicesWithoutTokenKid.all() as Array<{ data_json: string }>
    for (const row of legacy) {
      const device = parseJsonSafe<DeviceRecord | null>(row.data_json, null)
      if (device && device.revokedAt === null && verifyToken(token, device.token)) {
        return device
      }
    }
    return undefined
  }

  /**
   * 桌面控制面鉴权：只认独立签发的 `clientToken`（优先 O(1) `client_token_kid` 索引），
   * 严格拒绝仅限执行通道的设备 `token`；未分离 `clientToken` 的旧配对记录必须重新配对。
   */
  findDeviceByClientToken(token: string): DeviceRecord | undefined {
    if (this.closed || !token) return undefined
    const kid = extractTokenKid(token)
    if (kid) {
      const indexed = this.stmts.findDevicesByClientTokenKid.all(kid) as Array<{ data_json: string }>
      for (const row of indexed) {
        const device = parseJsonSafe<DeviceRecord | null>(row.data_json, null)
        if (
          device &&
          device.revokedAt === null &&
          device.clientToken &&
          verifyToken(token, device.clientToken)
        ) {
          return device
        }
      }
    }
    const legacy = this.stmts.findDevicesWithoutClientTokenKid.all() as Array<{ data_json: string }>
    for (const row of legacy) {
      const device = parseJsonSafe<DeviceRecord | null>(row.data_json, null)
      if (
        device &&
        device.revokedAt === null &&
        device.clientToken &&
        verifyToken(token, device.clientToken)
      ) {
        return device
      }
    }
    return undefined
  }

  async addDevice(record: DeviceRecord): Promise<void> {
    this.runTransaction(() => {
      this.stmts.upsertDevice.run(
        record.id,
        JSON.stringify(record),
        record.revokedAt ?? null,
        record.lastSeenAt,
        record.token?.kid ?? null,
        record.clientToken?.kid ?? null
      )
    })
  }

  async updateDevice(id: string, patch: Partial<DeviceRecord>): Promise<DeviceRecord | null> {
    return this.runTransaction(() => {
      const existing = this.findDevice(id)
      if (!existing) return null
      const updated: DeviceRecord = { ...existing, ...patch }
      this.stmts.updateDevice.run(
        JSON.stringify(updated),
        updated.revokedAt ?? null,
        updated.lastSeenAt,
        updated.token?.kid ?? null,
        updated.clientToken?.kid ?? null,
        id
      )
      return updated
    })
  }

  async revokeAllDevices(now = Date.now()): Promise<void> {
    this.runTransaction(() => {
      const devices = this.listDevices({ includeRevoked: true })
      for (const device of devices) {
        const updated: DeviceRecord = { ...device, revokedAt: now }
        this.stmts.updateDevice.run(
          JSON.stringify(updated),
          now,
          updated.lastSeenAt,
          updated.token?.kid ?? null,
          updated.clientToken?.kid ?? null,
          updated.id
        )
      }
    })
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
      this.stmts.deleteStalePairingCodes.run(now)
      this.stmts.upsertPairingCode.run(
        record.hash,
        JSON.stringify(record),
        record.expiresAt,
        null
      )
      // 限制并发活跃配对码数量上限（默认 5 个），超限淘汰最旧码
      const active = this.stmts.listActivePairingCodes.all(now) as Array<{ hash: string }>
      for (const excess of active.slice(MAX_ACTIVE_PAIRING_CODES)) {
        this.stmts.deletePairingCodeByHash.run(excess.hash)
      }
    })
  }

  /**
   * 消费配对码：TTL + 一次性（事务内 SQL `WHERE used_at IS NULL` CAS，`changes === 1` 才成功）。
   * 返回码记录或 null；null 时不区分「不存在 / 已过期 / 已用过」。
   */
  async consumePairingCode(
    candidateHash: string,
    now = Date.now()
  ): Promise<PairingCodeRecord | null> {
    return this.runTransaction(() => {
      const rows = this.stmts.listActivePairingCodes.all(now) as Array<{
        hash: string
        data_json: string
      }>
      let matched: PairingCodeRecord | null = null
      for (const row of rows) {
        if (!constantTimeStringEqual(row.hash, candidateHash)) continue
        const parsed = parseJsonSafe<PairingCodeRecord | null>(row.data_json, null)
        if (!parsed || parsed.usedAt !== null || parsed.expiresAt <= now) continue
        matched = { ...parsed, usedAt: now }
        break
      }
      if (!matched) return null
      const info = this.stmts.consumePairingCodeCas.run(
        JSON.stringify(matched),
        now,
        matched.hash,
        now
      )
      return Number(info.changes) === 1 ? matched : null
    })
  }

  listPairingCodes(now = Date.now()): PairingCodeRecord[] {
    if (this.closed) return []
    const rows = this.stmts.listActivePairingCodes.all(now) as Array<{ data_json: string }>
    return rows
      .map((row) => parseJsonSafe<PairingCodeRecord | null>(row.data_json, null))
      .filter((code): code is PairingCodeRecord => code !== null && !code.usedAt && code.expiresAt > now)
  }

  // ------------------------------ 工单 ------------------------------

  /** 持久化单调工单序号（存 `kv_state`），防止重启或历史工单淘汰后序号回退碰撞 */
  nextTaskSeq(): number {
    return this.runTransaction(() => {
      const stored = this.readKv<{ seq?: number } | number | null>(KV_TASK_SEQ, null)
      let current =
        typeof stored === 'number'
          ? stored
          : typeof stored?.seq === 'number'
            ? stored.seq
            : 0
      if (!Number.isFinite(current) || current < 0) current = 0
      const next = Math.floor(current) + 1
      this.upsertKv(KV_TASK_SEQ, { seq: next })
      return next
    })
  }

  listTasks(): CloudTaskSnapshot[] {
    if (this.closed) return []
    const rows = this.stmts.listTasks.all() as Array<{ data_json: string }>
    return rows
      .map((row) => parseJsonSafe<CloudTaskSnapshot | null>(row.data_json, null))
      .filter((item): item is CloudTaskSnapshot => item !== null)
  }

  getTask(id: string): CloudTaskSnapshot | undefined {
    if (this.closed) return undefined
    const row = this.stmts.getTask.get(id) as { data_json?: string } | undefined
    return parseJsonSafe<CloudTaskSnapshot | null>(row?.data_json, null) ?? undefined
  }

  findTask(id: string): CloudTaskSnapshot | undefined {
    return this.getTask(id)
  }

  findTaskByIdempotencyKey(key: string): CloudTaskSnapshot | undefined {
    if (this.closed || !key) return undefined
    const row = this.stmts.findTaskByIdempotencyKey.get(key) as { data_json?: string } | undefined
    return parseJsonSafe<CloudTaskSnapshot | null>(row?.data_json, null) ?? undefined
  }

  /** 将脱敏 diff 单独存盘到 task_diffs 表，避免把大体积 diff 塞进 tasks 行与前端快照 */
  async saveTaskDiff(
    taskId: string,
    diff: NonNullable<CloudTaskResult['diff']>
  ): Promise<void> {
    if (!/^[A-Za-z0-9._-]+$/.test(taskId)) return
    const now = Date.now()
    this.runTransaction(() => {
      this.stmts.upsertTaskDiff.run(taskId, JSON.stringify(diff), now)
    })
  }

  async loadTaskDiff(taskId: string): Promise<NonNullable<CloudTaskResult['diff']> | undefined> {
    if (this.closed || !/^[A-Za-z0-9._-]+$/.test(taskId)) return undefined
    const row = this.stmts.getTaskDiff.get(taskId) as { diff_json?: string } | undefined
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

    const now = Date.now()
    this.runTransaction(() => {
      if (inlineDiff && /^[A-Za-z0-9._-]+$/.test(storedTask.id)) {
        this.stmts.upsertTaskDiff.run(storedTask.id, JSON.stringify(inlineDiff), now)
      }
      this.stmts.upsertTask.run(
        storedTask.id,
        storedTask.spec.deviceId,
        storedTask.status,
        storedTask.idempotencyKey ?? null,
        storedTask.createdAt,
        storedTask.updatedAt,
        JSON.stringify(storedTask)
      )

      const numericId = parseTaskNumericId(storedTask.id)
      if (numericId > 0) {
        const storedSeq = this.readKv<{ seq?: number } | number | null>(KV_TASK_SEQ, null)
        const currentSeq =
          typeof storedSeq === 'number'
            ? storedSeq
            : typeof storedSeq?.seq === 'number'
              ? storedSeq.seq
              : 0
        if (numericId > currentSeq) {
          this.upsertKv(KV_TASK_SEQ, { seq: numericId }, now)
        }
      }

      // 控制终态工单历史上限，防止数据库与 snapshot 无限膨胀
      const total = Number(
        (this.stmts.countTasks.get() as { cnt?: number } | undefined)?.cnt ?? 0
      )
      if (total > MAX_STORED_TASKS_THRESHOLD) {
        const evictable = this.stmts.selectEvictableTerminalTasks.all(
          MAX_KEPT_TERMINAL_TASKS
        ) as Array<{ id: string }>
        for (const row of evictable) {
          this.stmts.deleteTask.run(row.id)
          this.stmts.deleteTaskDiff.run(row.id)
        }
      }
    })
  }

  /** 同一设备上的待执行工单按入队顺序（FIFO） */
  queuedTasksFor(deviceId: string): CloudTaskSnapshot[] {
    if (this.closed) return []
    const rows = this.stmts.listQueuedTasksForDevice.all(deviceId) as Array<{ data_json: string }>
    return rows
      .map((row) => parseJsonSafe<CloudTaskSnapshot | null>(row.data_json, null))
      .filter((item): item is CloudTaskSnapshot => item !== null)
  }

  // ------------------------------ 工作单元 ------------------------------

  listUnits(): UnitRecord[] {
    if (this.closed) return []
    const rows = this.stmts.listUnits.all() as Array<{ data_json: string }>
    return rows
      .map((row) => parseJsonSafe<UnitRecord | null>(row.data_json, null))
      .filter((item): item is UnitRecord => item !== null)
  }

  findUnit(unitId: string): UnitRecord | undefined {
    if (this.closed) return undefined
    const row = this.stmts.getUnit.get(unitId) as { data_json?: string } | undefined
    return parseJsonSafe<UnitRecord | null>(row?.data_json, null) ?? undefined
  }

  async saveUnit(unit: UnitRecord): Promise<void> {
    this.runTransaction(() => {
      this.stmts.upsertUnit.run(
        unit.unitId,
        unit.deviceId,
        unit.closedAt ?? null,
        unit.createdAt,
        JSON.stringify(unit)
      )
      if (unit.closedAt !== null) {
        this.stmts.pruneClosedUnits.run(MAX_CLOSED_UNITS_RETENTION)
      }
    })
  }

  /** 在事务内原子读取并修改单元，避免并发帧（如 task_worktree vs unit_closed）互相覆写 closedAt */
  async patchUnit(
    unitId: string,
    mutate: (unit: UnitRecord) => UnitRecord
  ): Promise<UnitRecord | undefined> {
    return this.runTransaction(() => {
      const existing = this.findUnit(unitId)
      if (!existing) return undefined
      const updated = mutate(existing)
      this.stmts.updateUnit.run(
        updated.deviceId,
        updated.closedAt ?? null,
        JSON.stringify(updated),
        unitId
      )
      if (updated.closedAt !== null) {
        this.stmts.pruneClosedUnits.run(MAX_CLOSED_UNITS_RETENTION)
      }
      return updated
    })
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
    const stored = this.readKv<unknown>(KV_CONFIG, null)
    // 旧配置整体丢弃：不返回、不迁移，UI 看到的是「未配置」（D20）
    if (isLegacyConfigRecord(stored)) return null
    return stored as CloudConfigRecord | null
  }

  async saveCloudConfig(record: CloudConfigRecord): Promise<void> {
    this.runTransaction(() => {
      const prev = this.readKv<{ updatedAt?: number } | null>(KV_CONFIG, null)
      const prevStamp = typeof prev?.updatedAt === 'number' ? prev.updatedAt : 0
      // 保证相邻两次保存的时间戳严格递增：SQLite 写入在亚毫秒内完成，相同 ms 会被轮换逻辑误判为同一份配置
      const nextRecord: CloudConfigRecord =
        record.updatedAt <= prevStamp
          ? { ...record, updatedAt: prevStamp + 1 }
          : record
      this.upsertKv(KV_CONFIG, nextRecord)
    })
  }

  async clearCloudConfig(): Promise<void> {
    this.runTransaction(() => {
      this.upsertKv(KV_CONFIG, null)
    })
  }

  /** 只换凭证，保留 provider / 模型（OAuth 刷新走此路径；绝不改 updatedAt，否则会触发 AgentManager 无谓重建） */
  async saveCloudCredential(providerId: string, credentialCipher: string): Promise<void> {
    this.runTransaction(() => {
      const record = this.getCloudConfig()
      if (!record || record.providerId !== providerId) return
      const next: CloudConfigRecord = {
        ...record,
        credentialCipher,
        credentialUpdatedAt: Date.now(),
      }
      this.upsertKv(KV_CONFIG, next)
    })
  }

  // ------------------------------ 方案授权 ------------------------------

  listAuthorizations(): AuthorizationRecord[] {
    if (this.closed) return []
    const rows = this.stmts.listAuthorizations.all() as Array<{ data_json: string }>
    return rows
      .map((row) => parseJsonSafe<AuthorizationRecord | null>(row.data_json, null))
      .filter((item): item is AuthorizationRecord => item !== null)
  }

  findAuthorization(id: string): AuthorizationRecord | undefined {
    if (this.closed) return undefined
    const row = this.stmts.getAuthorization.get(id) as { data_json?: string } | undefined
    return parseJsonSafe<AuthorizationRecord | null>(row?.data_json, null) ?? undefined
  }

  /** 当前仍有效的授权（未撤销、未过期），按确认时间倒序 */
  activeAuthorizations(now = Date.now()): AuthorizationRecord[] {
    if (this.closed) return []
    const rows = this.stmts.listActiveAuthorizations.all(now) as Array<{ data_json: string }>
    return rows
      .map((row) => parseJsonSafe<AuthorizationRecord | null>(row.data_json, null))
      .filter((item): item is AuthorizationRecord => item !== null)
  }

  /** 在 `BEGIN IMMEDIATE` 事务内原子读取、校验并扣减配额，彻底消除并发 dispatch TOCTOU */
  async updateAuthorization(
    id: string,
    mutate: (current: AuthorizationRecord | undefined) => AuthorizationRecord | undefined
  ): Promise<AuthorizationRecord | undefined> {
    return this.runTransaction(() => {
      const existing = this.findAuthorization(id)
      const next = mutate(existing)
      if (!next) return undefined
      this.stmts.upsertAuthorization.run(
        next.id,
        JSON.stringify(next),
        next.confirmedAt,
        next.expiresAt,
        next.revokedAt ?? null
      )
      return next
    })
  }

  async saveAuthorization(record: AuthorizationRecord): Promise<void> {
    this.runTransaction(() => {
      this.stmts.upsertAuthorization.run(
        record.id,
        JSON.stringify(record),
        record.confirmedAt,
        record.expiresAt,
        record.revokedAt ?? null
      )
      this.stmts.pruneExpiredAuthorizations.run(Date.now(), MAX_EXPIRED_AUTHORIZATIONS_RETENTION)
    })
  }

  async revokeAuthorization(id: string, now = Date.now()): Promise<void> {
    this.runTransaction(() => {
      const existing = this.findAuthorization(id)
      if (!existing) return
      const next: AuthorizationRecord = { ...existing, revokedAt: existing.revokedAt ?? now }
      this.stmts.revokeAuthorization.run(JSON.stringify(next), next.revokedAt ?? now, id)
      this.stmts.pruneExpiredAuthorizations.run(now, MAX_EXPIRED_AUTHORIZATIONS_RETENTION)
    })
  }

  // ------------------------------ 持久记忆与梦境（统一落入 cloud.db） ------------------------------

  listMemories(): CloudMemoryItem[] {
    if (this.closed) return []
    const rows = this.stmts.listMemories.all() as unknown as MemoryDbRow[]
    return rows.map(rowToMemoryItem)
  }

  findMemory(id: string): CloudMemoryItem | undefined {
    if (this.closed) return undefined
    const row = this.stmts.getMemory.get(id) as unknown as MemoryDbRow | undefined
    return row ? rowToMemoryItem(row) : undefined
  }

  countMemories(): number {
    if (this.closed) return 0
    const row = this.stmts.countMemories.get() as { cnt?: number } | undefined
    return Number(row?.cnt ?? 0)
  }

  replaceMemories(items: CloudMemoryItem[]): void {
    this.runTransaction(() => {
      this.stmts.clearMemories.run()
      for (const item of items) {
        this.stmts.upsertMemory.run(
          item.id,
          item.kind,
          item.content,
          JSON.stringify(item.tags),
          item.source,
          item.pinned ? 1 : 0,
          item.createdAt,
          item.updatedAt
        )
      }
    })
  }

  upsertMemory(item: CloudMemoryItem): void {
    this.runTransaction(() => {
      this.stmts.upsertMemory.run(
        item.id,
        item.kind,
        item.content,
        JSON.stringify(item.tags),
        item.source,
        item.pinned ? 1 : 0,
        item.createdAt,
        item.updatedAt
      )
    })
  }

  deleteMemoryRow(id: string): boolean {
    return this.runTransaction(() => {
      const info = this.stmts.deleteMemory.run(id)
      return Number(info.changes) > 0
    })
  }

  listDreams(): CloudDreamRecord[] {
    if (this.closed) return []
    const rows = this.stmts.listDreams.all() as unknown as DreamDbRow[]
    return rows.map(rowToDreamRecord)
  }

  countDreams(): number {
    if (this.closed) return 0
    const row = this.stmts.countDreams.get() as { cnt?: number } | undefined
    return Number(row?.cnt ?? 0)
  }

  lastDreamAt(): number {
    if (this.closed) return 0
    const row = this.stmts.maxDreamAt.get() as { max_at?: number } | undefined
    return Number(row?.max_at ?? 0)
  }

  appendDreamRecord(record: CloudDreamRecord, maxDreams = MAX_STORED_DREAMS): void {
    this.runTransaction(() => {
      this.stmts.insertDream.run(
        record.id,
        record.at,
        record.trigger,
        record.summary,
        record.added,
        record.merged,
        record.removed
      )
      this.stmts.pruneDreams.run(maxDreams)
    })
  }

  importDreams(records: CloudDreamRecord[], maxDreams = MAX_STORED_DREAMS): void {
    this.runTransaction(() => {
      for (const record of records) {
        this.stmts.insertDream.run(
          record.id,
          record.at,
          record.trigger,
          record.summary,
          record.added,
          record.merged,
          record.removed
        )
      }
      this.stmts.pruneDreams.run(maxDreams)
    })
  }

  // ------------------------------ 云端 MCP 服务器（加密落盘） ------------------------------

  listMcpServerRecords(): CloudMcpServerRecord[] {
    if (this.closed) return []
    const rows = this.stmts.listMcpServers.all() as unknown as McpServerDbRow[]
    return rows.map(rowToMcpServerRecord)
  }

  getMcpServerRecord(id: string): CloudMcpServerRecord | null {
    if (this.closed) return null
    const row = this.stmts.getMcpServer.get(id) as unknown as McpServerDbRow | undefined
    return row ? rowToMcpServerRecord(row) : null
  }

  upsertMcpServerRecord(record: CloudMcpServerRecord): void {
    this.runTransaction(() => {
      this.stmts.upsertMcpServer.run(
        record.id,
        record.name,
        record.transport,
        record.enabled ? 1 : 0,
        record.configCipher,
        record.updatedAt
      )
    })
  }

  deleteMcpServerRecord(id: string): boolean {
    return this.runTransaction(() => {
      const info = this.stmts.deleteMcpServer.run(id)
      return Number(info.changes) > 0
    })
  }

  // ------------------------------ 客户端离线游标（F-51） ------------------------------

  getLastClientLeftAt(): number | null {
    return this.readKv<ClientStateFile>(KV_CLIENT_STATE, { lastClientLeftAt: null }).lastClientLeftAt
  }

  async setLastClientLeftAt(at: number | null): Promise<void> {
    this.runTransaction(() => {
      const current = this.readKv<ClientStateFile>(KV_CLIENT_STATE, { lastClientLeftAt: null })
      if (current.lastClientLeftAt === at) return
      const next: ClientStateFile = { ...current, lastClientLeftAt: at }
      this.upsertKv(KV_CLIENT_STATE, next)
    })
  }

  getReadState(): { lastReadSeq: number; lastReadAt: number | null } {
    const state = this.readKv<ClientStateFile>(KV_CLIENT_STATE, { lastClientLeftAt: null })
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
    this.runTransaction(() => {
      const current = this.readKv<ClientStateFile>(KV_CLIENT_STATE, { lastClientLeftAt: null })
      const next: ClientStateFile = {
        ...current,
        lastReadSeq: normalizedSeq,
        lastReadAt,
      }
      this.upsertKv(KV_CLIENT_STATE, next)
    })
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
