/**
 * pdf.js 的静态资源表（CMap / 标准字体 / wasm 解码器）。
 *
 * 为什么用构建期虚拟模块而不是 `import.meta.glob('…?inline')`：
 * - 生产环境的渲染进程跑在 `file://` 下，`fetch('file://…')` 会被 Chromium 拒绝；
 * - 走 `pw-file://` 也能取，但要额外扩信任根，且开发（Vite http）与生产路径不一致；
 * - Vite 的 `?inline` 对 node_modules 里的二进制 asset 并不稳定（一部分会退化成
 *   `new URL(…).href`），而虚拟模块由 Node 直接读字节、自己 base64，行为确定。
 *
 * 三类资源各自一个 chunk，只有真正用到时才载入：普通 PDF 三个都不载，
 * CJK 缺 CMap 才载 cmaps，标准 14 字体才载 fonts，JBIG2 / JPX / ICC 才载 wasm。
 */
export type PdfBinaryKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'

type AssetTable = () => Promise<Record<string, string>>

const TABLES: Record<PdfBinaryKind, AssetTable> = {
  cMapUrl: () => import('virtual:pdfjs-assets/cmaps').then((module) => module.default),
  standardFontDataUrl: () =>
    import('virtual:pdfjs-assets/standard_fonts').then((module) => module.default),
  wasmUrl: () => import('virtual:pdfjs-assets/wasm').then((module) => module.default),
}

const cache = new Map<PdfBinaryKind, Promise<Record<string, string>>>()

function tableFor(kind: PdfBinaryKind): Promise<Record<string, string>> {
  const existing = cache.get(kind)
  if (existing) return existing
  const pending = TABLES[kind]()
  cache.set(kind, pending)
  return pending
}

/** base64 data URL → 字节；pdf.js 需要原始二进制，不能给它字符串 */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('Malformed data URL')
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * 替代 pdf.js 的 `DOMBinaryDataFactory`：不发请求，直接从打包进 bundle 的资源表取字节。
 * pdf.js 在 `BinaryDataFactory` 不是默认实现时会关闭 worker 内的 fetch，
 * 改为把 `{ kind, filename }` 回传主线程，这里就是那个入口。
 */
export class BundledBinaryDataFactory {
  // pdf.js 会以 `new BinaryDataFactory({ cMapUrl, standardFontDataUrl, wasmUrl })` 构造
  constructor(_options: { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null }) {
    void _options
  }

  async fetch({ kind, filename }: { kind: PdfBinaryKind; filename: string }): Promise<Uint8Array> {
    const table = await tableFor(kind)
    const dataUrl = table[filename]
    if (!dataUrl) throw new Error(`Missing bundled pdf.js asset: ${kind}/${filename}`)
    return dataUrlToBytes(dataUrl)
  }
}
