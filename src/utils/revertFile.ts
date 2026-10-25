import { api } from '../api'
import { editorStoreFor } from '../store/editorStore'
import type { FileEdit } from '../types/electron'

export type RevertFailureReason = 'dirty' | 'read' | 'conflict' | 'write'

export type RevertResult =
  | { ok: true }
  | { ok: false; reason: RevertFailureReason; error?: string }

/**
 * 把文件恢复为 Agent 修改前的内容。
 * 编辑器里有未保存改动、或文件内容已被外部改动时拒绝覆盖。
 */
export async function revertFileEdit(
  target: FileEdit,
  workspacePath: string
): Promise<RevertResult> {
  const openFile = editorStoreFor(workspacePath)
    .getState()
    .openFiles.find((file) => file.path === target.path)
  if (openFile?.isDirty) {
    return { ok: false, reason: 'dirty' }
  }

  const current = await api.readFile(target.path)
  if (!current.success || typeof current.content !== 'string') {
    return { ok: false, reason: 'read', error: current.error }
  }
  if (current.content !== target.newContent) {
    return { ok: false, reason: 'conflict' }
  }

  const written = await api.writeFile(target.path, target.oldContent)
  if (!written.success) {
    return { ok: false, reason: 'write', error: written.error }
  }
  return { ok: true }
}
