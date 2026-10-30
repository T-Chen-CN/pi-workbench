/**
 * 统一的「在编辑器里打开文件」入口。
 *
 * 文件树、聊天里的路径引用、会话恢复与草稿恢复都走这里，保证：
 * - 媒体文件不读文本（交给 pw-file:// 协议）；
 * - 二进制文件不会被当成乱码文本打开；
 * - 大文件确认只对文本类生效（几百 MB 的视频是正常的）。
 */

import { api } from '../api'
import { editorStoreFor } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { basename } from '../utils/filePath'
import {
  defaultViewFor,
  detectFileKind,
  isEditableKind,
  isOfficeDocumentKind,
  isStreamedKind,
  type FileKind,
} from '../utils/fileKind'

/** 文本类文件打开前的确认阈值（与文件树的提示保持一致） */
const LARGE_OPEN_BYTES = 5 * 1024 * 1024

export type OpenFileOutcome =
  | { status: 'opened'; kind: FileKind }
  | { status: 'skipped'; reason: 'missing' | 'directory' | 'too-large' | 'declined' | 'error'; error?: string }

export interface OpenFileOptions {
  /** 打开后滚动到该行（仅文本类） */
  revealLine?: number
  /** 恢复标签时已确认过，不再弹大文件确认 */
  skipLargeConfirm?: boolean
  /** 大文件确认的交互入口，默认使用应用内确认框 */
  confirmLargeFile?: (info: { name: string; size: number }) => Promise<boolean>
}

/** 读取文本类文件；二进制返回 binary 结果，调用方据此降级为「不支持预览」 */
async function readTextFile(
  targetPath: string
): Promise<{ status: 'text'; content: string } | { status: 'binary' } | { status: 'error'; error: string }> {
  const result = await api.readFile(targetPath)
  if (!result.success) {
    return { status: 'error', error: result.error || 'Failed to read file' }
  }
  if (result.binary) return { status: 'binary' }
  if (typeof result.content !== 'string') {
    return { status: 'error', error: 'Failed to read file' }
  }
  return { status: 'text', content: result.content }
}

export async function openFileInEditor(
  root: string,
  targetPath: string,
  options: OpenFileOptions = {}
): Promise<OpenFileOutcome> {
  const store = editorStoreFor(root)
  const name = basename(targetPath) || targetPath
  const existing = store.getState().openFiles.find((file) => file.path === targetPath)
  if (existing) {
    store.getState().setCurrentFile(existing)
    if (options.revealLine) store.getState().revealLine(targetPath, options.revealLine)
    return { status: 'opened', kind: existing.kind }
  }

  let size = 0
  try {
    const info = await api.stat(targetPath)
    if (!info.success) {
      return { status: 'skipped', reason: 'missing', error: info.error }
    }
    if (info.isDirectory) return { status: 'skipped', reason: 'directory' }
    size = typeof info.size === 'number' ? info.size : 0
  } catch (error) {
    return {
      status: 'skipped',
      reason: 'error',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  let kind = detectFileKind(targetPath)

  // 媒体与 PDF：只登记标签，内容由协议流式读取
  if (isStreamedKind(kind)) {
    store.getState().addOpenFile({
      path: targetPath,
      name,
      kind,
      content: '',
      isDirty: false,
      isSaving: false,
    })
    return { status: 'opened', kind }
  }

  // Office / EPUB：内容由主进程解析成预览模型，渲染层不读字节、也不确认大小
  if (isOfficeDocumentKind(kind)) {
    store.getState().addOpenFile({
      path: targetPath,
      name,
      kind,
      content: '',
      isDirty: false,
      isSaving: false,
      view: 'reading',
    })
    return { status: 'opened', kind }
  }

  // 文本类（含 Markdown / HTML）：先确认大小，再读取并探测二进制
  if (isEditableKind(kind) && size > LARGE_OPEN_BYTES && !options.skipLargeConfirm) {
    const confirm =
      options.confirmLargeFile ??
      (async (info: { name: string; size: number }) => {
        const { confirmDialog } = await import('../store/dialogStore')
        const t = useI18nStore.getState().t
        return confirmDialog({
          message: t('openLargeFileConfirm', {
            name: info.name,
            size: `${(info.size / 1024 / 1024).toFixed(1)} MB`,
          }),
        })
      })
    if (!(await confirm({ name, size }))) {
      return { status: 'skipped', reason: 'declined' }
    }
  }

  const read = await readTextFile(targetPath)
  if (read.status === 'error') {
    return { status: 'skipped', reason: 'error', error: read.error }
  }
  if (read.status === 'binary') {
    kind = 'binary'
    store.getState().addOpenFile({
      path: targetPath,
      name,
      kind,
      content: '',
      isDirty: false,
      isSaving: false,
      view: 'source',
    })
    return { status: 'opened', kind }
  }

  // 文本类：按扩展名决定阅读视图还是源码视图
  store.getState().addOpenFile({
    path: targetPath,
    name,
    kind,
    content: read.content,
    isDirty: false,
    isSaving: false,
    view: defaultViewFor(kind),
  })
  if (options.revealLine) store.getState().revealLine(targetPath, options.revealLine)
  return { status: 'opened', kind }
}
