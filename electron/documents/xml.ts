/**
 * 极简 XML 扫描器（只为抽取文本，不建树、不校验）。
 *
 * OOXML / ODF / XHTML 的分析需求只有三件事：认标签、取属性、取文本。引入完整
 * XML 解析器会带来 DTD / 实体展开等风险，也会增加体积；这里按 `<` `>` 逐段扫描，
 * 跳过注释、处理指令与 DOCTYPE，返回三种 token，交给各格式的处理函数自己走栈。
 */

export interface XmlToken {
  type: 'open' | 'close' | 'text'
  /** 去掉命名空间前缀后的本地名，例如 `w:p` → `p` */
  name: string
  /** 属性：本地名 → 值（`w:val` → `val`） */
  attrs: Record<string, string>
  /** 自闭合标签（`<w:tab/>`） */
  selfClosing: boolean
  /** `type === 'text'` 时的已解码文本 */
  text: string
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
}

export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body.toLowerCase()] ?? match
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

/** 标签内部的 `>` 可能出现在属性值里，扫描时跳过引号内的内容 */
function findTagEnd(xml: string, from: number): number {
  let quote: string | null = null
  for (let index = from + 1; index < xml.length; index += 1) {
    const char = xml[index]
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '>') return index
  }
  return -1
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const name = localName(match[1])
    const raw = match[2] ?? match[3] ?? ''
    attrs[name] = decodeXmlEntities(raw)
  }
  return attrs
}

/** 顺序遍历 XML token；遇到无法闭合的脏数据就结束，不抛错 */
export function* scanXml(xml: string): Generator<XmlToken> {
  let index = 0
  while (index < xml.length) {
    const lt = xml.indexOf('<', index)
    if (lt < 0) {
      const tail = xml.slice(index)
      if (tail) yield textToken(tail)
      return
    }
    if (lt > index) yield textToken(xml.slice(index, lt))

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      index = end < 0 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      const raw = xml.slice(lt + 9, end < 0 ? xml.length : end)
      if (raw) yield { type: 'text', name: '', attrs: {}, selfClosing: false, text: raw }
      index = end < 0 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt)
      index = end < 0 ? xml.length : end + 1
      continue
    }

    const gt = findTagEnd(xml, lt)
    if (gt < 0) return
    const raw = xml.slice(lt + 1, gt).trim()
    index = gt + 1
    if (!raw) continue

    if (raw.startsWith('/')) {
      yield { type: 'close', name: localName(raw.slice(1).trim()), attrs: {}, selfClosing: false, text: '' }
      continue
    }
    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const space = body.search(/[\s]/)
    const name = localName(space < 0 ? body : body.slice(0, space))
    const attrs = space < 0 ? {} : parseAttributes(body.slice(space))
    yield { type: 'open', name, attrs, selfClosing, text: '' }
  }
}

function textToken(raw: string): XmlToken {
  return { type: 'text', name: '', attrs: {}, selfClosing: false, text: decodeXmlEntities(raw) }
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
      if (SKIP_TAGS.has(token.name)) skipDepth.value += 1
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
