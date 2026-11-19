/**
 * 云端连接凭据（F-05 的本机落盘侧）。
 *
 * 只保存「哪台云端 + 本机是哪台设备 + token」；token 用 safeStorage 加密，
 * 与 API Key 同一套 `enc:` 口径。设备名在配对时上报，之后不再变。
 */

import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { getAppDir } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.js'
import { decryptSecret, encryptSecret } from '../secret-crypto.js'

export interface CloudLinkRecord {
  /** 云端根地址，如 https://tchen-xiaoxiao.com（不带尾斜杠） */
  baseUrl: string
  deviceId: string
  deviceName: string
  /** safeStorage 加密后的 token（`enc:` 前缀） */
  token: string
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

/** 解密后的 token；解不出来（换机 / 系统密钥失效）时返回空串，调用方按未连接处理 */
export function readCloudToken(record: CloudLinkRecord | null): string {
  if (!record) return ''
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
}): Promise<CloudLinkRecord> {
  const record: CloudLinkRecord = {
    baseUrl: normalizeBaseUrl(input.baseUrl),
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    token: encryptSecret(input.token),
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
  if (!existsSync(file)) return
  await writeJsonAtomic(file, {})
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`
  return trimmed
}

/** ws(s) 根地址：与云端同源，路径由协议常量给出 */
export function wsUrl(baseUrl: string, pathname: string): string {
  const url = new URL(normalizeBaseUrl(baseUrl))
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = pathname
  url.search = ''
  return url.toString()
}
