import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_COUNT,
  MAX_IMAGE_OUTPUT_BYTES,
  MAX_IMAGE_BASE64_CHARS,
  MAX_TOTAL_IMAGE_BASE64_CHARS,
  preferredEncodings,
  scaledImageSize,
  shouldReencodeImage,
} from '../src/utils/imageAttachment'

describe('scaledImageSize', () => {
  it('keeps images within the target long edge unchanged', () => {
    expect(scaledImageSize(1920, 1080)).toEqual({ width: 1920, height: 1080 })
    expect(scaledImageSize(2048, 1200)).toEqual({ width: 2048, height: 1200 })
  })

  it('scales the long edge to 2048 and preserves the aspect ratio', () => {
    expect(scaledImageSize(4096, 2160)).toEqual({ width: 2048, height: 1080 })
    expect(scaledImageSize(1080, 6000)).toEqual({ width: 369, height: 2048 })
  })
})

describe('shouldReencodeImage', () => {
  it('skips small images and GIFs', () => {
    expect(shouldReencodeImage('image/jpeg', 500_000, 1920, 1080)).toBe(false)
    expect(shouldReencodeImage('image/gif', 6 * 1024 * 1024, 800, 600)).toBe(false)
  })

  it('re-encodes images over the dimension or size limit', () => {
    expect(shouldReencodeImage('image/png', 500_000, 4000, 2000)).toBe(true)
    expect(
      shouldReencodeImage('image/jpeg', MAX_IMAGE_OUTPUT_BYTES + 1, 1920, 1080)
    ).toBe(true)
  })
})

describe('preferredEncodings', () => {
  it('prefers lossless PNG for screenshots before falling back to JPEG', () => {
    expect(preferredEncodings('image/png')[0]).toEqual({ type: 'image/png' })
    expect(preferredEncodings('image/png')[1].type).toBe('image/jpeg')
  })

  it('uses high-quality JPEG for photos', () => {
    expect(preferredEncodings('image/jpeg')).toEqual([
      { type: 'image/jpeg', quality: 0.9 },
      { type: 'image/jpeg', quality: 0.8 },
    ])
  })
})

describe('image limits', () => {
  it('keeps a generous but bounded budget', () => {
    // 与文件附件共用同一条消息的 10 个附件上限
    expect(MAX_IMAGE_COUNT).toBe(10)
    expect(MAX_IMAGE_OUTPUT_BYTES).toBe(10 * 1024 * 1024)
    expect(MAX_IMAGE_BASE64_CHARS).toBeGreaterThan(MAX_IMAGE_OUTPUT_BYTES)
    expect(MAX_TOTAL_IMAGE_BASE64_CHARS).toBe(48 * 1024 * 1024)
  })
})
