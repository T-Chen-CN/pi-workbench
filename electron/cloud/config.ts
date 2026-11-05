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
  return {
    baseUrl,
    dashboardUrl,
    apiKey,
    hasToken: Boolean(apiKey),
    dashboardToken,
    hasDashboardToken: Boolean(dashboardToken),
  }
}

export function writeCloudConfig(input: {
  baseUrl: string
  apiKey?: string
  dashboardToken?: string
}): CloudConfig {
  const current = readCloudConfig()
  const baseUrl = normalizeBaseUrl(input.baseUrl) || DEFAULT_CLOUD_BASE_URL
  // 留空表示沿用旧密钥；显式传入才覆盖
  const nextKey =
    typeof input.apiKey === 'string' && input.apiKey.trim()
      ? input.apiKey.trim()
      : current.apiKey
  const nextDashboardToken =
    typeof input.dashboardToken === 'string' && input.dashboardToken.trim()
      ? input.dashboardToken.trim()
      : current.dashboardToken
  const stored: StoredCloudConfig = {
    baseUrl,
    dashboardUrl: deriveDashboardUrl(baseUrl),
    apiKey: nextKey ? encryptSecret(nextKey) : '',
    dashboardToken: nextDashboardToken ? encryptSecret(nextDashboardToken) : '',
  }
  writeJsonAtomicSync(cloudConfigFile(), stored)
  return {
    baseUrl,
    dashboardUrl: stored.dashboardUrl ?? deriveDashboardUrl(baseUrl),
    apiKey: nextKey,
    hasToken: Boolean(nextKey),
    dashboardToken: nextDashboardToken,
    hasDashboardToken: Boolean(nextDashboardToken),
  }
}

/** 断开连接：丢掉密钥，保留地址（下次只需重新粘密钥） */
export function clearCloudToken(): CloudConfig {
  const current = readCloudConfig()
  const stored: StoredCloudConfig = {
    baseUrl: current.baseUrl,
    dashboardUrl: current.dashboardUrl,
    apiKey: '',
    dashboardToken: '',
  }
  writeJsonAtomicSync(cloudConfigFile(), stored)
  return { ...current, apiKey: '', hasToken: false, dashboardToken: '', hasDashboardToken: false }
}

/** 只暴露给渲染层的字段 */
export function publicCloudConfig(config = readCloudConfig()): {
  baseUrl: string
  dashboardUrl: string
  hasToken: boolean
  hasDashboardToken: boolean
} {
  return {
    baseUrl: config.baseUrl,
    dashboardUrl: config.dashboardUrl,
    hasToken: config.hasToken,
    hasDashboardToken: config.hasDashboardToken,
  }
}
