/**
 * 面板宿主上下文。
 *
 * docked 面板拿到 `main`，拆出的面板拿到 `aux:<n>`。面板内部的组件用它来判断
 * 「我渲染在哪个文档里」——凡是需要挂全局监听、弹层、读焦点的地方都必须问它，
 * 否则会出现「快捷键在辅助窗口失灵」「弹窗跑到主窗口」这类错窗口问题。
 */

import React, { createContext, useContext, useEffect } from 'react'
import { usePanelStore } from '../store/panelStore'
import { MAIN_HOST } from './types'
import type { HostId } from './types'

const HostContext = createContext<HostId>(MAIN_HOST)

export const HostProvider: React.FC<{ host: HostId; children: React.ReactNode }> = ({
  host,
  children,
}) => <HostContext.Provider value={host}>{children}</HostContext.Provider>

export function useHostId(): HostId {
  return useContext(HostContext)
}

/** 宿主窗口的 window；辅助窗口已关闭时回落到主窗口 */
export function useHostWindow(): Window {
  const host = useHostId()
  const win = usePanelStore((state) => (host === MAIN_HOST ? null : state.windows[host]?.handle?.window ?? null))
  return win ?? window
}

/** 宿主窗口的 document；辅助窗口已关闭时回落到主文档 */
export function useHostDocument(): Document {
  const win = useHostWindow()
  return win.document
}

/**
 * 在「当前面板所在窗口」上注册 keydown。
 * 主窗口文档与辅助窗口文档是两棵独立的 DOM，全局快捷键必须分别注册。
 */
export function useHostKeydown(
  handler: (event: KeyboardEvent) => void,
  deps: React.DependencyList = [],
  enabled = true
): void {
  const doc = useHostDocument()
  useEffect(() => {
    if (!enabled) return
    const listener = (event: KeyboardEvent) => handler(event)
    doc.addEventListener('keydown', listener)
    return () => doc.removeEventListener('keydown', listener)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, enabled, ...deps])
}
