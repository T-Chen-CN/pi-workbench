/**
 * 图片旁路客户端（主进程）：上传与按路径读回。
 *
 * 单入口之后它也走网关（`hub.`）+ 设备 token；插件把
 * `POST /api/chat/image-upload` / `GET /api/fs/read-data-url` 转发给控制台。
 * 这里**不**承担会话读写：会话一律走网关的 `/v1/*`。
 */

import { net } from 'electron'
import { CloudApiError } from './client.js'

/** 服务端与浏览器一致的图片类型白名单 */
export const ALLOWED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
])

/** 服务端 `CHAT_IMAGE_MAX_BYTES` 是 25MB，本地先拦一道，省一次失败往返 */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024

export interface DashImageUpload {
  path: string
  name: string
  bytes: number
  mimeType: string
}

export interface MediaClient {
  uploadImage: (input: { dataUrl: string; filename?: string }) => Promise<DashImageUpload>
  readImageDataUrl: (path: string) => Promise<string>
}

function wrap(error: unknown): CloudApiError {
  if (error instanceof CloudApiError) return error
  const name = (error as { name?: string })?.name
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new CloudApiError('timeout', '图片请求超时')
  }
  return new CloudApiError(
    'network',
    `无法连接云端网关（检查网络 / 代理 / 网关是否在跑）：${error instanceof Error ? error.message : String(error)}`
  )
}

async function failure(response: Response, what: string): Promise<CloudApiError> {
  const status = response.status
  let detail = ''
  try {
    const text = await response.text()
    detail = text.slice(0, 300)
  } catch {
    // 读不出来就只报状态码
  }
  if (status === 401 || status === 403) {
    return new CloudApiError('unauthorized', `云端网关拒绝了${what}请求（${status}）：设备凭据无效或未登记`, {
      status,
    })
  }
  return new CloudApiError(
    status >= 500 ? 'server' : 'bad_request',
    `云端网关${what}失败（${status}）${detail ? `：${detail}` : ''}`,
    { status }
  )
}

export function createMediaClient(input: {
  baseUrl: string
  credential: string
}): MediaClient {
  const base = String(input.baseUrl ?? '').replace(/\/+$/, '')
  if (!base) throw new CloudApiError('bad_request', '网关地址为空')
  if (!input.credential) {
    throw new CloudApiError('unauthorized', '这台设备还没有登记，先在「连接」页登记')
  }
  const headers = { Authorization: `Bearer ${input.credential}` }

  return {
    async uploadImage({ dataUrl, filename }) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60_000)
      try {
        const response = await net.fetch(`${base}/api/chat/image-upload`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ data_url: dataUrl, filename }),
          signal: controller.signal,
        })
        if (!response.ok) throw await failure(response, '图片上传')
        const raw = (await response.json()) as Record<string, unknown>
        if (raw?.ok !== true || typeof raw.path !== 'string' || !raw.path) {
          throw new CloudApiError('server', '云端网关没有返回图片路径')
        }
        return {
          path: String(raw.path),
          name: String(raw.name ?? ''),
          bytes: Number(raw.bytes ?? 0),
          mimeType: String(raw.mime_type ?? ''),
        }
      } catch (error) {
        throw wrap(error)
      } finally {
        clearTimeout(timer)
      }
    },

    async readImageDataUrl(path) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      try {
        const response = await net.fetch(
          `${base}/api/fs/read-data-url?path=${encodeURIComponent(path)}`,
          { headers: { ...headers, Accept: 'application/json' }, signal: controller.signal }
        )
        if (!response.ok) throw await failure(response, '图片读取')
        const raw = (await response.json()) as Record<string, unknown>
        const dataUrl = String(raw?.dataUrl ?? raw?.data_url ?? '')
        if (!dataUrl.startsWith('data:image/')) {
          throw new CloudApiError('server', '云端网关返回的不是图片数据')
        }
        return dataUrl
      } catch (error) {
        throw wrap(error)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** 拆 `data:image/png;base64,AAAA` → 类型 + base64 体；顺便做大小与类型校验 */
export function parseImageDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(dataUrl ?? ''))
  if (!match) throw new CloudApiError('bad_request', '图片数据格式不正确')
  const mimeType = match[1].toLowerCase()
  if (!ALLOWED_IMAGE_MIME.has(mimeType)) {
    throw new CloudApiError('bad_request', `不支持的图片类型：${mimeType}`)
  }
  if (!match[2]) throw new CloudApiError('bad_request', '图片数据必须是 base64 编码')
  const base64 = match[3].replace(/\s+/g, '')
  // base64 长度 ≈ 字节数 * 4/3
  if ((base64.length * 3) / 4 > MAX_IMAGE_BYTES) {
    throw new CloudApiError('bad_request', '图片超过 25MB 上限')
  }
  return { mimeType, base64 }
}

/** `/image /path/a.png` → 提取路径（其余文本原样返回） */
export function extractImagePaths(text: string): string[] {
  const paths: string[] = []
  const pattern = /(^|\n)[ \t]*\/image[ \t]+(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(String(text ?? ''))) !== null) {
    paths.push(match[2])
  }
  return paths
}
