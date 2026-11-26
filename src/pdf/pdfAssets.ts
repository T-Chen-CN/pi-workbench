/**
 * pdf.js 静态二进制资源加载器（CMap / 标准字体 / wasm 解码器）。
 *
 * 资源以原始二进制随包输出到 `dist/pdfjs/{cmaps,standard_fonts,wasm}/`，
 * 生产环境走 `pw-app://bundle/pdfjs/...`、开发态走 Vite 中间件按需 fetch，
 * 避免 3.7MB Base64 JS 模块的 33% 膨胀与主线程解析开销。
 */
export type PdfBinaryKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'

const GROUP_BY_KIND: Record<PdfBinaryKind, string> = {
  cMapUrl: 'cmaps',
  standardFontDataUrl: 'standard_fonts',
  wasmUrl: 'wasm',
}

const byteCache = new Map<string, Promise<Uint8Array>>()

function resolveAssetUrl(kind: PdfBinaryKind, filename: string): string {
  const safeName = encodeURIComponent(filename)
  const rel = `pdfjs/${GROUP_BY_KIND[kind]}/${safeName}`
  if (typeof document !== 'undefined' && document.baseURI) {
    return new URL(rel, document.baseURI).href
  }
  return `/${rel}`
}

/** 保留旧工具导出供单测兼容 */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('Malformed data URL')
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * 替代 pdf.js 的 `DOMBinaryDataFactory`：按需从应用同源静态资源目录拉取原始字节并缓存。
 */
export class BundledBinaryDataFactory {
  // pdf.js 会以 `new BinaryDataFactory({ cMapUrl, standardFontDataUrl, wasmUrl })` 构造
  constructor(_options: { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null }) {
    void _options
  }

  async fetch({ kind, filename }: { kind: PdfBinaryKind; filename: string }): Promise<Uint8Array> {
    const key = `${kind}/${filename}`
    let pending = byteCache.get(key)
    if (!pending) {
      pending = fetch(resolveAssetUrl(kind, filename)).then(async (res) => {
        if (!res.ok) throw new Error(`Missing bundled pdf.js asset: ${key} (${res.status})`)
        return new Uint8Array(await res.arrayBuffer())
      })
      byteCache.set(key, pending)
      pending.catch(() => byteCache.delete(key))
    }
    const cached = await pending
    // 返回副本防止 pdf.js worker transfer Detach 共享缓存的 ArrayBuffer
    return cached.slice()
  }
}
