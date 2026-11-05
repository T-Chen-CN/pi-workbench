/**
 * 云端连接配置：`data/cloud-agent/connection.json`
 *
 * 密钥用 safeStorage 加密（`enc:` 前缀），与 apiConfig 同一套约定；
 * 渲染层永远只拿到 `hasToken`。
 */

import * as path from 'path'
import { getAppDir } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomicSync } from '../atomic-json.js'
import { decryptSecret, encryptSecret } from '../secret-crypto.js'
import {
  DEFAULT_CLOUD_BASE_URL,
  DEFAULT_CLOUD_DASHBOARD_URL,
  DEFAULT_CLOUD_GATEWAY_URL,
  deriveDashboardUrl,
  deriveGatewayUrl,
  normalizeBaseUrl,
} from './url.js'

// 地址工具在 `url.ts`（纯函数）；这里再导出一次，保持既有调用方不变
export {
  DEFAULT_CLOUD_BASE_URL,
  DEFAULT_CLOUD_DASHBOARD_URL,
  DEFAULT_CLOUD_GATEWAY_URL,
  deriveDashboardUrl,
  deriveGatewayUrl,
  normalizeBaseUrl,
}

interface StoredCloudConfig {
  baseUrl?: string
  apiKey?: string
  /** 网关（单入口）地址：本地只认这一个门，除非显式回滚到直连 */
  gatewayUrl?: string
  /** 设备 token（`pi_…`），safeStorage 加密；由网关登记时一次性发放 */
  deviceToken?: string
  /** 登记时授予的 scope 快照，仅供界面展示 */
  deviceScopes?: string[]
  deviceId?: string
  dashboardUrl?: string
  /**
   * 控制台会话令牌（服务端 `.env` 里的 `HERMES_DASHBOARD_SESSION_TOKEN`）。
   * 只有它能让主进程直接调控制台的 `/api/*`（图片上传、读回图片字节）。
   */
  dashboardToken?: string
  /** 控制台账号：用户名不加密，口令走 `enc:` */
  dashboardUser?: string
  dashboardPassword?: string
  /** 上一次从交接文件导入的时间与 profile（只作记录，不上界面） */
  handoffImportedAt?: number
  handoffProfile?: string
}

export interface CloudConfig {
  baseUrl: string
  /** 网关地址（默认由 `api.` 派生 `hub.`） */
  gatewayUrl: string
  /** 设备 token 明文：只在主进程内使用 */
  deviceToken: string
  hasDeviceToken: boolean
  deviceScopes: string[]
  deviceId: string
  dashboardUrl: string
  /** 明文密钥：只在主进程内使用，不经过 IPC 返回 */
  apiKey: string
  hasToken: boolean
  /** 控制台会话令牌明文（主进程内使用） */
  dashboardToken: string
  hasDashboardToken: boolean
  dashboardUser: string
  /** 控制台口令明文（主进程内使用，只用于「复制口令」） */
  dashboardPassword: string
  hasDashboardPassword: boolean
  handoffImportedAt: number | null
  handoffProfile: string
}

export function cloudConfigFile(): string {
  return path.join(getAppDir(), 'data', 'cloud-agent', 'connection.json')
}

export function readCloudConfig(): CloudConfig {
  const stored = readJsonWithBackup<StoredCloudConfig>(cloudConfigFile()).data
  const baseUrl = normalizeBaseUrl(stored?.baseUrl ?? '') || DEFAULT_CLOUD_BASE_URL
  const apiKey = decryptSecret(stored?.apiKey ?? '')
  const deviceToken = decryptSecret(stored?.deviceToken ?? '')
  const gatewayUrl =
    normalizeBaseUrl(stored?.gatewayUrl ?? '') || deriveGatewayUrl(baseUrl) || DEFAULT_CLOUD_GATEWAY_URL
  const dashboardUrl =
    normalizeBaseUrl(stored?.dashboardUrl ?? '') || deriveDashboardUrl(baseUrl)
  const dashboardToken = decryptSecret(stored?.dashboardToken ?? '')
  const dashboardPassword = decryptSecret(stored?.dashboardPassword ?? '')
  return {
    baseUrl,
    gatewayUrl,
    deviceToken,
    hasDeviceToken: Boolean(deviceToken),
    deviceScopes: Array.isArray(stored?.deviceScopes) ? stored!.deviceScopes!.map(String) : [],
    deviceId: String(stored?.deviceId ?? ''),
    dashboardUrl,
    apiKey,
    hasToken: Boolean(apiKey),
    dashboardToken,
    hasDashboardToken: Boolean(dashboardToken),
    dashboardUser: stored?.dashboardUser ?? '',
    dashboardPassword,
    hasDashboardPassword: Boolean(dashboardPassword),
    handoffImportedAt:
      typeof stored?.handoffImportedAt === 'number' ? stored.handoffImportedAt : null,
    handoffProfile: stored?.handoffProfile ?? '',
  }
}

export function writeCloudConfig(input: {
  baseUrl: string
  gatewayUrl?: string
  deviceToken?: string
  deviceScopes?: string[]
  deviceId?: string
  apiKey?: string
  dashboardToken?: string
  /** 交接文件里的控制台地址可能与 `api.` 派生规则不一致，允许显式覆盖 */
  dashboardUrl?: string
  dashboardUser?: string
  dashboardPassword?: string
  handoffImportedAt?: number
  handoffProfile?: string
}): CloudConfig {
  const current = readCloudConfig()
  const baseUrl = normalizeBaseUrl(input.baseUrl) || DEFAULT_CLOUD_BASE_URL
  // 留空表示沿用旧值；显式传入才覆盖
  const pick = (value: string | undefined, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback
  const nextKey = pick(input.apiKey, current.apiKey)
  const nextDeviceToken = pick(input.deviceToken, current.deviceToken)
  // 显式传入优先，否则按 baseUrl 派生（不沿用旧值：地址改了网关就该跟着改）
  const nextGatewayUrl = normalizeBaseUrl(input.gatewayUrl ?? '') || deriveGatewayUrl(baseUrl)
  const nextDeviceScopes = input.deviceScopes ?? current.deviceScopes
  const nextDeviceId = pick(input.deviceId, current.deviceId)
  const nextDashboardToken = pick(input.dashboardToken, current.dashboardToken)
  const nextDashboardUser = pick(input.dashboardUser, current.dashboardUser)
  const nextDashboardPassword = pick(input.dashboardPassword, current.dashboardPassword)
  const nextProfile = pick(input.handoffProfile, current.handoffProfile)
  const nextImportedAt =
    typeof input.handoffImportedAt === 'number'
      ? input.handoffImportedAt
      : current.handoffImportedAt
  const dashboardUrl = normalizeBaseUrl(input.dashboardUrl ?? '') || deriveDashboardUrl(baseUrl)
  const stored: StoredCloudConfig = {
    baseUrl,
    gatewayUrl: nextGatewayUrl,
    deviceToken: nextDeviceToken ? encryptSecret(nextDeviceToken) : '',
    deviceScopes: nextDeviceScopes,
    deviceId: nextDeviceId || undefined,
    dashboardUrl,
    apiKey: nextKey ? encryptSecret(nextKey) : '',
    dashboardToken: nextDashboardToken ? encryptSecret(nextDashboardToken) : '',
    dashboardUser: nextDashboardUser,
    dashboardPassword: nextDashboardPassword ? encryptSecret(nextDashboardPassword) : '',
    handoffImportedAt: nextImportedAt ?? undefined,
    handoffProfile: nextProfile || undefined,
  }
  writeJsonAtomicSync(cloudConfigFile(), stored)
  return {
    ...readCloudConfig(),
    baseUrl,
    gatewayUrl: nextGatewayUrl,
    deviceToken: nextDeviceToken,
    hasDeviceToken: Boolean(nextDeviceToken),
    deviceScopes: nextDeviceScopes,
    deviceId: nextDeviceId,
    dashboardUrl,
    apiKey: nextKey,
    hasToken: Boolean(nextKey),
    dashboardToken: nextDashboardToken,
    hasDashboardToken: Boolean(nextDashboardToken),
    dashboardUser: nextDashboardUser,
    dashboardPassword: nextDashboardPassword,
    hasDashboardPassword: Boolean(nextDashboardPassword),
    handoffImportedAt: nextImportedAt,
    handoffProfile: nextProfile,
  }
}

/**
 * 注销设备后清掉**这台设备**的凭据（token / scope / id）。
 *
 * 与 `clearCloudToken()` 的区别：这里刻意保留网关地址和 `apiKey`——
 * 网关地址还要显示给用户，`apiKey` 是运维改配置时唯一的回滚手段。
 */
export function clearDeviceCredentials(): CloudConfig {
  const current = readCloudConfig()
  const stored: StoredCloudConfig = {
    baseUrl: current.baseUrl,
    gatewayUrl: current.gatewayUrl || undefined,
    dashboardUrl: current.dashboardUrl,
    dashboardUser: current.dashboardUser,
    handoffImportedAt: current.handoffImportedAt ?? undefined,
    handoffProfile: current.handoffProfile || undefined,
    apiKey: current.apiKey ? encryptSecret(current.apiKey) : '',
    dashboardToken: current.dashboardToken ? encryptSecret(current.dashboardToken) : '',
    dashboardPassword: current.dashboardPassword ? encryptSecret(current.dashboardPassword) : '',
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

/** 断开连接：丢掉密钥，保留地址（下次只需重新粘密钥） */
export function clearCloudToken(): CloudConfig {
  const current = readCloudConfig()
  const stored: StoredCloudConfig = {
    baseUrl: current.baseUrl,
    dashboardUrl: current.dashboardUrl,
    // 账号与导入记录留着：下次只需重新粘密钥
    dashboardUser: current.dashboardUser,
    handoffImportedAt: current.handoffImportedAt ?? undefined,
    handoffProfile: current.handoffProfile || undefined,
    apiKey: '',
    deviceToken: '',
    deviceScopes: [],
    dashboardToken: '',
    dashboardPassword: '',
  }
  writeJsonAtomicSync(cloudConfigFile(), stored)
  return {
    ...current,
    apiKey: '',
    hasToken: false,
    deviceToken: '',
    hasDeviceToken: false,
    deviceScopes: [],
    dashboardToken: '',
    hasDashboardToken: false,
    dashboardPassword: '',
    hasDashboardPassword: false,
  }
}

/**
 * 实际发请求用的「地址 + 凭据」。
 *
 * **只有一个门**：有设备 token 就走网关（C-1 单缝、C-2 无自动兜底）；
 * 没有设备 token 时才落到老的直连字段上 —— 那是登记完成前的过渡态，
 * 也是唯一的手工回滚手段（QN-5）。
 */
export function cloudTransport(config = readCloudConfig()): {
  baseUrl: string
  credential: string
  viaGateway: boolean
  dashboardBaseUrl: string
  dashboardToken: string
} {
  if (config.hasDeviceToken) {
    return {
      baseUrl: config.gatewayUrl,
      credential: config.deviceToken,
      viaGateway: true,
      // 图片上传与图片读回也走网关（本地因此不需要控制台令牌）
      dashboardBaseUrl: config.gatewayUrl,
      dashboardToken: config.deviceToken,
    }
  }
  return {
    baseUrl: config.baseUrl,
    credential: config.apiKey,
    viaGateway: false,
    dashboardBaseUrl: config.dashboardUrl,
    dashboardToken: config.dashboardToken,
  }
}

/** 只暴露给渲染层的字段 */
export function publicCloudConfig(config = readCloudConfig()): {
  baseUrl: string
  gatewayUrl: string
  hasToken: boolean
  hasDeviceToken: boolean
  deviceScopes: string[]
  deviceId: string
  dashboardUrl: string
  hasDashboardToken: boolean
  dashboardUser: string
  hasDashboardPassword: boolean
} {
  return {
    baseUrl: config.baseUrl,
    gatewayUrl: config.gatewayUrl,
    hasToken: config.hasToken,
    hasDeviceToken: config.hasDeviceToken,
    deviceScopes: config.deviceScopes,
    deviceId: config.deviceId,
    dashboardUrl: config.dashboardUrl,
    hasDashboardToken: config.hasDashboardToken,
    dashboardUser: config.dashboardUser,
    hasDashboardPassword: config.hasDashboardPassword,
  }
}
