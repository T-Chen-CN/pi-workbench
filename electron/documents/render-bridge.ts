/**
 * 扫描页渲染桥：主进程 → 渲染层 → PNG。
 *
 * 为什么不在主进程渲：pdf.js 画一页需要 2D canvas，主进程没有；而渲染层已经为
 * PDF 阅读视图装好了 pdf.js + worker + 随包字体，复用它不新增任何依赖
 * （`@napi-rs/canvas` 光 Windows 二进制就 38MB，为这条链路不值当）。
 *
 * 安全边界：**主进程把字节发给渲染层**，而不是让渲染层按路径自己去读文件。
 * 渲染层始终没有「传任意路径读内容」的能力，工作区校验不需要放宽。
 *
 * 失败即降级：没有窗口、超时、渲染报错都只是让 Agent 拿到文字说明
 * （"这一页渲染失败"），不会让整轮对话失败。
 */

import { BrowserWindow } from 'electron'
import * as fs from 'fs/promises'
import { randomUUID } from 'crypto'
import type { DocumentImage, RenderPagesRequest } from './extract.js'

/** 单次渲染请求大小上限：超过就放弃渲染，避免把 200MB 的 PDF 搬进渲染层 */
const MAX_RENDER_BYTES = 64 * 1024 * 1024
/** 渲染超时：扫 3 页通常 1~3 秒，隐藏窗口被节流时可能更慢 */
const RENDER_TIMEOUT_MS = 60_000

interface PendingRender {
  resolve: (images: DocumentImage[]) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, PendingRender>()

export interface RenderRequestPayload {
  id: string
  /** 仅用于渲染层的错误提示 */
  name: string
  /** PDF 字节（结构化克隆传 Uint8Array，不走 base64） */
  bytes: Uint8Array
  /** 1 起始页码 */
  pages: number[]
  scale: number
}

export interface RenderResultPayload {
  id: string
  images?: { data: string; mimeType: string }[]
  error?: string
}

/** 优先用聚焦窗口（一定没被后台节流），否则退回任意可用窗口 */
function pickTargetWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed() && !focused.webContents.isDestroyed()) return focused
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) return win
  }
  return null
}

/** 渲染层回传结果；未知 id 直接忽略（窗口重启后的迟到响应） */
export function settleRenderRequest(payload: RenderResultPayload): void {
  const entry = pending.get(payload.id)
  if (!entry) return
  pending.delete(payload.id)
  clearTimeout(entry.timer)
  if (payload.error) entry.reject(new Error(payload.error))
  else entry.resolve(payload.images ?? [])
}

export function rejectAllRenderRequests(reason: string): void {
  for (const [id, entry] of pending) {
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
  }
}

async function requestRenders(payload: RenderRequestPayload): Promise<DocumentImage[]> {
  const target = pickTargetWindow()
  if (!target) throw new Error('没有可用窗口，无法渲染扫描页')

  return new Promise<DocumentImage[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(payload.id)
      reject(new Error('渲染超时'))
    }, RENDER_TIMEOUT_MS)
    pending.set(payload.id, { resolve, reject, timer })
    try {
      target.webContents.send('documents:render-request', payload)
    } catch (error) {
      pending.delete(payload.id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** 注入给 `readDocument` 的渲染实现：读字节 → 请渲染层画 → 回收 PNG */
export async function renderDocumentPages(request: RenderPagesRequest): Promise<DocumentImage[]> {
  const stats = await fs.stat(request.path)
  if (stats.size > MAX_RENDER_BYTES) {
    throw new Error(`文件超过 ${Math.round(MAX_RENDER_BYTES / 1024 / 1024)}MB，跳过扫描页渲染`)
  }
  const bytes = await fs.readFile(request.path)
  return requestRenders({
    id: randomUUID(),
    name: request.path.split(/[\\/]/).pop() ?? 'document.pdf',
    bytes: new Uint8Array(bytes),
    pages: request.pages,
    scale: request.scale,
  })
}
