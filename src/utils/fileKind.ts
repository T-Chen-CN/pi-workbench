/**
 * 文件类型判定与预览地址。
 *
 * 编辑器按类型分发视图：Markdown / HTML 默认进入阅读视图，图片与音视频走
 * `pw-file://` 只读协议直接交给浏览器渲染，其余文件仍用 Monaco。
 * 这里只做纯函数判定，不依赖 Electron，方便单测。
 */

export type FileKind =
  | 'text'
  | 'markdown'
  | 'html'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'word'
  | 'sheet'
  | 'slide'
  | 'epub'
  | 'office-legacy'
  | 'binary'

/** 阅读视图（渲染结果）与源码视图（Monaco） */
export type FileViewMode = 'reading' | 'source'

/** 自定义只读协议：主进程 `electron/file-protocol.ts` 注册 */
export const FILE_PROTOCOL = 'pw-file'
const FILE_PROTOCOL_HOST = 'local'

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd'])
const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml'])
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
  'svg',
])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'ogg', 'm4v', 'mov'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'opus', 'oga'])
const PDF_EXTENSIONS = new Set(['pdf'])
/** Word 家族：docx / docm / dotx / dotm / odt / ott */
const WORD_EXTENSIONS = new Set(['docx', 'docm', 'dotx', 'dotm', 'odt', 'ott'])
/** 表格家族：xlsx / xlsm / xltx / xltm / ods / ots */
const SHEET_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xltx', 'xltm', 'ods', 'ots'])
/** 演示文稿家族：pptx / pptm / potx / potm / ppsx / ppsm / odp / otp */
const SLIDE_EXTENSIONS = new Set([
  'pptx',
  'pptm',
  'potx',
  'potm',
  'ppsx',
  'ppsm',
  'odp',
  'otp',
])
const EPUB_EXTENSIONS = new Set(['epub'])
/**
 * 旧二进制 Office 格式（OLE 容器）：读不了，只能提示用户另存为，
 * 所以单独一个类型，直接给出带「另存为」指路的卡片。
 */
const LEGACY_OFFICE_EXTENSIONS = new Set([
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

function extensionOf(targetPath: string): string {
  const name = targetPath.replace(/\\/g, '/').split('/').pop() ?? targetPath
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** 仅按扩展名判定；未知扩展名与无扩展名一律先当作文本，交给读取层探测 */
export function detectFileKind(targetPath: string): FileKind {
  const extension = extensionOf(targetPath)
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (HTML_EXTENSIONS.has(extension)) return 'html'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (PDF_EXTENSIONS.has(extension)) return 'pdf'
  if (WORD_EXTENSIONS.has(extension)) return 'word'
  if (SHEET_EXTENSIONS.has(extension)) return 'sheet'
  if (SLIDE_EXTENSIONS.has(extension)) return 'slide'
  if (EPUB_EXTENSIONS.has(extension)) return 'epub'
  if (LEGACY_OFFICE_EXTENSIONS.has(extension)) return 'office-legacy'
  return 'text'
}

/** 默认视图：Markdown / HTML / 文档类直接可读（文档类只有预览，没有源码），其余进源码 */
export function defaultViewFor(kind: FileKind): FileViewMode {
  return kind === 'markdown' || kind === 'html' || isOfficeDocumentKind(kind) ? 'reading' : 'source'
}

/** 是否有独立的阅读视图（只有 Markdown / HTML 渲染成排版结果） */
export function hasReadingView(kind: FileKind): boolean {
  return kind === 'markdown' || kind === 'html'
}

/** 能否显示源码视图（图片/音视频/PDF/二进制没有） */
export function supportsSourceView(kind: FileKind): boolean {
  return kind === 'text' || kind === 'markdown' || kind === 'html'
}

/** 由 `pw-file://` 协议直接渲染的类型，不读入文本 */
export function isStreamedKind(kind: FileKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf'
}

/** 需要主进程解析成结构化预览的文档类型（PDF 走 `pw-file://` + pdf.js，不在此列） */
export function isOfficeDocumentKind(kind: FileKind): boolean {
  return (
    kind === 'word' ||
    kind === 'sheet' ||
    kind === 'slide' ||
    kind === 'epub' ||
    kind === 'office-legacy'
  )
}

/** 是否允许编辑（媒体与未知二进制只读） */
export function isEditableKind(kind: FileKind): boolean {
  return kind === 'text' || kind === 'markdown' || kind === 'html'
}

/**
 * 生成 `pw-file://` 地址。保留目录结构（逐段编码），让 HTML 里的相对路径
 * 能被浏览器正常解析；`version` 用于外部文件变更后强制重新取图。
 */
export function filePreviewUrl(targetPath: string, version = 0): string {
  const normalized = targetPath.replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const pathname = encoded.startsWith('/') ? encoded : `/${encoded}`
  const query = version > 0 ? `?v=${version}` : ''
  return `${FILE_PROTOCOL}://${FILE_PROTOCOL_HOST}${pathname}${query}`
}
