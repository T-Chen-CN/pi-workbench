/**
 * 云端连接配置：`data/cloud-agent/connection.json`
 *
 * 凭据用 safeStorage 加密（`enc:` 前缀），与 apiConfig 同一套约定；
 * 渲染层只能知道「有没有设备 token」，拿不到明文。
 *
 * **C-2：本地只有一扇门**。业务请求一律走 `gatewayUrl` + 设备 token；
 * 不保留任何直连客户端，也没有「换个凭据再试一次」的分支。
 *
 * 功能未上线，不做历史迁移：盘上只允许目标字段，旧字段（管理密钥、控制台
 * 账号口令、handoff 记录、直连地址）读取时忽略，并在 `config:get` 时清掉。
 */

import * as path from 'path'
import { getAppDir } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomicSync } from '../atomic-json.js'
import { decryptSecret, encryptSecret } from '../secret-crypto.js'
import {
  DEFAULT_CLOUD_DASHBOARD_URL,
  DEFAULT_CLOUD_GATEWAY_URL,
  deriveDashboardUrl,
  normalizeBaseUrl,
} from './url.js'

// 地址工具在 `url.ts`（纯函数）；这里再导出一次，保持既有调用方不变
export {
  DEFAULT_CLOUD_DASHBOARD_URL,
  DEFAULT_CLOUD_GATEWAY_URL,
  deriveDashboardUrl,
  normalizeBaseUrl,
}

interface StoredCloudConfig {
  /** 网关（单入口）地址：本地只有这一个门（C-2：没有直连兜底） */
  gatewayUrl?: string
  /** 设备 token（`pi_…`），safeStorage 加密；由配对接口一次性发放 */
  deviceToken?: string
  /** 配对时授予的 scope 快照，仅供界面展示 */
  deviceScopes?: string[]
  deviceId?: string
  dashboardUrl?: string
}

export interface CloudConfig {
  /** 网关地址（唯一的门） */
  gatewayUrl: string
  /** 设备 token 明文：只在主进程内使用 */
  deviceToken: string
  hasDeviceToken: boolean
  deviceScopes: string[]
  deviceId: string
  dashboardUrl: string
}

export function cloudConfigFile(): string {
  return path.join(getAppDir(), 'data', 'cloud-agent', 'connection.json')
}

/** 目标 schema：多一个字段都不落盘 */
const ALLOWED_CONFIG_KEYS = [
  'gatewayUrl',
  'deviceToken',
  'deviceScopes',
  'deviceId',
  'dashboardUrl',
] as const

/**
 * 把主文件里不属于目标 schema 的字段清掉（只动主文件，不碰 `.bak`）。
 * 没有可清的字段时一次 IO 都不做；清不掉不影响任何读写，下次 `config:get` 再试。
 */
export function pruneUnknownCloudConfig(): void {
  const file = cloudConfigFile()
  const { data } = readJsonWithBackup<Record<string, unknown>>(file)
  if (!data || typeof data !== 'object') return
  const unknown = Object.keys(data).filter(
    (key) => !(ALLOWED_CONFIG_KEYS as readonly string[]).includes(key)
  )
  if (unknown.length === 0) return
  const cleaned: Record<string, unknown> = {}
  for (const key of ALLOWED_CONFIG_KEYS) {
    if (key in data) cleaned[key] = data[key]
  }
  try {
    writeJsonAtomicSync(file, cleaned)
  } catch {
    // 清不掉不影响任何读写
  }
}

export function readCloudConfig(): CloudConfig {
  const stored = readJsonWithBackup<StoredCloudConfig>(cloudConfigFile()).data
  const deviceToken = decryptSecret(stored?.deviceToken ?? '')
  const gatewayUrl =
    normalizeBaseUrl(stored?.gatewayUrl ?? '') || DEFAULT_CLOUD_GATEWAY_URL
  const dashboardUrl =
    normalizeBaseUrl(stored?.dashboardUrl ?? '') || DEFAULT_CLOUD_DASHBOARD_URL
  return {
    gatewayUrl,
    deviceToken,
    hasDeviceToken: Boolean(deviceToken),
    deviceScopes: Array.isArray(stored?.deviceScopes) ? stored.deviceScopes.map(String) : [],
    deviceId: String(stored?.deviceId ?? ''),
    dashboardUrl,
  }
}

export function writeCloudConfig(input: {
  gatewayUrl?: string
  deviceToken?: string
  deviceScopes?: string[]
  deviceId?: string
  dashboardUrl?: string
}): CloudConfig {
  const current = readCloudConfig()
  // 留空表示沿用旧值；显式传入才覆盖
  const pick = (value: string | undefined, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback
  const nextDeviceToken = pick(input.deviceToken, current.deviceToken)
  const nextGatewayUrl =
    normalizeBaseUrl(input.gatewayUrl ?? '') || current.gatewayUrl || DEFAULT_CLOUD_GATEWAY_URL
  const nextDeviceScopes = input.deviceScopes ?? current.deviceScopes
  const nextDeviceId = pick(input.deviceId, current.deviceId)
  const dashboardUrl =
    normalizeBaseUrl(input.dashboardUrl ?? '') || current.dashboardUrl || DEFAULT_CLOUD_DASHBOARD_URL
  const stored: StoredCloudConfig = {
    gatewayUrl: nextGatewayUrl,
    deviceToken: nextDeviceToken ? encryptSecret(nextDeviceToken) : '',
    deviceScopes: nextDeviceScopes,
    deviceId: nextDeviceId || undefined,
    dashboardUrl,
  }
  writeJsonAtomicSync(cloudConfigFile(), stored)
  return {
    gatewayUrl: nextGatewayUrl,
    deviceToken: nextDeviceToken,
    hasDeviceToken: Boolean(nextDeviceToken),
    deviceScopes: nextDeviceScopes,
    deviceId: nextDeviceId,
    dashboardUrl,
  }
}

/**
 * 注销 / 断开后清掉**这台设备**的凭据（token / scope / id）。
 * 保留网关与控制台地址：界面还要显示它们，重新配对也默认用同一台服务器。
 */
export function clearDeviceCredentials(): CloudConfig {
  const current = readCloudConfig()
  const stored: StoredCloudConfig = {
    gatewayUrl: current.gatewayUrl || undefined,
    dashboardUrl: current.dashboardUrl,
    deviceToken: '',
    deviceScopes: [],
    deviceId: undefined,
  }
  writeJsonAtomicSync(cloudConfigFile(), stored)
  return {
    ...current,
    deviceToken: '',
    hasDeviceToken: false,
    deviceScopes: [],
    deviceId: '',
  }
}

/**
 * 实际发请求用的「地址 + 凭据」。
 *
 * **只有一个门**：有设备 token 就走网关（C-1 单缝、C-2 无自动兜底）；
 * 单入口（C-2）：网关地址 + 设备 token，除此之外没有任何凭据。
 */
export function cloudTransport(config = readCloudConfig()): {
  baseUrl: string
  credential: string
} {
  // 只有一扇门（C-2）。没有设备 token = 没有凭据 = 上层明确报错，
  // 不存在「换个客户端再试一次」这条路。
  return {
    baseUrl: config.gatewayUrl,
    credential: config.deviceToken,
  }
}

/** 只暴露给渲染层的字段 */
export function publicCloudConfig(config = readCloudConfig()): {
  gatewayUrl: string
  hasDeviceToken: boolean
  deviceScopes: string[]
  deviceId: string
  dashboardUrl: string
} {
  return {
    gatewayUrl: config.gatewayUrl,
    hasDeviceToken: config.hasDeviceToken,
    deviceScopes: config.deviceScopes,
    deviceId: config.deviceId,
    dashboardUrl: config.dashboardUrl,
  }
}
