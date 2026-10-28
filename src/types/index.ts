import type { FileKind, FileViewMode } from '../utils/fileKind'

// File and workspace types
export interface OpenFile {
  path: string
  name: string
  /** 决定用哪种视图渲染：源码 / Markdown 阅读 / HTML 预览 / 媒体 */
  kind: FileKind
  /** 当前视图：Markdown 与 HTML 可在阅读视图与源码视图之间切换 */
  view: FileViewMode
  /** 文本类文件的内容；媒体类为空字符串（由 `pw-file://` 直接渲染） */
  content: string
  isDirty: boolean
  isSaving: boolean
  /** 媒体文件外部变更计数，用于刷新预览地址 */
  version: number
}

/** 打开文件时的入参：kind / view / version 可省略，由 store 补齐默认值 */
export type OpenFileInput = Omit<OpenFile, 'kind' | 'view' | 'version'> &
  Partial<Pick<OpenFile, 'kind' | 'view' | 'version'>>

// Editor state
export interface EditorState {
  currentFile: OpenFile | null
  openFiles: OpenFile[]
  unsavedChanges: Set<string>
}
