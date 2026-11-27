/**
 * 云端连接凭据（F-05 的本机落盘侧）。
 *
 * 只保存「哪台云端 + 本机是哪台设备 + token」；token 用 safeStorage 加密，
 * 与 API Key 同一套 `enc:` 口径。设备名在配对时上报，之后不再变。
 */

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { getAppDir } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomic, writeJsonAtomicAsync } from '../atomic-json.js'
import { decryptSecret, encryptSecret } from '../secret-crypto.js'

export interface CloudLinkRecord {
  /** 云端根地址，如 https://cloud.example.com（不带尾斜杠） */
  baseUrl: string
  deviceId: string
  deviceName: string
  /** safeStorage 加密后的设备执行 token（`enc:` 前缀，仅用于 /device/ws 与工作区上报） */
  token: string
  /** safeStorage 加密后的桌面用户控制面 token（`enc:` 前缀，用于 /client/ws 与管理 REST；缺省时回退 token 兼容旧配对） */
  clientToken?: string
  pairedAt: number
  /** 上次成功连上的时间，用于 UI 展示 */
  lastConnectedAt?: number
}

export interface CloudLinkView {
  linked: boolean
  baseUrl?: string
  deviceId?: string
  deviceName?: string
  pairedAt?: number
  lastConnectedAt?: number
}

const FILE_NAME = 'cloud-link.json'

function linkPath(): string {
  return path.join(getAppDir(), 'config', FILE_NAME)
}

export function readCloudLink(): CloudLinkRecord | null {
  const file = linkPath()
  if (!existsSync(file)) return null
  const result = readJsonWithBackup<CloudLinkRecord>(file)
  if (!result.data || typeof result.data !== 'object') return null
  const record = result.data
  if (!record.baseUrl || !record.deviceId || !record.token) return null
  return record
}

/** 解密后的设备执行 token；解不出来（换机 / 系统密钥失效）时返回空串，调用方按未连接处理 */
export function readCloudToken(record: CloudLinkRecord | null): string {
  if (!record) return ''
  return decryptSecret(record.token)
}

/** 解密后的桌面控制面 token；老配对记录没有独立 clientToken 时回退设备 token */
export function readCloudClientToken(record: CloudLinkRecord | null): string {
  if (!record) return ''
  if (record.clientToken) return decryptSecret(record.clientToken)
  return decryptSecret(record.token)
}

export function toLinkView(record: CloudLinkRecord | null): CloudLinkView {
  if (!record) return { linked: false }
  return {
    linked: true,
    baseUrl: record.baseUrl,
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    pairedAt: record.pairedAt,
    lastConnectedAt: record.lastConnectedAt,
  }
}

export async function saveCloudLink(input: {
  baseUrl: string
  deviceId: string
  deviceName: string
  token: string
  clientToken?: string
}): Promise<CloudLinkRecord> {
  const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl)
  if (!normalizedBaseUrl) throw new Error('Invalid cloud base URL')
  const record: CloudLinkRecord = {
    baseUrl: normalizedBaseUrl,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    token: encryptSecret(input.token),
    ...(input.clientToken ? { clientToken: encryptSecret(input.clientToken) } : {}),
    pairedAt: Date.now(),
  }
  await writeJsonAtomic(linkPath(), record)
  return record
}

export async function touchCloudLink(record: CloudLinkRecord): Promise<void> {
  await writeJsonAtomic(linkPath(), { ...record, lastConnectedAt: Date.now() })
}

export async function clearCloudLink(): Promise<void> {
  const file = linkPath()
  if (existsSync(file)) {
    // 清理连接凭据不能写 .bak，否则旧加密 token 会滞留磁盘
    await writeJsonAtomicAsync(file, {}, { backup: false })
  }
  await fs.rm(`${file}.bak`, { force: true }).catch(() => undefined)
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '[::1]' || lower === '::1'
}

/** 拒绝云厂商链路本地元数据地址（AWS/GCP/Azure IMDS 等），避免误连或 SSRF 暴露本机凭据 */
function isBlockedMetadataHost(hostname: string): boolean {
  const unbracketed = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '')
  if (!unbracketed) return true
  if (
    unbracketed === 'metadata.google.internal' ||
    unbracketed.endsWith('.metadata.google.internal') ||
    unbracketed === 'metadata.goog' ||
    unbracketed === 'fd00:ec2::254'
  ) {
    return true
  }
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(unbracketed)) return true
  // IPv6 映射的 169.254.0.0/16（WHATWG URL 会归一化成 ::ffff:a9fe:xxxx）与 fe80::/10 链路本地地址
  if (/^::ffff:(?:a9fe:[0-9a-f]{1,4}|169\.254\.\d{1,3}\.\d{1,3})$/.test(unbracketed)) return true
  if (/^fe[89ab][0-9a-f]:/.test(unbracketed)) return true
  return false
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    if (!parsed.hostname) return ''
    if (isBlockedMetadataHost(parsed.hostname)) return ''
    // 远程主机必须走 HTTPS；仅回环开发地址允许明文 HTTP
    if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) return ''
    return parsed.origin + parsed.pathname.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/** ws(s) 根地址：与云端同源，路径由协议常量给出 */
export function wsUrl(baseUrl: string, pathname: string): string {
  const url = new URL(normalizeBaseUrl(baseUrl))
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = pathname
  url.search = ''
  return url.toString()
}
