/**
 * 文档读取统一错误：消息直接面向用户，`code` 供调用方分支。
 *
 * - `legacy`：旧版 OLE 二进制格式（.doc/.xls/.ppt），只能让用户另存为
 * - `unsupported`：认得出但不支持
 * - `corrupt`：容器损坏 / 加密 / 缺关键条目
 */
export type DocumentErrorCode = 'legacy' | 'unsupported' | 'corrupt'

export class DocumentError extends Error {
  readonly code: DocumentErrorCode

  constructor(message: string, code: DocumentErrorCode = 'unsupported') {
    super(message)
    this.name = 'DocumentError'
    this.code = code
  }
}
