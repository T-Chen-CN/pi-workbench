import React, { createContext, useContext } from 'react'

/**
 * 宿主文档上下文（零桌面 store 依赖）。
 *
 * - 桌面端拆窗面板由 `src/panelHost/HostContext.tsx` 的 `HostProvider` 同步注入当前窗口的 `document`；
 * - 云端 Web 与独立测试无需挂载 Provider，自动回落到全局 `document`。
 */
const HostDocumentContext = createContext<Document | null>(null)

export interface HostDocumentProviderProps {
  value: Document | null
  children: React.ReactNode
}

export const HostDocumentProvider: React.FC<HostDocumentProviderProps> = ({ value, children }) => (
  <HostDocumentContext.Provider value={value}>{children}</HostDocumentContext.Provider>
)

export function useHostDocument(): Document {
  const hostDocument = useContext(HostDocumentContext)
  if (hostDocument) return hostDocument
  if (typeof document !== 'undefined') return document
  throw new Error('Document is unavailable in this environment')
}
