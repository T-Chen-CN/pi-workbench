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
  deriveDashboardUrl,
  normalizeBaseUrl,
} from './url.js'

// 地址工具在 `url.ts`（纯函数）；这里再导出一次，保持既有调用方不变
export { DEFAULT_CLOUD_BASE_URL, DEFAULT_CLOUD_DASHBOARD_URL, deriveDashboardUrl, normalizeBaseUrl }

interface StoredCloudConfig {
  baseUrl?: string
  apiKey?: string
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
  const dashboardUrl =
    normalizeBaseUrl(stored?.dashboardUrl ?? '') || deriveDashboardUrl(baseUrl)
  const dashboardToken = decryptSecret(stored?.dashboardToken ?? '')
  const dashboardPassword = decryptSecret(stored?.dashboardPassword ?? '')
  return {
    baseUrl,
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
    dashboardToken: '',
    dashboardPassword: '',
  }
  writeJsonAtomicSync(cloudConfigFile(), stored)
  return {
    ...current,
    apiKey: '',
    hasToken: false,
    dashboardToken: '',
    hasDashboardToken: false,
    dashboardPassword: '',
    hasDashboardPassword: false,
  }
}

/** 只暴露给渲染层的字段 */
export function publicCloudConfig(config = readCloudConfig()): {
  baseUrl: string
  dashboardUrl: string
  hasToken: boolean
  hasDashboardToken: boolean
  dashboardUser: string
  hasDashboardPassword: boolean
} {
  return {
    baseUrl: config.baseUrl,
    dashboardUrl: config.dashboardUrl,
    hasToken: config.hasToken,
    hasDashboardToken: config.hasDashboardToken,
    dashboardUser: config.dashboardUser,
    hasDashboardPassword: config.hasDashboardPassword,
  }
}
