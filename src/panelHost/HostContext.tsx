/**
 * 面板宿主上下文。
 *
 * docked 面板拿到 `main`，拆到独立原生 BrowserWindow 的面板拿到 `aux:<n>`。
 * 每个原生窗口拥有自己独立的 `window` 与 `document`，不再存在跨文档 Portal 代理，
 * 保留统一 Hook 签名以便业务组件、弹窗与快捷键保持零差异复用。
 */

import React, { createContext, useContext, useEffect } from 'react'
import { HostDocumentProvider } from '@pi-workbench/ui'
import { MAIN_HOST, type HostId } from './types'

const HostContext = createContext<HostId>(MAIN_HOST)

export const HostProvider: React.FC<{ host: HostId; children: React.ReactNode }> = ({
  host,
  children,
}) => (
  <HostContext.Provider value={host}>
    <HostDocumentProvider value={document}>{children}</HostDocumentProvider>
  </HostContext.Provider>
)

export function useHostId(): HostId {
  return useContext(HostContext)
}

/** 宿主窗口的原生 window */
export function useHostWindow(): Window {
  return window
}

/** 宿主窗口的原生 document */
export function useHostDocument(): Document {
  return document
}

/** 在当前窗口 document 上注册 keydown */
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
