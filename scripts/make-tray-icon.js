/**
 * 生成托盘模板图标（macOS 菜单栏用的单色 π，白色 + alpha）。
 *
 * 直接复用品牌图标 `app-icon.png` 的 π 字形：把浅色像素取成 alpha 掩膜，
 * 裁掉下方的 "TChen" 署名，再按面积平均降到 16 / 32 像素，
 * 这样菜单栏里的 π 与 Dock 图标是同一个字形。
 *
 * 用法：node scripts/make-tray-icon.js [--preview]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function decodePng(buf) {
  let off = 8
  let header = null
  const idat = []
  while (off < buf.length) {
    const length = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + length)
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9]
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + length
  }
  const { width, height, depth, colorType } = header
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
  if (!channels || depth !== 8) throw new Error(`unsupported PNG: colorType=${colorType} depth=${depth}`)
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = Buffer.from(raw.subarray(pos, pos + stride))
    pos += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let value = line[i]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = value & 0xff
    }
    line.copy(out, y * stride)
    prev = line
  }
  return { width, height, channels, data: out }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function encodePng(width, height, rgba) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 浅色（π 与署名）→ alpha，深色底 → 透明；只取上方 π 的区域 */
function buildMask(img) {
  const { width, height, channels, data } = img
  const limitRow = Math.round(height * 0.7)
  const mask = new Float32Array(width * height)
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < limitRow; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      const alpha = channels === 4 ? data[i + 3] / 255 : 1
      const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      // 平滑过渡，避免缩小时边缘发硬
      const coverage = Math.min(1, Math.max(0, (luminance - 140) / 80)) * alpha
      if (coverage <= 0) continue
      mask[y * width + x] = coverage
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) throw new Error('no glyph pixels found')
  return { mask, width, height, box: { minX, minY, maxX, maxY } }
}

/** 裁成正方形（含少量留白）后按面积平均缩放到 size×size */
function render(maskInfo, size) {
  const { mask, width, height, box } = maskInfo
  const glyphW = box.maxX - box.minX + 1
  const glyphH = box.maxY - box.minY + 1
  const side = Math.round(Math.max(glyphW, glyphH) * 1.06)
  const originX = (box.minX + box.maxX + 1) / 2 - side / 2
  const originY = (box.minY + box.maxY + 1) / 2 - side / 2
  const scale = side / size
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(originX + x * scale)
      const x1 = Math.max(x0 + 1, Math.floor(originX + (x + 1) * scale))
      const y0 = Math.floor(originY + y * scale)
      const y1 = Math.max(y0 + 1, Math.floor(originY + (y + 1) * scale))
      let sum = 0
      let count = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          count++
          if (sx >= 0 && sx < width && sy >= 0 && sy < height) sum += mask[sy * width + sx] ?? 0
        }
      }
      const index = (y * size + x) * 4
      out[index] = 255
      out[index + 1] = 255
      out[index + 2] = 255
      out[index + 3] = Math.round((count ? sum / count : 0) * 255)
    }
  }
  return out
}

const source = decodePng(readFileSync(path.join(root, 'app-icon.png')))
const maskInfo = buildMask(source)
const targets = [
  ['tray-template.png', 16],
  ['tray-template@2x.png', 32]
]
for (const [name, size] of targets) {
  writeFileSync(path.join(root, name), encodePng(size, size, render(maskInfo, size)))
  console.log(`${name}: ${size}×${size}`)
}
if (process.argv.includes('--preview')) {
  // 预览图杬在深灰底上：深色背景下才能看清 alpha 形状
  const size = 256
  const rgba = render(maskInfo, size)
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] / 255
    const base = 0x2b
    rgba[i] = Math.round(0xd8 * alpha + base * (1 - alpha))
    rgba[i + 1] = Math.round(0xd8 * alpha + base * (1 - alpha))
    rgba[i + 2] = Math.round(0xd8 * alpha + base * (1 - alpha))
    rgba[i + 3] = 255
  }
  writeFileSync(path.join(root, 'cache', 'tray-preview.png'), encodePng(size, size, rgba))
  console.log('cache/tray-preview.png: 256×256（预览用，不提交）')
}
