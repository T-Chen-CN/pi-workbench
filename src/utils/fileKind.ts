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
  return 'text'
}

/** 默认视图：Markdown / HTML 直接可读，其余进源码 */
export function defaultViewFor(kind: FileKind): FileViewMode {
  return kind === 'markdown' || kind === 'html' ? 'reading' : 'source'
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
