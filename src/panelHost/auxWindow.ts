/**
 * 原生独立面板窗口句柄（Phase E · 多 BrowserWindow 架构）。
 *
 * 拆窗不再通过 `window.open('about:blank')` 与跨文档 DOM Portal 实现，而是调用主进程
 * `panel:detach` IPC 派生独立的原生 `BrowserWindow`，回位调用 `panel:dock` IPC。
 */

import { api } from '../api'
import type { HostId, PanelId } from './types'

export interface AuxWindowRect {
  x: number
  y: number
  width: number
  height: number
}

export interface AuxWindowHandle {
  id: HostId
  close: () => void
  dispose: () => void
}

export interface OpenPanelWindowOptions {
  id: HostId
  workspaceDir: string
  panel: PanelId
  title: string
  rect: AuxWindowRect
  theme?: 'light' | 'dark'
  language?: 'zh' | 'en'
}

/**
 * 请求主进程创建一个独立的原生面板 BrowserWindow。
 * 失败时抛错，由调用方提示用户。
 */
export async function openPanelWindow(options: OpenPanelWindowOptions): Promise<AuxWindowHandle> {
  const result = await api.panelDetach({
    workspaceDir: options.workspaceDir,
    panel: options.panel,
    hostId: options.id,
    title: options.title,
    rect: options.rect,
    theme: options.theme,
    language: options.language,
  })
  if (!result.success) {
    throw new Error(result.error || 'aux-window-failed')
  }

  let closed = false
  const dock = () => {
    if (closed) return
    closed = true
    void api.panelDock(options.id)
  }

  return {
    id: options.id,
    close: dock,
    dispose: dock,
  }
}
