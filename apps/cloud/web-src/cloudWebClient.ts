/**
 * 云端 Web 客户端协议帧归并适配、主题与语言偏好、HTTP 请求封装。
 * 共享类型、格式化工具与 WS 帧归并器统一来自 `@pi-workbench/cloud-ui`，翻译来自 `@pi-workbench/i18n`，
 * 零 Electron / zustand / 桌面 store 依赖。
 */

import { translate, type Language } from '@pi-workbench/i18n'
import {
  CLOUD_ACTIVE_TASK_STATUSES,
  CLOUD_PROVIDER_PRESETS,
  INITIAL_CLOUD_SESSION_STATE,
  applyCloudFrame,
  formatCloudTime,
  formatCloudTokens,
  parseCloudTagsInput,
  type ApplyCloudFrameResult,
  type CloudAuthorizationRow,
  type CloudAwaySummaryRow,
  type CloudCatalogModel,
  type CloudChatRow,
  type CloudDeviceRow,
  type CloudDocItem,
  type CloudDreamItem,
  type CloudMemoryItem,
  type CloudMemoryKind,
  type CloudNotice,
  type CloudPairCode,
  type CloudSessionState,
  type CloudTaskRow,
  type CloudUnitRow,
} from '@pi-workbench/cloud-ui'

export type WebTab = 'chat' | 'tasks' | 'devices' | 'memory' | 'settings'
export type WebTheme = 'light' | 'dark'
export type WebWsStatus = 'connecting' | 'open' | 'closed'

export interface WebMe {
  hasAccount: boolean
  authenticated: boolean
  version?: string
}

export interface WebCloudConfig {
  configured: boolean
  providerId?: string
  model?: string
  apiKeyMasked?: string
}

export type WebCatalogModel = CloudCatalogModel

export interface WebConfigDraft {
  providerId: string
  model: string
  apiKey: string
}

export type WebPairCode = CloudPairCode
export type WebTaskItem = CloudTaskRow
export type WebSessionState = CloudSessionState
export type FrameApplyResult = ApplyCloudFrameResult

export interface RequestResult<T = any> {
  ok: boolean
  status: number
  payload: T | null
  networkError?: boolean
}

export const THEME_STORAGE_KEY = 'pi-cloud-theme'
export const LANG_STORAGE_KEY = 'pi-cloud-lang'
export const ACTIVE_TASK_STATUSES = CLOUD_ACTIVE_TASK_STATUSES
export const PROVIDER_PRESETS = CLOUD_PROVIDER_PRESETS
export const INITIAL_WEB_SESSION_STATE = INITIAL_CLOUD_SESSION_STATE

export const TASK_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  assigned: '已派发',
  running: '执行中',
  waiting_human: '等你回答',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  expired: '已过期',
  rejected: '被拒绝',
}

export const AGENT_STATUS_LABELS: Record<string, string> = {
  idle: '空闲',
  thinking: '思考中…',
  replying: '回复中…',
  error: '异常',
}

export const MEMORY_KIND_LABELS: Record<CloudMemoryKind, string> = {
  fact: '事实',
  preference: '偏好',
  project: '项目',
  decision: '决策',
  todo: '待办',
}

export function getAgentStatusLabel(status: string, language: Language = 'zh'): string {
  switch (status) {
    case 'idle':
      return translate(language, 'cloudWebAgentIdle')
    case 'thinking':
      return translate(language, 'cloudAgentThinking')
    case 'replying':
      return translate(language, 'cloudAgentReplying')
    case 'error':
      return translate(language, 'cloudWebAgentError')
    default:
      return status
  }
}

export function formatTime(ts?: number): string {
  return formatCloudTime(ts, true)
}

export const formatTokens = formatCloudTokens
export const parseTagsInput = parseCloudTagsInput

export function resolveInitialTheme(): WebTheme {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // 隐私模式可能禁用 localStorage
  }
  const prefersDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  return prefersDark ? 'dark' : 'light'
}

export function applyTheme(theme: WebTheme): void {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.classList.toggle('dark', theme === 'dark')
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // 忽略存储限制
  }
}

export function resolveInitialLanguage(): Language {
  try {
    const saved = window.localStorage.getItem(LANG_STORAGE_KEY)
    if (saved === 'en' || saved === 'zh') return saved
  } catch {
    // 隐私模式可能禁用 localStorage
  }
  return 'zh'
}

export function applyLanguage(language: Language): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN'
  }
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, language)
  } catch {
    // 忽略存储限制
  }
}

export async function apiRequest<T = any>(
  method: string,
  path: string,
  body?: unknown,
  onUnauthorized?: () => void
): Promise<RequestResult<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    })
  } catch {
    return { ok: false, status: 0, payload: null, networkError: true }
  }
  let payload: T | null = null
  try {
    payload = (await response.json()) as T
  } catch {
    payload = null
  }
  if (response.status === 401 && path !== '/v1/login') {
    onUnauthorized?.()
  }
  return { ok: response.ok, status: response.status, payload }
}

/** 服务端 WS 帧纯状态归并：直接委派 `@pi-workbench/cloud-ui` 共享 reducer */
export function applyWebFrame(prev: WebSessionState, frame: unknown): FrameApplyResult {
  return applyCloudFrame(prev, frame, {
    matchOptimisticUserEcho: false,
    incrementUnreadOnEvents: false,
  })
}

export type {
  CloudAuthorizationRow,
  CloudAwaySummaryRow,
  CloudChatRow,
  CloudDeviceRow,
  CloudDocItem,
  CloudDreamItem,
  CloudMemoryItem,
  CloudMemoryKind,
  CloudNotice,
  CloudUnitRow,
  Language,
}
