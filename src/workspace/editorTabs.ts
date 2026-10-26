import { api } from '../api'
import { editorStoreFor } from '../store/editorStore'
import { basename } from '../utils/filePath'

/** 恢复时允许自动打开的最大文件，超过则跳过（Monaco 大文件模式仍会生效） */
const MAX_RESTORE_BYTES = 10 * 1024 * 1024

function tabsSignature(openFiles: { path: string }[], activePath: string | null): string {
  return `${openFiles.map((file) => file.path).join('\u0000')}|${activePath ?? ''}`
}

export function readEditorTabs(
  workspacePath: string,
  root?: string
): {
  open: string[]
  active: string | null
  root?: string
} {
  const storeRoot = root ?? workspacePath
  const state = editorStoreFor(storeRoot).getState()
  return {
    open: state.openFiles.map((file) => file.path),
    active: state.currentFile?.path ?? null,
    ...(storeRoot !== workspacePath ? { root: storeRoot } : {}),
  }
}

export async function saveEditorTabs(workspacePath: string, root?: string): Promise<void> {
  const tabs = readEditorTabs(workspacePath, root)
  await api.editorTabsSet(workspacePath, tabs).catch(() => undefined)
}

/** 订阅一个工作区/工作树的标签变化并防抖落盘（内容编辑不会触发写入） */
export function subscribeEditorTabs(workspacePath: string, root?: string): () => void {
  const store = editorStoreFor(root ?? workspacePath)
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void saveEditorTabs(workspacePath, root)
    }, 250)
  }
  const unsubscribe = store.subscribe((state, previous) => {
    if (
      tabsSignature(state.openFiles, state.currentFile?.path ?? null) !==
      tabsSignature(previous.openFiles, previous.currentFile?.path ?? null)
    ) {
      schedule()
    }
  })
  return () => {
    if (timer) {
      clearTimeout(timer)
      // 切换会话/工作树时把尚未落盘的标签立即保存
      void saveEditorTabs(workspacePath, root)
    }
    unsubscribe()
  }
}

/**
 * 重新打开工作区时恢复固定状态中的编辑器标签。
 * 缺失、目录或超过 10MB 的文件跳过，返回值用于汇总提示。
 */
export async function restoreEditorTabs(
  workspacePath: string
): Promise<{ restored: number; skipped: number }> {
  let result
  try {
    result = await api.editorTabsGet(workspacePath)
  } catch {
    // 旧 preload / Web 模式没有该接口时静默跳过
    return { restored: 0, skipped: 0 }
  }
  if (!result.success || !result.tabs) return { restored: 0, skipped: 0 }

  const storeRoot = result.tabs.root ?? workspacePath
  const store = editorStoreFor(storeRoot)
  let restored = 0
  let skipped = 0

  for (const filePath of result.tabs.open) {
    if (store.getState().openFiles.some((file) => file.path === filePath)) {
      continue
    }
    try {
      const info = await api.stat(filePath)
      if (!info.success || info.isDirectory) {
        skipped++
        continue
      }
      if (typeof info.size === 'number' && info.size > MAX_RESTORE_BYTES) {
        skipped++
        continue
      }
      const read = await api.readFile(filePath)
      if (!read.success || typeof read.content !== 'string') {
        skipped++
        continue
      }
      store.getState().addOpenFile({
        path: filePath,
        name: basename(filePath) || filePath,
        content: read.content,
        isDirty: false,
        isSaving: false,
      })
      restored++
    } catch {
      skipped++
    }
  }

  if (result.tabs.active) {
    const activeFile = store
      .getState()
      .openFiles.find((file) => file.path === result.tabs?.active)
    if (activeFile) store.getState().setCurrentFile(activeFile)
  }

  return { restored, skipped }
}
