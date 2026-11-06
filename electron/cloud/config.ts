/**
 * 云端连接配置：`data/cloud-agent/connection.json`
 *
 * 凭据用 safeStorage 加密（`enc:` 前缀），与 apiConfig 同一套约定；
 * 渲染层只能知道「有没有设备 token」，拿不到明文。
 *
 * **C-2：本地只有一扇门**。业务请求一律走 `gatewayUrl` + 设备 token；
 * 不保留任何直连客户端，也没有「换个凭据再试一次」的分支。
 */

import * as path from 'path'
import { getAppDir } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomicSync } from '../atomic-json.js'
import { decryptSecret, encryptSecret } from '../secret-crypto.js'
import {
  DEFAULT_CLOUD_DASHBOARD_URL,
  DEFAULT_CLOUD_GATEWAY_URL,
  deriveDashboardUrl,
  deriveGatewayUrl,
  normalizeBaseUrl,
} from './url.js'

// 地址工具在 `url.ts`（纯函数）；这里再导出一次，保持既有调用方不变
export {
  DEFAULT_CLOUD_DASHBOARD_URL,
  DEFAULT_CLOUD_GATEWAY_URL,
  deriveDashboardUrl,
  deriveGatewayUrl,
  normalizeBaseUrl,
}

interface StoredCloudConfig {
  /** 网关（单入口）地址：本地只有这一个门（C-2：没有直连兜底） */
  gatewayUrl?: string
  /** 设备 token（`pi_…`），safeStorage 加密；由网关登记时一次性发放 */
  deviceToken?: string
  /** 登记时授予的 scope 快照，仅供界面展示 */
  deviceScopes?: string[]
  deviceId?: string
  /**
   * 管理密钥（`enc:`，默认不存）。只有用户显式勾选「在本机记住」才会写入，
   * 用途仅限「登记这台设备 / 撤销别的设备」——它等于云端签发权，比设备 token 敏感。
   */
  adminKey?: string
  dashboardUrl?: string
  /** 控制台账号：用户名不加密，口令走 `enc:` */
  dashboardUser?: string
  dashboardPassword?: string
  /** 上一次从交接文件导入的时间与 profile（只作记录，不上界面） */
  handoffImportedAt?: number
  handoffProfile?: string
}

export interface CloudConfig {
  /** 网关地址（唯一的门） */
  gatewayUrl: string
  /** 设备 token 明文：只在主进程内使用 */
  deviceToken: string
  hasDeviceToken: boolean
  deviceScopes: string[]
  deviceId: string
  /** 管理密钥明文：只在主进程内使用；没有就是没记住 */
  adminKey: string
  hasAdminKey: boolean
  dashboardUrl: string
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

/**
 * 单入口之前留在盘上的字段。
 *
 * `baseUrl` 是直连时代的 API 地址；`dashboardToken` / `apiKey` 已经被设备 token 取代。
 * 读取时一直忽略；这里只负责把它们从文件里抹掉，避免运维看到「还有一把旧密钥」跟着排查半天。
 */
const LEGACY_CONFIG_KEYS = ['baseUrl', 'dashboardToken', 'apiKey'] as const

/** 清掉历史字段（只动主文件，不碰 .bak）；没有可清的字段时一次 IO 都不做。 */
export function pruneLegacyCloudConfig(): void {
  const file = cloudConfigFile()
  const { data } = readJsonWithBackup<Record<string, unknown>>(file)
  if (!data || typeof data !== 'object') return
  const legacy = LEGACY_CONFIG_KEYS.filter((key) => key in data)
  if (legacy.length === 0) return
  for (const key of legacy) delete data[key]
  try {
    writeJsonAtomicSync(file, data)
  } catch {
    // 清不掉不影响任何读写；下次 config:get 再试
  }
}

export function readCloudConfig(): CloudConfig {
  const stored = readJsonWithBackup<StoredCloudConfig>(cloudConfigFile()).data
  const deviceToken = decryptSecret(stored?.deviceToken ?? '')
  const gatewayUrl =
    normalizeBaseUrl(stored?.gatewayUrl ?? '') || DEFAULT_CLOUD_GATEWAY_URL
  const dashboardUrl =
    normalizeBaseUrl(stored?.dashboardUrl ?? '') || DEFAULT_CLOUD_DASHBOARD_URL
  const adminKey = decryptSecret(stored?.adminKey ?? '')
  const dashboardPassword = decryptSecret(stored?.dashboardPassword ?? '')
  return {
    gatewayUrl,
    deviceToken,
    hasDeviceToken: Boolean(deviceToken),
    deviceScopes: Array.isArray(stored?.deviceScopes) ? stored!.deviceScopes!.map(String) : [],
    deviceId: String(stored?.deviceId ?? ''),
    adminKey,
    hasAdminKey: Boolean(adminKey),
    dashboardUrl,
    dashboardUser: stored?.dashboardUser ?? '',
    dashboardPassword,
    hasDashboardPassword: Boolean(dashboardPassword),
    handoffImportedAt:
      typeof stored?.handoffImportedAt === 'number' ? stored.handoffImportedAt : null,
    handoffProfile: stored?.handoffProfile ?? '',
  }
}

export function writeCloudConfig(input: {
  gatewayUrl?: string
  deviceToken?: string
  deviceScopes?: string[]
  deviceId?: string
  adminKey?: string
  /** 交接文件里的控制台地址可能与默认派生规则不一致，允许显式覆盖 */
  dashboardUrl?: string
  dashboardUser?: string
  dashboardPassword?: string
  handoffImportedAt?: number
  handoffProfile?: string
}): CloudConfig {
  const current = readCloudConfig()
  // 留空表示沿用旧值；显式传入才覆盖
  const pick = (value: string | undefined, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback
  const nextDeviceToken = pick(input.deviceToken, current.deviceToken)
  const nextGatewayUrl =
    normalizeBaseUrl(input.gatewayUrl ?? '') || current.gatewayUrl || DEFAULT_CLOUD_GATEWAY_URL
  const nextDeviceScopes = input.deviceScopes ?? current.deviceScopes
  // 空串 = 用户点了「忘记」；undefined = 不动
  const nextAdminKey =
    input.adminKey === undefined ? current.adminKey : input.adminKey.trim()
  const nextDeviceId = pick(input.deviceId, current.deviceId)
  const nextDashboardUser = pick(input.dashboardUser, current.dashboardUser)
  const nextDashboardPassword = pick(input.dashboardPassword, current.dashboardPassword)
  const nextProfile = pick(input.handoffProfile, current.handoffProfile)
  const nextImportedAt =
    typeof input.handoffImportedAt === 'number'
      ? input.handoffImportedAt
      : current.handoffImportedAt
  const dashboardUrl =
    normalizeBaseUrl(input.dashboardUrl ?? '') || current.dashboardUrl || DEFAULT_CLOUD_DASHBOARD_URL
  const stored: StoredCloudConfig = {
    gatewayUrl: nextGatewayUrl,
    deviceToken: nextDeviceToken ? encryptSecret(nextDeviceToken) : '',
    deviceScopes: nextDeviceScopes,
    deviceId: nextDeviceId || undefined,
    adminKey: nextAdminKey ? encryptSecret(nextAdminKey) : undefined,
    dashboardUrl,
    dashboardUser: nextDashboardUser,
    dashboardPassword: nextDashboardPassword ? encryptSecret(nextDashboardPassword) : '',
    handoffImportedAt: nextImportedAt ?? undefined,
    handoffProfile: nextProfile || undefined,
  }
  writeJsonAtomicSync(cloudConfigFile(), stored)
  return {
    ...readCloudConfig(),
    gatewayUrl: nextGatewayUrl,
    deviceToken: nextDeviceToken,
    hasDeviceToken: Boolean(nextDeviceToken),
    deviceScopes: nextDeviceScopes,
    deviceId: nextDeviceId,
    adminKey: nextAdminKey,
    hasAdminKey: Boolean(nextAdminKey),
    dashboardUrl,
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
 * 与 `clearCloudToken()` 的区别：这里保留网关地址（界面还要显示它）。
 * 不保留任何别的凭据 —— 本地只有设备 token 一种凭据。
 */
export function clearDeviceCredentials(): CloudConfig {
  const current = readCloudConfig()
  const stored: StoredCloudConfig = {
    gatewayUrl: current.gatewayUrl || undefined,
    dashboardUrl: current.dashboardUrl,
    dashboardUser: current.dashboardUser,
    handoffImportedAt: current.handoffImportedAt ?? undefined,
    handoffProfile: current.handoffProfile || undefined,
    dashboardPassword: current.dashboardPassword ? encryptSecret(current.dashboardPassword) : '',
    deviceToken: '',
    deviceScopes: [],
    deviceId: undefined,
    adminKey: current.adminKey ? encryptSecret(current.adminKey) : undefined,
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
    gatewayUrl: current.gatewayUrl || undefined,
    dashboardUrl: current.dashboardUrl,
    // 账号与导入记录留着：下次只需重新粘密钥
    dashboardUser: current.dashboardUser,
    handoffImportedAt: current.handoffImportedAt ?? undefined,
    handoffProfile: current.handoffProfile || undefined,
    deviceToken: '',
    deviceScopes: [],
    adminKey: undefined,
    dashboardPassword: '',
  }
  writeJsonAtomicSync(cloudConfigFile(), stored)
  return {
    ...current,
    deviceToken: '',
    hasDeviceToken: false,
    deviceScopes: [],
    dashboardPassword: '',
    hasDashboardPassword: false,
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
  /** 本机是否记住了管理密钥（值永不出主进程） */
  hasAdminKey: boolean
  dashboardUrl: string
  dashboardUser: string
  hasDashboardPassword: boolean
} {
  return {
    gatewayUrl: config.gatewayUrl,
    hasDeviceToken: config.hasDeviceToken,
    deviceScopes: config.deviceScopes,
    deviceId: config.deviceId,
    hasAdminKey: config.hasAdminKey,
    dashboardUrl: config.dashboardUrl,
    dashboardUser: config.dashboardUser,
    hasDashboardPassword: config.hasDashboardPassword,
  }
}
