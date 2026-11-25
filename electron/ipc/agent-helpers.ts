/** Agent IPC 共享上下文、会话 ID 校验、图片附件归一化与窗口广播 */

import { BrowserWindow } from 'electron'
import type { AgentRegistry } from '../agent-registry.js'
import type { ApprovalBroker } from '../approval-broker.js'
import type { PluginManager } from '../plugin-manager.js'

// 与 pi-bridge/src/chat-images.ts 和 docs/agent/agent-runtime.md 保持一致
const MAX_CHAT_IMAGES = 10
const MAX_IMAGE_BASE64_CHARS = Math.ceil((10 * 1024 * 1024 * 4) / 3)
const MAX_TOTAL_IMAGE_BASE64_CHARS = 48 * 1024 * 1024
const CHAT_IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/i

export interface LoggerLike {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

export interface NotificationPayload {
  kind: 'approval' | 'complete' | 'error'
  workspaceDir: string
  sessionId: string
  title: string
  body: string
}

export interface AgentIpcContext {
  agentRegistry: AgentRegistry
  approvalBroker: ApprovalBroker
  pluginManager: PluginManager
  getMainWindow: () => BrowserWindow | null
  getDefaultPermissionLevel: () => unknown
  getLanguage: () => 'zh' | 'en'
  logger: LoggerLike
  notificationText: () => { approval: string; complete: string; error: string }
  notify: (event: NotificationPayload) => void
}

/**
 * 校验会话 ID 合法性。
 * 会话 ID 会参与 sidecar/JSONL 文件名，必须在进程边界拒绝路径分隔符、`..` 与控制字符。
 */
export function isValidSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
}

/**
 * 校验并归一化图像附件：格式 / 张数 / 单张与总大小统一处理，
 * 超限明确报错而不是静默丢弃。chat 与 steer 共用。
 */
export function normalizeChatImages(images: unknown): {
  images: Array<{ data: string; mimeType: string }>
  error?: string
} {
  const safeImages: Array<{ data: string; mimeType: string }> = []
  if (images === undefined || images === null) return { images: safeImages }
  if (!Array.isArray(images)) {
    return { images: [], error: 'Images must be an array.' }
  }
  if (images.length > MAX_CHAT_IMAGES) {
    return {
      images: [],
      error: `At most ${MAX_CHAT_IMAGES} images can be sent at once.`,
    }
  }
  let totalChars = 0
  for (const image of images) {
    const data = (image as { data?: unknown } | null)?.data
    const mimeType = (image as { mimeType?: unknown } | null)?.mimeType
    if (typeof data !== 'string' || data.length === 0) {
      return { images: [], error: 'Invalid image payload.' }
    }
    if (typeof mimeType !== 'string' || !CHAT_IMAGE_MIME.test(mimeType)) {
      return { images: [], error: 'Unsupported image format.' }
    }
    if (data.length > MAX_IMAGE_BASE64_CHARS) {
      return { images: [], error: 'Each image must be at most 10 MB.' }
    }
    totalChars += data.length
    if (totalChars > MAX_TOTAL_IMAGE_BASE64_CHARS) {
      return { images: [], error: 'Images exceed the total size limit.' }
    }
    safeImages.push({ data, mimeType })
  }
  return { images: safeImages }
}

/**
 * 广播到所有窗口。
 * 面板可以拆成独立窗口（各自一个渲染进程），只发主窗口会让拆出的对话列
 * 收不到会话标题 / 工作树切换事件，只能等下一次列表刷新，出现标题回退与滞后。
 */
export function broadcastToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}
