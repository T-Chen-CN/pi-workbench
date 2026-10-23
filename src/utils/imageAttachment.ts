/**
 * 图片附件预处理（R-08 优化）
 *
 * 统一规则，不按模型区分：
 * - 长边 ≤2048 且体积不大：原样发送，避免无意义的二次压缩
 * - 否则等比缩到 2048：PNG 截图优先保持无损，照片用 JPEG
 * - 所有上限只做通用兜底，供应商自己的限制作为最终裁决
 */

export const IMAGE_TARGET_LONG_EDGE = 2048
export const MAX_IMAGE_COUNT = 20
/** 源文件保护上限：避免解码超大图拖垮渲染进程 */
export const MAX_IMAGE_SOURCE_BYTES = 64 * 1024 * 1024
export const MAX_IMAGE_SOURCE_PIXELS = 100_000_000
/** 单张编码后上限（二进制字节） */
export const MAX_IMAGE_OUTPUT_BYTES = 10 * 1024 * 1024
/** base64 字符数上限，供发送前与主进程校验共用 */
export const MAX_IMAGE_BASE64_CHARS = Math.ceil((MAX_IMAGE_OUTPUT_BYTES * 4) / 3)
export const MAX_TOTAL_IMAGE_BASE64_CHARS = 48 * 1024 * 1024

export const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

export type ImagePrepareErrorCode =
  | 'unsupported'
  | 'tooLarge'
  | 'tooManyPixels'
  | 'encodeFailed'

export class ImagePrepareError extends Error {
  constructor(public readonly code: ImagePrepareErrorCode) {
    super(code)
    this.name = 'ImagePrepareError'
  }
}

export interface PreparedImage {
  /** base64，不含 data: 前缀 */
  data: string
  mimeType: string
  /** 最终发送的字节数 */
  size: number
  name: string
  optimized: boolean
}

/** 等比缩放到目标长边；无需缩放时返回原尺寸 */
export function scaledImageSize(
  width: number,
  height: number,
  longEdge = IMAGE_TARGET_LONG_EDGE
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= longEdge) return { width, height }
  const scale = longEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** GIF 不重新编码（canvas 会丢帧）；其余超过尺寸或体积才处理 */
export function shouldReencodeImage(
  type: string,
  size: number,
  width: number,
  height: number
): boolean {
  if (type === 'image/gif') return false
  if (size > MAX_IMAGE_OUTPUT_BYTES) return true
  return Math.max(width, height) > IMAGE_TARGET_LONG_EDGE
}

/** 按优先顺序尝试的编码：截图尽量无损，照片用高质量 JPEG */
export function preferredEncodings(
  sourceType: string
): Array<{ type: string; quality?: number }> {
  if (sourceType === 'image/png') {
    return [{ type: 'image/png' }, { type: 'image/jpeg', quality: 0.92 }]
  }
  if (sourceType === 'image/webp') {
    return [
      { type: 'image/webp', quality: 0.9 },
      { type: 'image/jpeg', quality: 0.9 },
    ]
  }
  return [
    { type: 'image/jpeg', quality: 0.9 },
    { type: 'image/jpeg', quality: 0.8 },
  ]
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      if (comma < 0) {
        reject(new ImagePrepareError('encodeFailed'))
        return
      }
      resolve(result.slice(comma + 1))
    }
    reader.onerror = () => reject(new ImagePrepareError('encodeFailed'))
    reader.readAsDataURL(blob)
  })
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality)
  })
}

/** 读取并（必要时）压缩图片，返回可直接发送的 base64 */
export async function prepareImageFile(file: File): Promise<PreparedImage> {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new ImagePrepareError('unsupported')
  }
  if (file.size > MAX_IMAGE_SOURCE_BYTES) {
    throw new ImagePrepareError('tooLarge')
  }

  // GIF 保持原样，超限直接拒绝（重新编码会丢动画）
  if (file.type === 'image/gif') {
    if (file.size > MAX_IMAGE_OUTPUT_BYTES) throw new ImagePrepareError('tooLarge')
    return {
      data: await readBlobAsBase64(file),
      mimeType: file.type,
      size: file.size,
      name: file.name,
      optimized: false,
    }
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // HEIC 等浏览器无法解码的格式
    throw new ImagePrepareError('unsupported')
  }

  try {
    if (bitmap.width * bitmap.height > MAX_IMAGE_SOURCE_PIXELS) {
      throw new ImagePrepareError('tooManyPixels')
    }

    if (!shouldReencodeImage(file.type, file.size, bitmap.width, bitmap.height)) {
      return {
        data: await readBlobAsBase64(file),
        mimeType: file.type,
        size: file.size,
        name: file.name,
        optimized: false,
      }
    }

    const target = scaledImageSize(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height
    const context = canvas.getContext('2d')
    if (!context) throw new ImagePrepareError('encodeFailed')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, target.width, target.height)

    for (const encoding of preferredEncodings(file.type)) {
      const blob = await canvasToBlob(canvas, encoding.type, encoding.quality)
      if (!blob) continue
      if (blob.size > MAX_IMAGE_OUTPUT_BYTES) continue
      return {
        data: await readBlobAsBase64(blob),
        mimeType: encoding.type,
        size: blob.size,
        name: file.name,
        optimized: true,
      }
    }
    throw new ImagePrepareError('tooLarge')
  } finally {
    bitmap.close?.()
  }
}
