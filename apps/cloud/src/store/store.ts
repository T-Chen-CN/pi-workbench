/**
 * 云端持久化：账号、设备、配对码、工单、工作单元、云端配置。
 *
 * 全部落在 `/var/lib/pi-cloud/*.json`，写走 `JsonDoc`（原子写 + 串行）。
 * 会话 JSONL 不在这里——那是 SDK 的 `agentDir/sessions`，也是唯一真相源（F-42）。
 */

import * as path from 'path'
import type {
  CloudWorkspaceInfo,
  CloudTaskSnapshot,
} from 'pi-bridge'
import { JsonDoc } from './atomic.js'
import { hashToken, type TokenHash } from '../auth/credentials.js'
import type { AuthorizationRecord } from '../tasks/authorization.js'

export interface AccountRecord {
  passwordHash: string
  salt: string
  createdAt: number
  updatedAt: number
}

export interface DeviceRecord {
  id: string
  name: string
  platform: string
  token: TokenHash
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

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000

export class CloudStore {
  private constructor(
    private readonly accounts: JsonDoc<AccountsFile>,
    private readonly devices: JsonDoc<DevicesFile>,
    private readonly pairing: JsonDoc<PairingFile>,
    private readonly tasks: JsonDoc<TasksFile>,
    private readonly units: JsonDoc<UnitsFile>,
    private readonly config: JsonDoc<ConfigFile>,
    private readonly authorizations: JsonDoc<AuthorizationsFile>
  ) {}

  static async open(dataDir: string): Promise<CloudStore> {
    const dir = (name: string) => path.join(dataDir, name)
    return new CloudStore(
      await JsonDoc.open<AccountsFile>(dir('accounts.json'), () => ({ account: null })),
      await JsonDoc.open<DevicesFile>(dir('devices.json'), () => ({ devices: [] })),
      await JsonDoc.open<PairingFile>(dir('pairing.json'), () => ({ codes: [] })),
      await JsonDoc.open<TasksFile>(dir('tasks.json'), () => ({ tasks: [] })),
      await JsonDoc.open<UnitsFile>(dir('units.json'), () => ({ units: [] })),
      await JsonDoc.open<ConfigFile>(dir('config.json'), () => ({ config: null })),
      await JsonDoc.open<AuthorizationsFile>(dir('authorizations.json'), () => ({ items: [] }))
    )
  }

  // ------------------------------ 账号 ------------------------------

  getAccount(): AccountRecord | null {
    return this.accounts.get().account
  }

  /**
   * 创建管理员账号：只允许创建一次。
   * 判重与写入在同一次 update 里完成（单线程串行），并发请求只有一个成功。
   */
  async createAccount(record: AccountRecord): Promise<boolean> {
    let created = false
    await this.accounts.update((current) => {
      if (current.account) return current
      created = true
      return { account: record }
    })
    return created
  }

  async updateAccount(record: AccountRecord): Promise<void> {
    await this.accounts.update(() => ({ account: record }))
  }

  // ------------------------------ 设备 ------------------------------

  listDevices(): DeviceRecord[] {
    return this.devices.get().devices
  }

  findDevice(id: string): DeviceRecord | undefined {
    return this.devices.get().devices.find((device) => device.id === id)
  }

  findDeviceByToken(token: string): DeviceRecord | undefined {
    return this.devices.get().devices.find((device) =>
      device.revokedAt ? false : hashToken(token, device.token.salt).hash === device.token.hash
    )
  }

  async addDevice(record: DeviceRecord): Promise<void> {
    await this.devices.update((current) => ({
      devices: [...current.devices.filter((item) => item.id !== record.id), record],
    }))
  }

  async updateDevice(id: string, patch: Partial<DeviceRecord>): Promise<DeviceRecord | null> {
    let updated: DeviceRecord | null = null
    await this.devices.update((current) => ({
      devices: current.devices.map((device) => {
        if (device.id !== id) return device
        updated = { ...device, ...patch }
        return updated
      }),
    }))
    return updated
  }

  async revokeAllDevices(now = Date.now()): Promise<void> {
    await this.devices.update((current) => ({
      devices: current.devices.map((device) => ({ ...device, revokedAt: now })),
    }))
  }

  // ------------------------------ 配对码 ------------------------------

  async issuePairingCode(input: { codeHash: string; salt: string; now?: number }): Promise<void> {
    const now = input.now ?? Date.now()
    await this.pairing.update((current) => ({
      codes: [
        // 只保留未使用且未过期的码，避免文件无限增长
        ...current.codes.filter((code) => !code.usedAt && code.expiresAt > now),
        {
          hash: input.codeHash,
          salt: input.salt,
          createdAt: now,
          expiresAt: now + PAIRING_CODE_TTL_MS,
          usedAt: null,
        },
      ],
    }))
  }

  /**
   * 消费配对码：TTL + 一次性（CAS 写 usedAt）。
   * 返回码记录或 null；null 时不区分「不存在 / 已过期 / 已用过」。
   */
  async consumePairingCode(
    candidateHash: string,
    now = Date.now()
  ): Promise<PairingCodeRecord | null> {
    let matched: PairingCodeRecord | null = null
    await this.pairing.update((current) => {
      const codes = current.codes.map((code) => {
        if (matched || code.usedAt || code.expiresAt <= now) return code
        if (code.hash !== candidateHash) return code
        matched = { ...code, usedAt: now }
        return matched
      })
      return { codes }
    })
    return matched
  }

  listPairingCodes(now = Date.now()): PairingCodeRecord[] {
    return this.pairing.get().codes.filter((code) => !code.usedAt && code.expiresAt > now)
  }

  // ------------------------------ 工单 ------------------------------

  listTasks(): CloudTaskSnapshot[] {
    return this.tasks.get().tasks
  }

  findTask(id: string): CloudTaskSnapshot | undefined {
    return this.tasks.get().tasks.find((task) => task.id === id)
  }

  async saveTask(task: CloudTaskSnapshot): Promise<void> {
    await this.tasks.update((current) => ({
      tasks: [...current.tasks.filter((item) => item.id !== task.id), task],
    }))
  }

  /** 同一设备上的待执行工单按入队顺序（FIFO） */
  queuedTasksFor(deviceId: string): CloudTaskSnapshot[] {
    return this.tasks
      .get()
      .tasks.filter((task) => task.spec.deviceId === deviceId && task.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  // ------------------------------ 工作单元 ------------------------------

  listUnits(): UnitRecord[] {
    return this.units.get().units
  }

  findUnit(unitId: string): UnitRecord | undefined {
    return this.units.get().units.find((unit) => unit.unitId === unitId)
  }

  async saveUnit(unit: UnitRecord): Promise<void> {
    await this.units.update((current) => ({
      units: [...current.units.filter((item) => item.unitId !== unit.unitId), unit],
    }))
  }

  /** 在写锁内增量修改单元，避免并发帧（如 task_worktree vs unit_closed）互相覆写 closedAt */
  async patchUnit(
    unitId: string,
    mutate: (unit: UnitRecord) => UnitRecord
  ): Promise<UnitRecord | undefined> {
    let updated: UnitRecord | undefined
    await this.units.update((current) => ({
      units: current.units.map((unit) => {
        if (unit.unitId !== unitId) return unit
        updated = mutate(unit)
        return updated
      }),
    }))
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
    await this.units.update((current) => ({
      units: current.units.map((unit) => {
        if (unit.unitId !== unitId) return unit
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
      }),
    }))
  }

  // ------------------------------ 云端配置 ------------------------------

  getCloudConfig(): CloudConfigRecord | null {
    const stored = this.config.get().config as unknown
    // 旧配置整体丢弃：不返回、不迁移，UI 看到的是「未配置」（D20）
    if (isLegacyConfigRecord(stored)) return null
    return stored as CloudConfigRecord | null
  }

  async saveCloudConfig(record: CloudConfigRecord): Promise<void> {
    await this.config.update(() => ({ config: record }))
  }

  async clearCloudConfig(): Promise<void> {
    await this.config.update(() => ({ config: null }))
  }

  /** 只换凭证，保留 provider / 模型（OAuth 刷新与重新登录都走这条路径） */
  async saveCloudCredential(providerId: string, credentialCipher: string): Promise<void> {
    await this.config.update((current) => {
      const record = current.config as CloudConfigRecord | null
      if (!record || record.providerId !== providerId) return current
      return { config: { ...record, credentialCipher, updatedAt: Date.now() } }
    })
  }

  // ------------------------------ 方案授权 ------------------------------

  listAuthorizations(): AuthorizationRecord[] {
    return this.authorizations.get().items
  }

  findAuthorization(id: string): AuthorizationRecord | undefined {
    return this.authorizations.get().items.find((item) => item.id === id)
  }

  /** 当前仍有效的授权（未撤销、未过期），按确认时间倒序 */
  activeAuthorizations(now = Date.now()): AuthorizationRecord[] {
    return this.authorizations
      .get()
      .items.filter((item) => !item.revokedAt && item.expiresAt > now)
      .sort((a, b) => b.confirmedAt - a.confirmedAt)
  }

  /** 在写锁内原子执行授权校验与扣减，避免并发 dispatch 绕过配额（TOCTOU） */
  async updateAuthorization(
    id: string,
    mutate: (current: AuthorizationRecord | undefined) => AuthorizationRecord | undefined
  ): Promise<AuthorizationRecord | undefined> {
    let result: AuthorizationRecord | undefined
    await this.authorizations.update((doc) => {
      const existing = doc.items.find((item) => item.id === id)
      const next = mutate(existing)
      result = next
      if (!next) return doc
      return {
        items: [...doc.items.filter((item) => item.id !== id), next],
      }
    })
    return result
  }

  async saveAuthorization(record: AuthorizationRecord): Promise<void> {
    await this.authorizations.update((current) => ({
      items: [...current.items.filter((item) => item.id !== record.id), record],
    }))
  }

  async revokeAuthorization(id: string, now = Date.now()): Promise<void> {
    await this.authorizations.update((current) => ({
      items: current.items.map((item) =>
        item.id === id ? { ...item, revokedAt: item.revokedAt ?? now } : item
      ),
    }))
  }

  /** 退出流程用：等所有在途写入落盘 */
  async flush(): Promise<void> {
    await Promise.all([
      this.accounts.flush(),
      this.devices.flush(),
      this.pairing.flush(),
      this.tasks.flush(),
      this.units.flush(),
      this.config.flush(),
      this.authorizations.flush(),
    ])
  }
}
