/**
 * 设备身份（D0 / DE-01）。
 *
 * 两件事分开：
 *   - `id`：本机首次生成，**认设备用的就是它**（云端 `author.id`）；只读、不重置
 *   - `name`：给人看的（`author.name`），默认取系统友好名，用户可随时改，**改完下一轮即生效**
 *
 * 为什么名字不能当身份：会重名（两台都叫 `DESKTOP-XXXX`）、会被改、常含个人信息
 * （`唐辰的 MacBook Pro` 会随每轮发给云端），所以认设备永远用 `id`。
 *
 * 落盘：
 *   - `data/cloud-agent/device.json`          —— 本机身份
 *   - `data/cloud-agent/device-sessions.json` —— 会话归属（哪个会话是哪台设备发起的）
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { getAppDir } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomicSync } from '../atomic-json.js'
import type { CloudDeviceAuthor, CloudDeviceSummary } from './types.js'

/** 与上游 `_clean_text` 的上限对齐：超过就截断，别指望云端帮忙裁 */
const NAME_MAX_CHARS = 40
/** 探测命令最多等这么久，超时一律回落 hostname */
const PROBE_TIMEOUT_MS = 800
/** 会话归属表只留最近这么多条，防无限增长 */
const SESSION_INDEX_LIMIT = 200

export interface CloudDeviceRecord {
  id: string
  name: string
  /** 系统给出的默认名（hostname 或探测到的友好名）——「恢复默认」用它 */
  defaultName: string
  createdAt: number
  /** 用户手动改过名字的时间；有它就说明 `name` 是用户的意思，探测不再覆盖 */
  nameEditedAt: number | null
}

export interface CloudDeviceSessionEntry {
  deviceId: string
  deviceName: string
  firstSeenAt: number
}

/**
 * 清洗设备名：丢掉 Unicode 类别 Cc/Cs/Cn/Co（控制字符、孤立代理、未分配、私用区），
 * 去掉能当路径分隔符的 `/`，折叠空白，截到 40 字。
 *
 * 为什么逐码点判断而不是正则替换：emoji 序列（ZWJ / 变体选择符）属于 Cf，不能连坐删掉，
 * 否则「唐辰的 MacBook Pro」里的表情会被拆散。
 */
export function sanitizeDeviceName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let out = ''
  for (const char of raw) {
    // 设备名是单行的：制表 / 换行先折成空格，否则 "a\tb" 会粘成 "ab"
    if (WHITESPACE_CONTROLS.has(char)) {
      out += ' '
      continue
    }
    const code = char.codePointAt(0) ?? 0
    if (isDroppedCategory(code)) continue
    if (char === '/') continue
    out += char
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_CHARS)
}

const WHITESPACE_CONTROLS = new Set(['\t', '\n', '\r', '\f', '\v'])

/** Cc 0x00-0x1F 0x7F-0x9F · Cs 代理 · Cn 未分配 · Co 私用区 */
function isDroppedCategory(code: number): boolean {
  if (code <= 0x1f) return true
  if (code >= 0x7f && code <= 0x9f) return true
  if (code >= 0xd800 && code <= 0xdfff) return true
  if (code >= 0xe000 && code <= 0xf8ff) return true
  if (code >= 0xf0000) return true
  return false
}

export function cloudDeviceDir(): string {
  return path.join(getAppDir(), 'data', 'cloud-agent')
}

export function deviceFile(): string {
  return path.join(cloudDeviceDir(), 'device.json')
}

export function deviceSessionsFile(): string {
  return path.join(cloudDeviceDir(), 'device-sessions.json')
}

function hostnameName(hostname: string = os.hostname()): string {
  return sanitizeDeviceName(hostname)
}

function fallbackName(id: string): string {
  return `设备 ${id.slice(0, 6)}`
}

function persist(record: CloudDeviceRecord): void {
  writeJsonAtomicSync(deviceFile(), record)
}

/**
 * 读本机身份，不存在就生成。
 *
 * 同步、无 spawn：这条路径在每轮对话前都要走一遍（`deviceAuthor`），
 * 探测友好名一律交给 `ensureDeviceNameProbe()`（异步，只在连接页打开时调）。
 */
export function readCloudDevice(hostname: string = os.hostname()): CloudDeviceRecord {
  const stored = readJsonWithBackup<Partial<CloudDeviceRecord>>(deviceFile()).data
  const storedId = typeof stored?.id === 'string' ? stored.id.trim() : ''
  const defaultName =
    sanitizeDeviceName(stored?.defaultName) || hostnameName(hostname)

  if (storedId) {
    const record: CloudDeviceRecord = {
      id: storedId,
      name:
        sanitizeDeviceName(stored?.name) || defaultName || fallbackName(storedId),
      defaultName: defaultName || fallbackName(storedId),
      createdAt:
        typeof stored?.createdAt === 'number' && Number.isFinite(stored.createdAt)
          ? stored.createdAt
          : Date.now(),
      nameEditedAt:
        typeof stored?.nameEditedAt === 'number' && Number.isFinite(stored.nameEditedAt)
          ? stored.nameEditedAt
          : null,
    }
    return record
  }

  // 没有 id（首次启动 / 文件损坏且没有可用备份）→ 生成新身份。
  // 不拿 .bak 硬凑：错的身份比新身份更难收拾。
  const id = randomUUID()
  const fresh: CloudDeviceRecord = {
    id,
    name: defaultName || fallbackName(id),
    defaultName: defaultName || fallbackName(id),
    createdAt: Date.now(),
    nameEditedAt: null,
  }
  persist(fresh)
  return fresh
}

/**
 * 改设备名。空字符串 = 恢复系统默认名（并清掉「用户改过」标记）。
 * 返回落盘后的记录。
 */
export function updateCloudDeviceName(raw: unknown): CloudDeviceRecord {
  const current = readCloudDevice()
  const next = sanitizeDeviceName(raw)
  if (!next) {
    const reset: CloudDeviceRecord = {
      ...current,
      name: current.defaultName,
      nameEditedAt: null,
    }
    persist(reset)
    return reset
  }
  const updated: CloudDeviceRecord = { ...current, name: next, nameEditedAt: Date.now() }
  persist(updated)
  return updated
}

/** `execFile` 的极简包装：失败/超时/空输出一律 `null`，绝不抛。 */
function runProbe(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf-8' },
        (error, stdout) => {
          if (error) return resolve(null)
          const text = typeof stdout === 'string' ? stdout.trim() : ''
          resolve(text || null)
        }
      )
    } catch {
      resolve(null)
    }
  })
}

/**
 * 系统里的「设备名」（用户可见的那个，不是主机名）。
 *
 * - macOS：`scutil --get ComputerName` → "唐辰的 MacBook Pro"
 * - Linux：`hostnamectl --pretty`（无 systemd 环境必然失败）
 * - Windows：不做探测。计算机名在「重命名这台电脑」后要重启才更新，
 *   为这点差别去 spawn `reg query` 不值得 —— 直接用 hostname。
 *
 * `platform` / `run` 可注入，只为测试（win32 上也能验 darwin / linux 分支）。
 */
export async function detectDefaultName(
  platform: NodeJS.Platform = process.platform,
  run: (file: string, args: string[]) => Promise<string | null> = runProbe
): Promise<string | null> {
  let value: string | null = null
  try {
    if (platform === 'darwin') value = await run('scutil', ['--get', 'ComputerName'])
    else if (platform === 'linux') value = await run('hostnamectl', ['--pretty'])
  } catch {
    value = null
  }
  return sanitizeDeviceName(value) || null
}

/**
 * 首次读身份时补一次友好名探测（只在连接页打开时调，幂等）。
 *
 * 已经存在且用户手动改过名（`nameEditedAt` 有值）→ 一个字都不动。
 */
export async function ensureDeviceNameProbe(
  detect: () => Promise<string | null> = () => detectDefaultName()
): Promise<CloudDeviceRecord> {
  const record = readCloudDevice()
  const probed = sanitizeDeviceName(await detect())
  if (!probed) return record
  if (record.nameEditedAt && record.name === probed) return record

  const next: CloudDeviceRecord = {
    ...record,
    defaultName: probed,
    name: record.nameEditedAt ? record.name : probed,
  }
  if (next.name === record.name && next.defaultName === record.defaultName) return record
  persist(next)
  return next
}

/** 发给云端的一轮归属标签：只做记忆归属与审计，不构成授权、不进 prompt */
export function deviceAuthor(record: CloudDeviceRecord = readCloudDevice()): CloudDeviceAuthor {
  return {
    id: `pi-workbench/${record.id}`,
    name: record.name,
    is_bot: false,
  }
}

export function deviceSummary(
  record: CloudDeviceRecord = readCloudDevice()
): CloudDeviceSummary {
  return { id: record.id, name: record.name, defaultName: record.defaultName }
}

/**
 * 记一条「这个会话是哪台设备发起的」。
 *
 * 只服务本机展示（D3 多设备时用它标出「另一台设备发起」），不是云端真相；
 * 写失败不影响这一轮对话，所以调用方吞掉异常。
 */
export function recordSessionDevice(
  sessionId: string,
  record: CloudDeviceRecord = readCloudDevice()
): void {
  const id = sessionId.trim()
  if (!id) return
  const index = readSessionDevices()
  if (index[id]) return
  const next: Record<string, CloudDeviceSessionEntry> = {
    [id]: { deviceId: record.id, deviceName: record.name, firstSeenAt: Date.now() },
    ...index,
  }
  const trimmed = Object.fromEntries(
    Object.entries(next)
      .sort((a, b) => b[1].firstSeenAt - a[1].firstSeenAt)
      .slice(0, SESSION_INDEX_LIMIT)
  )
  writeJsonAtomicSync(deviceSessionsFile(), trimmed)
}

export function readSessionDevices(): Record<string, CloudDeviceSessionEntry> {
  const stored = readJsonWithBackup<Record<string, CloudDeviceSessionEntry>>(
    deviceSessionsFile()
  ).data
  if (!stored || typeof stored !== 'object') return {}
  return stored
}
