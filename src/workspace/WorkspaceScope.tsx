import React, { createContext, useContext } from 'react'

const WorkspaceScopeContext = createContext<string | null>(null)

/** 让工作区内部的深层组件知道自己属于哪个工作区 */
export const WorkspaceScopeProvider: React.FC<{
  value: string
  children: React.ReactNode
}> = ({ value, children }) => (
  <WorkspaceScopeContext.Provider value={value}>{children}</WorkspaceScopeContext.Provider>
)

export function useWorkspaceScope(): string | null {
  return useContext(WorkspaceScopeContext)
}
