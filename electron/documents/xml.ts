/**
 * 流式 XML 扫描器（基于 `saxes` SAX 解析器，不建 DOM 树、不展开外部实体）。
 *
 * OOXML / ODF / XHTML 的文本抽取只需识别开闭标签、属性与文本；`saxes` 默认不解析
 * DTD 实体声明也不加载外部资源（天然防 XXE / 实体炸弹），这里按块喂给 `SaxesParser`，
 * 产出与各格式解析器兼容的 `open` / `close` / `text` token 流。
 */

import { SaxesParser } from 'saxes'

export interface XmlToken {
  type: 'open' | 'close' | 'text'
  /** 去掉命名空间前缀后的本地名，例如 `w:p` → `p` */
  name: string
  /** 属性：保留带前缀全名（如 `r:id`），未冲突时同时提供本地名别名（如 `val`） */
  attrs: Record<string, string>
  /** 自闭合标签（`<w:tab/>`） */
  selfClosing: boolean
  /** `type === 'text'` 时的已解码文本 */
  text: string
}

const ENTITIES: Record<string, string> = Object.assign(Object.create(null), {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
})

const FORBIDDEN_ATTR_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
/** 分块喂给 saxes 的字符长度：兼顾流式提前终止与低内存占用 */
const SCAN_CHUNK_CHARS = 65_536

function isValidCodePoint(code: number): boolean {
  return (
    Number.isInteger(code) &&
    code >= 0 &&
    code <= 0x10ffff &&
    !(code >= 0xd800 && code <= 0xdfff)
  )
}

export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match
    }
    const lower = body.toLowerCase()
    return Object.prototype.hasOwnProperty.call(ENTITIES, lower) ? ENTITIES[lower] : match
  })
}

/** `w:val` / `r:id` → `val` / `id`；无前缀原样返回 */
export function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

/** 按本地名取属性值；找不到返回 undefined */
export function attr(attrs: Record<string, string>, name: string): string | undefined {
  return attrs[name]
}

function normalizeAttributes(rawAttrs: Record<string, string>): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const [fullName, value] of Object.entries(rawAttrs)) {
    const local = localName(fullName)
    // 保留带命名空间前缀的完整名（如 `r:id`），避免 `<p:sldId r:id="rId2" id="256"/>`
    // 被同名无前缀属性覆盖导致幻灯片顺序错乱；同时在未冲突时提供本地名别名
    if (!FORBIDDEN_ATTR_KEYS.has(fullName)) {
      attrs[fullName] = value
    }
    if (
      local !== fullName &&
      !FORBIDDEN_ATTR_KEYS.has(local) &&
      !Object.prototype.hasOwnProperty.call(attrs, local)
    ) {
      attrs[local] = value
    }
  }
  return attrs
}

/** 顺序遍历 XML token；遇到无法闭合的脏数据就结束，不抛错 */
export function* scanXml(xml: string): Generator<XmlToken> {
  if (!xml) return

  const parser = new SaxesParser({ xmlns: false, position: false })
  parser.ENTITIES.nbsp = '\u00a0'

  const queue: XmlToken[] = []
  let stopped = false

  // saxes 遇到非严格 XML（片段、未定义实体、未闭合尾部）时走 error 事件；
  // 截断在标签/属性/注释内部时 `end()` 会触发 `unexpected end.`，此时立即停产避免泄漏残片。
  parser.on('error', (error) => {
    if (error.message.includes('unexpected end.')) {
      stopped = true
    }
  })

  // DTD 仅跳过、不解析也不展开任何实体（防 XXE / Billion Laughs）
  parser.on('doctype', () => {
    // intentionally ignored
  })

  parser.on('opentag', (tag) => {
    if (stopped) return
    queue.push({
      type: 'open',
      name: localName(tag.name),
      attrs: normalizeAttributes(tag.attributes),
      selfClosing: tag.isSelfClosing,
      text: '',
    })
  })

  parser.on('closetag', (tag) => {
    // 自闭合标签在 saxes 中会紧随 opentag 触发一次 closetag；
    // 下游 ooxml.ts 约定自闭合标签仅产出 `open(selfClosing: true)`，不产出 `close`
    if (stopped || tag.isSelfClosing) return
    queue.push({
      type: 'close',
      name: localName(tag.name),
      attrs: {},
      selfClosing: false,
      text: '',
    })
  })

  parser.on('text', (text) => {
    if (stopped || !text) return
    queue.push({
      type: 'text',
      name: '',
      attrs: {},
      selfClosing: false,
      text,
    })
  })

  parser.on('cdata', (cdata) => {
    if (stopped || !cdata) return
    queue.push({
      type: 'text',
      name: '',
      attrs: {},
      selfClosing: false,
      text: cdata,
    })
  })

  for (let offset = 0; offset < xml.length && !stopped; offset += SCAN_CHUNK_CHARS) {
    try {
      parser.write(xml.slice(offset, offset + SCAN_CHUNK_CHARS))
    } catch {
      stopped = true
    }
    if (queue.length > 0) {
      const batch = queue.splice(0, queue.length)
      for (const token of batch) yield token
    }
  }

  if (!stopped) {
    try {
      parser.close()
    } catch {
      // 脏尾部不抛错
    }
  }

  if (queue.length > 0) {
    const batch = queue.splice(0, queue.length)
    for (const token of batch) yield token
  }
}

/** 块级元素关闭时换行：XHTML 与 ODF 共用的近似规则 */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'tr',
  'blockquote',
  'section',
  'article',
  'pre',
  'br',
])

const SKIP_TAGS = new Set(['script', 'style', 'head'])

/** XHTML / HTML → 纯文本（EPUB 章节用）；`cellTags` 关闭时补制表符 */
export function htmlToText(xml: string): string {
  const lines: string[] = []
  let current = ''
  const skipDepth = { value: 0 }
  for (const token of scanXml(xml)) {
    if (token.type === 'text') {
      if (skipDepth.value > 0) continue
      current += token.text
      continue
    }
    if (token.type === 'open') {
      if (SKIP_TAGS.has(token.name) && !token.selfClosing) skipDepth.value += 1
      if (token.selfClosing && BLOCK_TAGS.has(token.name)) {
        lines.push(current)
        current = ''
      }
      continue
    }
    if (SKIP_TAGS.has(token.name) && skipDepth.value > 0) {
      skipDepth.value -= 1
      continue
    }
    if (token.name === 'td' || token.name === 'th') {
      current += '\t'
      continue
    }
    if (BLOCK_TAGS.has(token.name)) {
      lines.push(current)
      current = ''
    }
  }
  if (current) lines.push(current)
  return lines.map(normalizeSpaces).filter((line) => line.length > 0).join('\n')
}

/**
 * 折叠空白：制表符是表格列分隔，必须保留（空单元格会产生连续 `\t`），
 * 其余空白压成单个空格；行首尾去掉。
 */
export function normalizeSpaces(value: string): string {
  return value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) =>
      line
        .split('\t')
        .map((cell) => cell.replace(/[\s\u00a0]+/g, ' ').trim())
        .join('\t')
    )
    .join('\n')
}
