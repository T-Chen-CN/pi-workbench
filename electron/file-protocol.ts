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

import {
  app,
  BrowserWindow,
  dialog,
  protocol,
  session,
  type WebContents,
} from 'electron'
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
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXTENSION, extension)
    ? MIME_BY_EXTENSION[extension]
    : 'application/octet-stream'
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

const APP_ORIGIN = 'pw-app://bundle'

function allowedCorsOrigin(originHeader: string | null): string | null {
  if (!originHeader || originHeader === 'null') return null
  if (originHeader === APP_ORIGIN) return APP_ORIGIN
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    try {
      const devOrigin = new URL(devServerUrl).origin
      if (originHeader === devOrigin) return devOrigin
    } catch {
      return null
    }
  }
  return null
}

const HTML_PREVIEW_CSP = [
  "default-src pw-file: http: https: ws: wss: data: blob:",
  "script-src pw-file: http: https: 'unsafe-inline'",
  "style-src pw-file: http: https: 'unsafe-inline'",
  "img-src pw-file: http: https: data: blob:",
  "media-src pw-file: http: https: data: blob:",
  "font-src pw-file: http: https: data:",
  "connect-src pw-file: http: https: ws: wss:",
  // 禁止在预览页里派生独立 Worker（否则脱离 WebFrameMain 归属，绕过按文件拦截）
  "worker-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors pw-app: http://localhost:5173 http://127.0.0.1:5173",
].join('; ')

const SVG_PREVIEW_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "frame-ancestors 'self'",
].join('; ')

function baseHeaders(targetPath: string, size: number, originHeader: string | null = null): Headers {
  const mime = mimeForPath(targetPath)
  const headers = new Headers({
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  // HTML 预览页强制结构性沙箱 CSP；SVG 独立文档禁止脚本与外链资源
  if (mime.startsWith('text/html')) {
    headers.set('Content-Security-Policy', HTML_PREVIEW_CSP)
  } else if (mime === 'image/svg+xml') {
    headers.set('Content-Security-Policy', SVG_PREVIEW_CSP)
  }
  // 只允许应用自身 origin 跨域读取（禁止 `*` 与不透明 `null` origin，防止沙箱 HTML 预览跨域窃取工作区文件）
  const corsOrigin = allowedCorsOrigin(originHeader)
  if (corsOrigin) {
    headers.set('Access-Control-Allow-Origin', corsOrigin)
    headers.set('Vary', 'Origin')
  }
  if (size >= 0) headers.set('Content-Length', String(size))
  return headers
}

/**
 * 生成协议响应。抽成独立函数便于单测（不依赖 Electron 运行时）。
 */
export async function serveFileRequest(
  rawUrl: string,
  method = 'GET',
  rangeHeader: string | null = null,
  originHeader: string | null = null
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
    const headers = baseHeaders(target, range ? range.end - range.start + 1 : size, originHeader)
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    return new Response(null, { status: range ? 206 : 200, headers })
  }

  const headers = baseHeaders(target, range ? range.end - range.start + 1 : size, originHeader)
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)

  const stream = fs.createReadStream(target, range ? { start: range.start, end: range.end } : {})
  const body = Readable.toWeb(stream) as unknown as ReadableStream
  return new Response(body, { status: range ? 206 : 200, headers })
}

export interface PreviewFrameLike {
  url?: string
  parent?: PreviewFrameLike | null
}

export interface PreviewNetworkRequest {
  url: string
  frame?: PreviewFrameLike | null
  initiatorOrigin?: string
  referrer?: string
  resourceType?: string
  webContents?: WebContents | unknown
}

export interface PreviewNetworkPromptPayload {
  filePath: string
  requestUrl: string
  targetHost: string
  webContents?: WebContents | unknown
}

export interface PreviewNetworkGuard {
  handleRequest: (
    details: PreviewNetworkRequest,
    callback: (response: { cancel?: boolean }) => void
  ) => void
  clearDecisions: () => void
}

const TRUSTED_DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173'])

function trustedDevOrigins(): Set<string> {
  if (app?.isPackaged) return new Set()
  const origins = new Set(TRUSTED_DEV_ORIGINS)
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    try {
      origins.add(new URL(devServerUrl).origin)
    } catch {
      // ignore malformed env
    }
  }
  return origins
}

function isTrustedAppInitiator(initiatorOrigin: string | undefined): boolean {
  if (!initiatorOrigin) return false
  if (initiatorOrigin === APP_ORIGIN) return true
  return trustedDevOrigins().has(initiatorOrigin)
}

function isTrustedDevMainFrameNavigation(details: PreviewNetworkRequest): boolean {
  if (app?.isPackaged) return false
  if (details.resourceType !== 'mainFrame' || details.initiatorOrigin) return false
  try {
    return trustedDevOrigins().has(new URL(details.url).origin)
  } catch {
    return false
  }
}

/** 沿 frame 祖先链追溯触发外网请求的本地预览文件路径；已销毁的 frame 访问可能抛错，必须兜底 */
export function resolvePreviewFilePath(
  details: Pick<PreviewNetworkRequest, 'frame' | 'referrer'>
): string | null {
  let cursor: PreviewFrameLike | null = details.frame ?? null
  for (let depth = 0; depth < 32 && cursor; depth += 1) {
    let frameUrl = ''
    try {
      frameUrl = typeof cursor.url === 'string' ? cursor.url : ''
    } catch {
      frameUrl = ''
    }
    if (frameUrl.startsWith(`${FILE_SCHEME}://`)) {
      return decodeFilePath(frameUrl)
    }
    try {
      cursor = cursor.parent ?? null
    } catch {
      cursor = null
    }
  }
  if (typeof details.referrer === 'string' && details.referrer.startsWith(`${FILE_SCHEME}://`)) {
    return decodeFilePath(details.referrer)
  }
  return null
}

function extractTargetHost(rawUrl: string): string {
  try {
    return (new URL(rawUrl).host || rawUrl).toLowerCase()
  } catch {
    return rawUrl.toLowerCase()
  }
}

function previewDecisionKey(filePath: string, targetHost: string): string {
  const fileKey = process.platform === 'win32' ? filePath.toLowerCase() : filePath
  return `${fileKey}\0${targetHost.toLowerCase()}`
}

/**
 * 本地 HTML 预览的外网按需审批守卫（白名单反转 + 按文件与目标主机双重隔离）：
 * - 仅自动放行来自应用自身 origin（`pw-app://bundle` 或非打包态 Vite dev origin）的请求；
 * - `pw-file://` 预览页默认离线，按 `(filePath, targetHost)` 独立弹窗确认，允许某域名不会放开任意第三方主机；
 * - 同一 `(filePath, targetHost)` 并发请求共享待决 Promise 避免弹窗风暴；
 * - 无法归属已知预览文件且非受信任应用 origin（含 `pw-file://local`、不透明 `"null"`、未知来源）一律 fail-closed 拦截。
 */
export function createPreviewNetworkGuard(options: {
  prompt: (payload: PreviewNetworkPromptPayload) => Promise<boolean>
}): PreviewNetworkGuard {
  const decisions = new Map<string, 'allow' | 'deny'>()
  const inFlight = new Map<string, Promise<boolean>>()

  const handleRequest: PreviewNetworkGuard['handleRequest'] = (details, callback) => {
    const filePath = resolvePreviewFilePath(details)
    if (!filePath) {
      if (
        isTrustedAppInitiator(details.initiatorOrigin) ||
        isTrustedDevMainFrameNavigation(details)
      ) {
        callback({})
        return
      }
      callback({ cancel: true })
      return
    }

    const targetHost = extractTargetHost(details.url)
    const key = previewDecisionKey(filePath, targetHost)
    const decided = decisions.get(key)
    if (decided === 'allow') {
      callback({ cancel: false })
      return
    }
    if (decided === 'deny') {
      callback({ cancel: true })
      return
    }

    let pending = inFlight.get(key)
    if (!pending) {
      pending = Promise.resolve()
        .then(() =>
          options.prompt({
            filePath,
            requestUrl: details.url,
            targetHost,
            webContents: details.webContents,
          })
        )
        .then((allowed) => Boolean(allowed))
        .catch(() => false)
        .then((allowed) => {
          decisions.set(key, allowed ? 'allow' : 'deny')
          inFlight.delete(key)
          return allowed
        })
      inFlight.set(key, pending)
    }

    void pending.then((allowed) => callback({ cancel: !allowed }))
  }

  return {
    handleRequest,
    clearDecisions: () => {
      decisions.clear()
      inFlight.clear()
    },
  }
}

export interface RegisterFileProtocolOptions {
  getLanguage?: () => string | undefined
}

async function promptPreviewNetworkAccess(
  payload: PreviewNetworkPromptPayload,
  getLanguage?: () => string | undefined
): Promise<boolean> {
  if (typeof dialog?.showMessageBox !== 'function') return false
  const lang = getLanguage?.()
  const zh =
    lang === 'zh'
      ? true
      : lang === 'en'
        ? false
        : (app?.getLocale?.().toLowerCase().startsWith('zh') ?? true)
  const fileName = path.basename(payload.filePath)
  const displayUrl =
    payload.requestUrl.length > 180
      ? `${payload.requestUrl.slice(0, 177)}...`
      : payload.requestUrl
  const owner =
    payload.webContents && typeof BrowserWindow?.fromWebContents === 'function'
      ? BrowserWindow.fromWebContents(payload.webContents as WebContents) ?? undefined
      : undefined
  const boxOptions: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: zh ? ['拒绝（保持离线）', '允许访问外网'] : ['Block (stay offline)', 'Allow network access'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: zh ? '允许 HTML 预览访问外部网络？' : 'Allow HTML preview to access the network?',
    message: zh
      ? `「${fileName}」正在请求访问外部网络（${payload.targetHost}）`
      : `"${fileName}" is requesting access to an external address (${payload.targetHost})`,
    detail: zh
      ? `文件：${payload.filePath}\n目标：${displayUrl}\n\n本地 HTML 预览默认保持离线。仅在你信任此 HTML 文件时选择允许；本次选择在应用重启前仅对该文件访问 ${payload.targetHost} 生效。`
      : `File: ${payload.filePath}\nTarget: ${displayUrl}\n\nLocal HTML previews stay offline by default. Allow only if you trust this HTML file; this decision applies to ${payload.targetHost} for this file until the app restarts.`,
  }
  const result = owner
    ? await dialog.showMessageBox(owner, boxOptions)
    : await dialog.showMessageBox(boxOptions)
  return result.response === 1
}

/** app ready 之后调用 */
export function registerFileProtocol(options: RegisterFileProtocolOptions = {}): void {
  protocol.handle(FILE_SCHEME, async (request) => {
    try {
      return await serveFileRequest(
        request.url,
        request.method,
        request.headers.get('range'),
        request.headers.get('origin')
      )
    } catch (error) {
      console.error('[FileProtocol] Failed to serve:', request.url, error)
      return new Response('Internal Error', { status: 500 })
    }
  })

  if (session?.defaultSession?.webRequest?.onBeforeRequest) {
    const guard = createPreviewNetworkGuard({
      prompt: (payload) => promptPreviewNetworkAccess(payload, options.getLanguage),
    })
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (details, callback) => guard.handleRequest(details, callback)
    )
  }
}
