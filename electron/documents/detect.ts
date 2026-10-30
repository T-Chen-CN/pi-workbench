/**
 * 文档格式判定：魔数优先、扩展名兜底。
 *
 * 只看前 4KB，不读整文件。判定结果决定后续走哪条管线：
 * - `pdf` → pdf.js 抽文本 / 扫描判定
 * - `zip` 容器（docx/xlsx/pptx/odt/ods/odp/epub）→ ZIP + XML 抽取
 * - `legacy`（OLE：.doc/.xls/.ppt）→ 直接拒绝并提示另存
 */

import * as fs from 'fs/promises'
import * as path from 'path'

export type DocumentFormat =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'odt'
  | 'ods'
  | 'odp'
  | 'epub'
  | 'legacy-office'
  | 'unknown'

export interface DocumentSniffResult {
  format: DocumentFormat
  /** 是否需要交给文档管线处理 */
  isDocument: boolean
  /** 旧版 OLE 二进制（需要用户另存为新格式） */
  legacy: boolean
  /** 实际扩展名（小写，不含点） */
  extension: string
}

/** 需要文档管线的扩展名 → 期望格式 */
const ZIP_FORMAT_BY_EXTENSION: Record<string, DocumentFormat> = {
  docx: 'docx',
  docm: 'docx',
  dotx: 'docx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xltx: 'xlsx',
  pptx: 'pptx',
  pptm: 'pptx',
  potx: 'pptx',
  odt: 'odt',
  ott: 'odt',
  ods: 'ods',
  ots: 'ods',
  odp: 'odp',
  otp: 'odp',
  epub: 'epub',
}

/** 旧版二进制：OLE 容器，本轮不支持，提示另存 */
const LEGACY_EXTENSIONS = new Set([
  'doc',
  'dot',
  'xls',
  'xlt',
  'xla',
  'ppt',
  'pot',
  'pps',
  'wps',
  'et',
  'dps',
])

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ZIP_SIGNATURES = [0x04034b50, 0x06054b50, 0x08074b50]

/** 管线要读的头部长度：PDF 头可能被少量垃圾字节推后，留足余量 */
const HEAD_BYTES = 4096

export function extensionOfPath(targetPath: string): string {
  const name = path.basename(targetPath).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1)
}

/** 扩展名是否属于「可能含文档的容器」——供工具侧快速分流 */
export function isDocumentExtension(extension: string): boolean {
  return extension === 'pdf' || extension in ZIP_FORMAT_BY_EXTENSION || LEGACY_EXTENSIONS.has(extension)
}

function isPdf(head: Buffer): boolean {
  return head.subarray(0, HEAD_BYTES).includes('%PDF-')
}

function isZip(head: Buffer): boolean {
  if (head.length < 4) return false
  return ZIP_SIGNATURES.includes(head.readUInt32LE(0))
}

function isOle(head: Buffer): boolean {
  return head.length >= 8 && head.subarray(0, 8).equals(OLE_SIGNATURE)
}

/** 读文件头；文件不存在或读不了时返回空 Buffer，交给上层给出可读错误 */
export async function readHead(targetPath: string): Promise<Buffer> {
  const handle = await fs.open(targetPath, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** 纯函数版本，便于单测 */
export function sniffDocument(targetPath: string, head: Buffer): DocumentSniffResult {
  const extension = extensionOfPath(targetPath)
  const zipFormat = ZIP_FORMAT_BY_EXTENSION[extension]

  if (isOle(head)) {
    // 扩展名写 .docx 但内容是 OLE 的情况（改后缀）：同样按旧格式拒绝
    return { format: 'legacy-office', isDocument: true, legacy: true, extension }
  }
  if (isPdf(head)) {
    return { format: 'pdf', isDocument: true, legacy: false, extension }
  }
  if (isZip(head)) {
    if (zipFormat) return { format: zipFormat, isDocument: true, legacy: false, extension }
    // 后缀不认识但确实是 ZIP：由 extract 打开容器后按内部条目再判一次
    return { format: 'unknown', isDocument: true, legacy: false, extension }
  }
  if (zipFormat || LEGACY_EXTENSIONS.has(extension)) {
    // 后缀像文档但魔数不符：容器损坏或根本不是文档，仍然交给文档管线给明确错误
    return {
      format: LEGACY_EXTENSIONS.has(extension) ? 'legacy-office' : zipFormat,
      isDocument: true,
      legacy: LEGACY_EXTENSIONS.has(extension),
      extension,
    }
  }
  return { format: 'unknown', isDocument: false, legacy: false, extension }
}

export async function detectDocument(targetPath: string): Promise<DocumentSniffResult> {
  return sniffDocument(targetPath, await readHead(targetPath))
}
