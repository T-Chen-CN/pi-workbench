/** 聊天图片附件的通用上限与校验；与渲染层、主进程保持一致 */

/** 单条消息的图片上限；渲染层 MAX_IMAGE_COUNT / MAX_ATTACHMENTS 同为 10 */
export const MAX_CHAT_IMAGES = 10
export const MAX_IMAGE_BASE64_CHARS = Math.ceil((10 * 1024 * 1024 * 4) / 3)
export const MAX_TOTAL_IMAGE_BASE64_CHARS = 48 * 1024 * 1024
export const CHAT_IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/i

/** 校验并归一化聊天图片；超限明确报错，不做静默过滤 */
export function validateChatImages(value: unknown): {
  images: Array<{ data: string; mimeType: string }>
  error?: string
} {
  if (value === undefined || value === null) return { images: [] }
  if (!Array.isArray(value)) return { images: [], error: 'Images must be an array.' }
  if (value.length > MAX_CHAT_IMAGES) {
    return { images: [], error: `At most ${MAX_CHAT_IMAGES} images can be sent at once.` }
  }
  const images: Array<{ data: string; mimeType: string }> = []
  let totalChars = 0
  for (const image of value) {
    const data = (image as { data?: unknown } | null)?.data
    const mimeType = (image as { mimeType?: unknown } | null)?.mimeType
    if (typeof data !== 'string' || data.length === 0) {
      return { images: [], error: 'Invalid image payload.' }
    }
    if (typeof mimeType !== 'string' || !CHAT_IMAGE_MIME.test(mimeType)) {
      return { images: [], error: 'Unsupported image format.' }
    }
    if (data.length > MAX_IMAGE_BASE64_CHARS) {
      return { images: [], error: 'Each image must be at most 10 MB.' }
    }
    totalChars += data.length
    if (totalChars > MAX_TOTAL_IMAGE_BASE64_CHARS) {
      return { images: [], error: 'Images exceed the total size limit.' }
    }
    images.push({ data, mimeType })
  }
  return { images }
}
