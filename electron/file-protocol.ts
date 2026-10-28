/**
 * `pw-file://` 只读文件协议。
 *
 * 图片 / 音视频 / PDF 与 HTML 预览需要浏览器直接读取文件，走 IPC 把二进制
 * 搬进渲染进程既慢又占内存。这里注册一个只读自定义协议：
 * - 只接受 GET / HEAD，写操作仍走 `fs:writeFile`；
 * - 路径必须落在受信任工作区或应用缓存目录内（realpath 规范化后判断）；
 * - 支持 Range 请求，视频拖动进度与 PDF 分页依赖它；
 * - 保留目录结构，HTML 里的相对路径资源可以被正常解析。
 */

import { protocol } from 'electron'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { Readable } from 'stream'
import { resolveAllowedFileTarget } from './workspace-trust.js'

export const FILE_SCHEME = 'pw-file'
const FILE_HOST = 'local'

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/opus',
  oga: 'audio/ogg',
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

export function mimeForPath(targetPath: string): string {
  const extension = path.extname(targetPath).slice(1).toLowerCase()
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

/**
 * 把 `pw-file://local/<路径>` 还原成绝对路径。
 * 逐段编码，任何包含分隔符、控制字符或 `..` 的段都直接拒绝，避免越权读取。
 */
export function decodeFilePath(rawUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== `${FILE_SCHEME}:`) return null
  if (parsed.hostname !== FILE_HOST) return null

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return null

  const decoded: string[] = []
  for (const segment of segments) {
    let value: string
    try {
      value = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (
      value.length === 0 ||
      value === '.' ||
      value === '..' ||
      value.includes('/') ||
      value.includes('\\') ||
      value.includes('\0')
    ) {
      return null
    }
    // Windows 盘符允许出现冒号，其余控制字符一律拒绝
    if (hasControlCharacter(value)) return null
    decoded.push(value)
  }

  const joined = decoded.join(path.sep)
  return path.isAbsolute(joined) ? joined : path.sep + joined
}

/** 逐码点检查 C0 控制字符：正则写法会触发 no-control-regex */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code > 0 && code < 0x20) return true
  }
  return false
}

export interface ByteRange {
  start: number
  end: number
}

/**
 * 解析 Range 头（只处理单段）。
 * 返回 null 表示按完整内容响应；返回 'invalid' 表示范围不可满足（416）。
 */
export function parseRangeHeader(value: string | null, size: number): ByteRange | null | 'invalid' {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null
  if (size <= 0) return 'invalid'

  if (!rawStart) {
    // 后缀范围：最后 N 个字节
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return 'invalid'
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  if (!Number.isFinite(end) || end < start) return 'invalid'
  return { start, end }
}

function baseHeaders(targetPath: string, size: number): Headers {
  const headers = new Headers({
    'Content-Type': mimeForPath(targetPath),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // iframe 使用不透明 origin（sandbox 不含 allow-same-origin），子资源需要 CORS
    'Access-Control-Allow-Origin': '*',
  })
  if (size >= 0) headers.set('Content-Length', String(size))
  return headers
}

/**
 * 生成协议响应。抽成独立函数便于单测（不依赖 Electron 运行时）。
 */
export async function serveFileRequest(
  rawUrl: string,
  method = 'GET',
  rangeHeader: string | null = null
): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const requested = decodeFilePath(rawUrl)
  if (!requested) return new Response('Bad Request', { status: 400 })

  const target = resolveAllowedFileTarget(requested)
  if (!target) return new Response('Forbidden', { status: 403 })

  let stats
  try {
    stats = await fsp.stat(target)
  } catch {
    return new Response('Not Found', { status: 404 })
  }
  if (!stats.isFile()) return new Response('Not Found', { status: 404 })

  const size = stats.size
  const range = parseRangeHeader(rangeHeader, size)
  if (range === 'invalid') {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` },
    })
  }

  if (method === 'HEAD') {
    const headers = baseHeaders(target, size)
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    return new Response(null, { status: range ? 206 : 200, headers })
  }

  const headers = baseHeaders(target, range ? range.end - range.start + 1 : size)
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)

  const stream = fs.createReadStream(target, range ? { start: range.start, end: range.end } : {})
  const body = Readable.toWeb(stream) as unknown as ReadableStream
  return new Response(body, { status: range ? 206 : 200, headers })
}

/** app ready 之后调用 */
export function registerFileProtocol(): void {
  protocol.handle(FILE_SCHEME, async (request) => {
    try {
      return await serveFileRequest(
        request.url,
        request.method,
        request.headers.get('range')
      )
    } catch (error) {
      console.error('[FileProtocol] Failed to serve:', request.url, error)
      return new Response('Internal Error', { status: 500 })
    }
  })
}
