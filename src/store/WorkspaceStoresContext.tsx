/**
 * 工作区级 Store 生命周期宿主：把 `editorStore` 与 `diffStore` 的存活期绑定到
 * `<WorkspaceView>` 挂载周期，挂载时保留引用计数，卸载时同步释放，避免 `setTimeout(0)` 竞态
 * 以及只读访问为已关闭工作区分配僵尸 store。
 */

import React, { createContext, useContext, useEffect, useMemo } from 'react'
import type { StoreApi } from 'zustand/vanilla'
import {
  attachEditorStore,
  disposeEditorStore,
  editorStoreFor,
  peekEditorStore,
  type EditorStore,
} from './editorStore'
import {
  attachDiffStore,
  disposeDiffStore,
  diffStoreFor,
  peekDiffStore,
  type DiffState,
} from './diffStore'

export interface WorkspaceStores {
  workspacePath: string
  editorStore: StoreApi<EditorStore>
  diffStore: StoreApi<DiffState>
}

const WorkspaceStoresContext = createContext<WorkspaceStores | null>(null)

/** 按 store 实例追踪活跃挂载计数，reset 后旧实例随 GC 自动释放，避免测试间残留计数 */
const editorRefCounts = new WeakMap<StoreApi<EditorStore>, number>()
const diffRefCounts = new WeakMap<StoreApi<DiffState>, number>()

function retainWorkspaceStores(stores: WorkspaceStores): void {
  const { workspacePath, editorStore, diffStore } = stores
  attachEditorStore(workspacePath, editorStore)
  attachDiffStore(workspacePath, diffStore)
  editorRefCounts.set(editorStore, (editorRefCounts.get(editorStore) ?? 0) + 1)
  diffRefCounts.set(diffStore, (diffRefCounts.get(diffStore) ?? 0) + 1)
}

function releaseWorkspaceStores(stores: WorkspaceStores): void {
  const { workspacePath, editorStore, diffStore } = stores
  const nextEditorCount = Math.max(0, (editorRefCounts.get(editorStore) ?? 1) - 1)
  editorRefCounts.set(editorStore, nextEditorCount)
  if (nextEditorCount === 0) {
    disposeEditorStore(workspacePath, editorStore)
  }

  const nextDiffCount = Math.max(0, (diffRefCounts.get(diffStore) ?? 1) - 1)
  diffRefCounts.set(diffStore, nextDiffCount)
  if (nextDiffCount === 0) {
    disposeDiffStore(workspacePath, diffStore)
  }
}

export interface WorkspaceStoresProviderProps {
  workspacePath: string
  children: React.ReactNode
}

export const WorkspaceStoresProvider: React.FC<WorkspaceStoresProviderProps> = ({
  workspacePath,
  children,
}) => {
  const stores = useMemo<WorkspaceStores>(
    () => ({
      workspacePath,
      editorStore: editorStoreFor(workspacePath),
      diffStore: diffStoreFor(workspacePath),
    }),
    [workspacePath]
  )

  useEffect(() => {
    retainWorkspaceStores(stores)
    return () => {
      releaseWorkspaceStores(stores)
    }
  }, [stores])

  return (
    <WorkspaceStoresContext.Provider value={stores}>{children}</WorkspaceStoresContext.Provider>
  )
}

export function useWorkspaceStores(): WorkspaceStores | null {
  return useContext(WorkspaceStoresContext)
}

export { peekEditorStore, peekDiffStore }
