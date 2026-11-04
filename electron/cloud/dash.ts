/**
 * 控制台旁路客户端（主进程）：只用它做网关不做的事 —— 图片上传与图片字节读回。
 *
 * 为什么要单独一个客户端：
 * - 网关（`:8642`）只认 `API_SERVER_KEY`，没有上传接口；
 * - 控制台（`:9119`）认 `HERMES_DASHBOARD_SESSION_TOKEN`（Bearer），有
 *   `POST /api/chat/image-upload` 和 `GET /api/fs/read-data-url`；
 * - 两套凭据、两套错误语义，混在一个客户端里会互相污染。
 *
 * 这里**不**承担会话读写：PATCH/DELETE 在控制台会被版本守卫拦成 409
 * （`client_upgrade_required`），会话一律走网关。
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

export interface DashboardClient {
  uploadImage: (input: { dataUrl: string; filename?: string }) => Promise<DashImageUpload>
  readImageDataUrl: (path: string) => Promise<string>
}

function wrap(error: unknown): CloudApiError {
  if (error instanceof CloudApiError) return error
  const name = (error as { name?: string })?.name
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new CloudApiError('timeout', '控制台请求超时')
  }
  return new CloudApiError(
    'network',
    `无法连接控制台（检查地址 / 代理 / 控制台是否在跑）：${error instanceof Error ? error.message : String(error)}`
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
    return new CloudApiError('unauthorized', `控制台拒绝了${what}请求（${status}）：会话令牌无效或未配置`, {
      status,
    })
  }
  return new CloudApiError(
    status >= 500 ? 'server' : 'bad_request',
    `控制台${what}失败（${status}）${detail ? `：${detail}` : ''}`,
    { status }
  )
}

export function createDashboardClient(input: {
  dashboardUrl: string
  token: string
}): DashboardClient {
  const base = String(input.dashboardUrl ?? '').replace(/\/+$/, '')
  if (!base) throw new CloudApiError('bad_request', '控制台地址为空')
  if (!input.token) {
    throw new CloudApiError('unauthorized', '还没有填写控制台会话令牌（服务端 .env 的 HERMES_DASHBOARD_SESSION_TOKEN）')
  }
  const headers = { Authorization: `Bearer ${input.token}` }

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
          throw new CloudApiError('server', '控制台没有返回图片路径')
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
          throw new CloudApiError('server', '控制台返回的不是图片数据')
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
