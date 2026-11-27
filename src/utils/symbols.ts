/**
 * 代码符号提取（E-01）
 *
 * 主路径使用 web-tree-sitter AST 解析（严格忽略注释与字符串字面量，精确到 1-based 起止行）；
 * WASM 未加载完成、不支持的语言或加载失败时无缝回退到轻量正则模式。
 */

import type Parser from 'web-tree-sitter'

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'method' | 'const'

export interface ExtractedSymbol {
  name: string
  kind: SymbolKind
  /** 1-based，含端点 */
  startLine: number
  endLine: number
}

interface Candidate {
  name: string
  kind: SymbolKind
  line: number
}

type TreeSitterLang =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'cpp'
  | 'c'

const MAX_SYMBOLS = 200

const TS_PATTERNS: Array<{ pattern: RegExp; kind: SymbolKind }> = [
  { pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
  { pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'type' },
  { pattern: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\()/, kind: 'const' },
  { pattern: /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/, kind: 'method' },
]

const PYTHON_PATTERNS: Array<{ pattern: RegExp; kind: SymbolKind }> = [
  { pattern: /^\s*(?:async\s+)?def\s+(\w+)\s*\(/, kind: 'function' },
  { pattern: /^\s*class\s+(\w+)\s*[:(]/, kind: 'class' },
]

const GO_PATTERNS: Array<{ pattern: RegExp; kind: SymbolKind }> = [
  { pattern: /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/, kind: 'function' },
  { pattern: /^type\s+(\w+)\s+(?:struct|interface)\b/, kind: 'type' },
]

const RUST_PATTERNS: Array<{ pattern: RegExp; kind: SymbolKind }> = [
  { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, kind: 'function' },
  { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: 'class' },
  { pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:enum|trait)\s+(\w+)/, kind: 'interface' },
]

const JVM_PATTERNS: Array<{ pattern: RegExp; kind: SymbolKind }> = [
  { pattern: /^\s*(?:(?:public|private|protected|static|final|abstract|sealed)\s+)*(?:class|record)\s+(\w+)/, kind: 'class' },
  { pattern: /^\s*(?:(?:public|private|protected|static|final|abstract|sealed)\s+)*interface\s+(\w+)/, kind: 'interface' },
]

const C_FAMILY_PATTERNS: Array<{ pattern: RegExp; kind: SymbolKind }> = [
  { pattern: /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+([A-Za-z_]\w*)\b[^{;]*\{/, kind: 'class' },
  { pattern: /^\s*(?:(?:static|inline|extern|virtual|constexpr|const)\s+)*[A-Za-z_][\w:<>*&\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/, kind: 'function' },
]

function patternsFor(fileName: string): Array<{ pattern: RegExp; kind: SymbolKind }> {
  const lower = fileName.toLowerCase()
  if (/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/.test(lower)) return TS_PATTERNS
  if (/\.py$/.test(lower)) return PYTHON_PATTERNS
  if (/\.go$/.test(lower)) return GO_PATTERNS
  if (/\.rs$/.test(lower)) return RUST_PATTERNS
  if (/\.(java|kt|cs|scala)$/.test(lower)) return JVM_PATTERNS
  if (/\.(c|h|cpp|cc|cxx|hpp|hh|hxx)$/.test(lower)) return C_FAMILY_PATTERNS
  return []
}

function treeSitterLangFor(fileName: string): TreeSitterLang | null {
  const lower = fileName.toLowerCase()
  if (/\.(ts|mts|cts)$/.test(lower)) return 'typescript'
  if (/\.tsx$/.test(lower)) return 'tsx'
  if (/\.(js|jsx|mjs|cjs)$/.test(lower)) return 'javascript'
  if (/\.py$/.test(lower)) return 'python'
  if (/\.go$/.test(lower)) return 'go'
  if (/\.rs$/.test(lower)) return 'rust'
  if (/\.java$/.test(lower)) return 'java'
  if (/\.(cpp|cc|cxx|hpp|hh|hxx)$/.test(lower)) return 'cpp'
  if (/\.(c|h)$/.test(lower)) return 'c'
  return null
}

/** 从声明行开始按花括号配对找到结束行；找不到返回 null */
function braceEnd(lines: string[], startLine: number): number | null {
  let depth = 0
  let started = false
  const limit = Math.min(lines.length, startLine + 400)
  for (let index = startLine - 1; index < limit; index++) {
    for (const char of lines[index]) {
      if (char === '{') {
        depth++
        started = true
      } else if (char === '}') {
        depth--
        if (started && depth <= 0) return index + 1
      }
    }
  }
  return null
}

function extractSymbolsRegex(content: string, fileName: string): ExtractedSymbol[] {
  const patterns = patternsFor(fileName)
  if (patterns.length === 0) return []

  const usesBraces = !/\.py$/i.test(fileName)
  const lines = content.split(/\r?\n/)
  const candidates: Candidate[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      continue
    }
    for (const { pattern, kind } of patterns) {
      const match = line.match(pattern)
      if (!match) continue
      candidates.push({ name: match[1], kind, line: index + 1 })
      break
    }
    if (candidates.length >= MAX_SYMBOLS) break
  }

  return candidates
    .sort((a, b) => a.line - b.line)
    .map((candidate, index, sorted) => {
      const nextLine = index + 1 < sorted.length ? sorted[index + 1].line - 1 : lines.length
      const braced = usesBraces ? braceEnd(lines, candidate.line) : null
      return {
        name: candidate.name,
        kind: candidate.kind,
        startLine: candidate.line,
        endLine: Math.max(candidate.line, braced ?? nextLine),
      }
    })
}

// ── web-tree-sitter AST 运行时（懒加载 + 按语言缓存） ──

type NodeProcessLike = { versions?: { node?: string }; cwd?: () => string }

function getNodeProcess(): NodeProcessLike | undefined {
  const proc = (globalThis as { process?: NodeProcessLike }).process
  return proc?.versions?.node ? proc : undefined
}

function resolveWasmLocation(filename: string, isCore: boolean): string {
  const proc = getNodeProcess()
  if (proc) {
    const cwd = typeof proc.cwd === 'function' ? proc.cwd() : '.'
    const normalizedCwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    return isCore
      ? `${normalizedCwd}/node_modules/web-tree-sitter/${filename}`
      : `${normalizedCwd}/node_modules/tree-sitter-wasms/out/${filename}`
  }
  const rel = `tree-sitter/${encodeURIComponent(filename)}`
  if (typeof document !== 'undefined' && document.baseURI) {
    return new URL(rel, document.baseURI).href
  }
  return `./${rel}`
}

let parserCtorPromise: Promise<typeof Parser> | null = null
let sharedParser: Parser | null = null
const loadedLanguages = new Map<TreeSitterLang, Parser.Language>()
const loadingLanguages = new Map<TreeSitterLang, Promise<Parser.Language | null>>()

async function ensureParserReady(): Promise<typeof Parser> {
  if (!parserCtorPromise) {
    parserCtorPromise = (async () => {
      const mod = await import('web-tree-sitter')
      const ParserCtor = ((mod as unknown as { default?: typeof Parser }).default ??
        mod) as typeof Parser
      await ParserCtor.init({
        locateFile(scriptName: string) {
          return resolveWasmLocation(scriptName, true)
        },
      })
      return ParserCtor
    })().catch((error) => {
      parserCtorPromise = null
      throw error
    })
  }
  const ParserCtor = await parserCtorPromise
  if (!sharedParser) {
    sharedParser = new ParserCtor()
  }
  return ParserCtor
}

async function ensureLanguageLoaded(lang: TreeSitterLang): Promise<Parser.Language | null> {
  const cached = loadedLanguages.get(lang)
  if (cached && sharedParser) return cached

  let pending = loadingLanguages.get(lang)
  if (!pending) {
    pending = (async () => {
      try {
        const ParserCtor = await ensureParserReady()
        const wasmFile = `tree-sitter-${lang}.wasm`
        const language = await ParserCtor.Language.load(resolveWasmLocation(wasmFile, false))
        loadedLanguages.set(lang, language)
        return language
      } catch {
        return null
      } finally {
        loadingLanguages.delete(lang)
      }
    })()
    loadingLanguages.set(lang, pending)
  }
  return pending
}

function extractCDeclaratorName(node: Parser.SyntaxNode | null): string | null {
  let current = node
  let guard = 0
  while (current && guard < 16) {
    guard++
    switch (current.type) {
      case 'identifier':
      case 'field_identifier':
      case 'destructor_name':
      case 'operator_name':
        return current.text
      case 'qualified_identifier': {
        const innerName = current.childForFieldName('name')
        return innerName ? innerName.text : current.text
      }
      case 'function_declarator':
      case 'pointer_declarator':
      case 'reference_declarator':
      case 'parenthesized_declarator':
      case 'attributed_declarator':
        current = current.childForFieldName('declarator') ?? current.firstNamedChild
        break
      default:
        return current.childForFieldName('declarator')
          ? extractCDeclaratorName(current.childForFieldName('declarator'))
          : null
    }
  }
  return null
}

function isFunctionValueNode(node: Parser.SyntaxNode | null): boolean {
  if (!node) return false
  return (
    node.type === 'arrow_function' ||
    node.type === 'function_expression' ||
    node.type === 'function' ||
    node.type === 'generator_function'
  )
}

function extractAstSymbols(
  root: Parser.SyntaxNode,
  lang: TreeSitterLang
): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = []

  const push = (name: string | undefined | null, kind: SymbolKind, node: Parser.SyntaxNode) => {
    if (!name || symbols.length >= MAX_SYMBOLS) return
    const startLine = node.startPosition.row + 1
    const endLine = Math.max(startLine, node.endPosition.row + 1)
    symbols.push({ name, kind, startLine, endLine })
  }

  if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
    const visitClassBody = (body: Parser.SyntaxNode | null) => {
      if (!body) return
      for (const member of body.namedChildren) {
        if (symbols.length >= MAX_SYMBOLS) return
        if (member.type === 'method_definition') {
          push(member.childForFieldName('name')?.text, 'method', member)
        } else if (
          (member.type === 'public_field_definition' || member.type === 'field_definition') &&
          isFunctionValueNode(member.childForFieldName('value'))
        ) {
          push(member.childForFieldName('name')?.text, 'method', member)
        }
      }
    }

    const visitJsTsNode = (node: Parser.SyntaxNode, rangeNode: Parser.SyntaxNode) => {
      if (symbols.length >= MAX_SYMBOLS) return
      switch (node.type) {
        case 'export_statement': {
          const decl = node.childForFieldName('declaration')
          if (decl) {
            visitJsTsNode(decl, node)
          } else {
            const val = node.childForFieldName('value')
            if (val && (val.type === 'function_expression' || val.type === 'class')) {
              const name = val.childForFieldName('name')?.text
              if (name) {
                push(name, val.type === 'class' ? 'class' : 'function', node)
              }
              if (val.type === 'class') visitClassBody(val.childForFieldName('body'))
            }
          }
          break
        }
        case 'function_declaration':
        case 'generator_function_declaration':
          push(node.childForFieldName('name')?.text, 'function', rangeNode)
          break
        case 'class_declaration':
        case 'abstract_class_declaration':
          push(node.childForFieldName('name')?.text, 'class', rangeNode)
          visitClassBody(node.childForFieldName('body'))
          break
        case 'interface_declaration':
          push(node.childForFieldName('name')?.text, 'interface', rangeNode)
          break
        case 'type_alias_declaration':
        case 'enum_declaration':
          push(node.childForFieldName('name')?.text, 'type', rangeNode)
          break
        case 'lexical_declaration':
        case 'variable_declaration': {
          const isConst = node.firstChild?.text === 'const'
          for (const child of node.namedChildren) {
            if (child.type !== 'variable_declarator') continue
            const val = child.childForFieldName('value')
            if (isConst && isFunctionValueNode(val)) {
              const nameNode = child.childForFieldName('name')
              if (nameNode?.type === 'identifier') {
                push(nameNode.text, 'const', rangeNode)
              }
            }
          }
          break
        }
        case 'ambient_declaration':
        case 'internal_module':
        case 'module': {
          const body = node.childForFieldName('body')
          if (body) {
            for (const stmt of body.namedChildren) visitJsTsNode(stmt, stmt)
          } else {
            for (const child of node.namedChildren) visitJsTsNode(child, child)
          }
          break
        }
      }
    }

    for (const stmt of root.namedChildren) {
      visitJsTsNode(stmt, stmt)
    }
  } else if (lang === 'python') {
    const visitPythonBlock = (container: Parser.SyntaxNode, inClass: boolean) => {
      for (const stmt of container.namedChildren) {
        if (symbols.length >= MAX_SYMBOLS) return
        const rangeNode = stmt
        const target =
          stmt.type === 'decorated_definition'
            ? stmt.childForFieldName('definition')
            : stmt
        if (!target) continue
        if (target.type === 'class_definition') {
          push(target.childForFieldName('name')?.text, 'class', rangeNode)
          const body = target.childForFieldName('body')
          if (body) visitPythonBlock(body, true)
        } else if (target.type === 'function_definition') {
          push(
            target.childForFieldName('name')?.text,
            inClass ? 'method' : 'function',
            rangeNode
          )
        }
      }
    }
    visitPythonBlock(root, false)
  } else if (lang === 'go') {
    for (const stmt of root.namedChildren) {
      if (symbols.length >= MAX_SYMBOLS) break
      if (stmt.type === 'function_declaration') {
        push(stmt.childForFieldName('name')?.text, 'function', stmt)
      } else if (stmt.type === 'method_declaration') {
        push(stmt.childForFieldName('name')?.text, 'method', stmt)
      } else if (stmt.type === 'type_declaration') {
        for (const spec of stmt.namedChildren) {
          if (spec.type !== 'type_spec') continue
          const typeNode = spec.childForFieldName('type')
          const kind: SymbolKind = typeNode?.type === 'interface_type' ? 'interface' : 'type'
          push(spec.childForFieldName('name')?.text, kind, spec)
        }
      }
    }
  } else if (lang === 'rust') {
    const visitRustItems = (container: Parser.SyntaxNode) => {
      for (const item of container.namedChildren) {
        if (symbols.length >= MAX_SYMBOLS) return
        switch (item.type) {
          case 'function_item':
            push(item.childForFieldName('name')?.text, 'function', item)
            break
          case 'struct_item':
            push(item.childForFieldName('name')?.text, 'class', item)
            break
          case 'enum_item':
          case 'trait_item':
            push(item.childForFieldName('name')?.text, 'interface', item)
            break
          case 'type_item':
            push(item.childForFieldName('name')?.text, 'type', item)
            break
          case 'impl_item': {
            const body = item.childForFieldName('body')
            if (body) {
              for (const member of body.namedChildren) {
                if (member.type === 'function_item') {
                  push(member.childForFieldName('name')?.text, 'method', member)
                }
              }
            }
            break
          }
          case 'mod_item': {
            const body = item.childForFieldName('body')
            if (body) visitRustItems(body)
            break
          }
        }
      }
    }
    visitRustItems(root)
  } else if (lang === 'java') {
    const visitJavaContainer = (container: Parser.SyntaxNode, inType: boolean) => {
      for (const node of container.namedChildren) {
        if (symbols.length >= MAX_SYMBOLS) return
        if (node.type === 'class_declaration' || node.type === 'record_declaration') {
          push(node.childForFieldName('name')?.text, 'class', node)
          const body = node.childForFieldName('body')
          if (body) visitJavaContainer(body, true)
        } else if (node.type === 'interface_declaration' || node.type === 'enum_declaration') {
          push(node.childForFieldName('name')?.text, 'interface', node)
          const body = node.childForFieldName('body')
          if (body) visitJavaContainer(body, true)
        } else if (inType && node.type === 'method_declaration') {
          push(node.childForFieldName('name')?.text, 'method', node)
        }
      }
    }
    visitJavaContainer(root, false)
  } else if (lang === 'cpp' || lang === 'c') {
    const visitCContainer = (container: Parser.SyntaxNode, inClass: boolean) => {
      for (const node of container.namedChildren) {
        if (symbols.length >= MAX_SYMBOLS) return
        switch (node.type) {
          case 'function_definition': {
            const name = extractCDeclaratorName(node.childForFieldName('declarator'))
            push(name, inClass ? 'method' : 'function', node)
            break
          }
          case 'class_specifier':
          case 'struct_specifier': {
            const body = node.childForFieldName('body')
            if (!body) break
            push(node.childForFieldName('name')?.text, 'class', node)
            visitCContainer(body, true)
            break
          }
          case 'template_declaration':
            visitCContainer(node, inClass)
            break
          case 'namespace_definition':
          case 'linkage_specification': {
            const body = node.childForFieldName('body')
            if (body) visitCContainer(body, inClass)
            break
          }
          case 'type_definition': {
            const typeNode = node.childForFieldName('type')
            const decl = node.childForFieldName('declarator')
            if (
              typeNode &&
              (typeNode.type === 'struct_specifier' || typeNode.type === 'class_specifier') &&
              typeNode.childForFieldName('body')
            ) {
              const name =
                decl?.text || typeNode.childForFieldName('name')?.text
              push(name, 'class', node)
            }
            break
          }
        }
      }
    }
    visitCContainer(root, false)
  }

  return symbols.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
}

function parseWithCachedLanguage(
  content: string,
  lang: TreeSitterLang,
  parser: Parser,
  language: Parser.Language
): ExtractedSymbol[] {
  parser.setLanguage(language)
  const tree = parser.parse(content)
  try {
    return extractAstSymbols(tree.rootNode, lang)
  } finally {
    tree.delete()
  }
}

/**
 * 同步提取符号：对应语言的 tree-sitter 解析器已就绪时立即走 AST，否则回退正则。
 */
export function extractSymbols(content: string, fileName: string): ExtractedSymbol[] {
  const lang = treeSitterLangFor(fileName)
  if (lang && sharedParser) {
    const language = loadedLanguages.get(lang)
    if (language) {
      try {
        return parseWithCachedLanguage(content, lang, sharedParser, language)
      } catch {
        // 解析异常时安全回退正则
      }
    }
  }
  return extractSymbolsRegex(content, fileName)
}

/**
 * 异步提取符号：按需懒加载 web-tree-sitter 与对应语言 WASM，走真实 AST；
 * 不支持的语言或 WASM 不可用时优雅回退正则。
 */
export async function extractSymbolsAsync(
  content: string,
  fileName: string
): Promise<ExtractedSymbol[]> {
  const lang = treeSitterLangFor(fileName)
  if (!lang) return extractSymbolsRegex(content, fileName)

  const language = await ensureLanguageLoaded(lang)
  if (language && sharedParser) {
    try {
      return parseWithCachedLanguage(content, lang, sharedParser, language)
    } catch {
      // 解析异常时回退正则
    }
  }
  return extractSymbolsRegex(content, fileName)
}

/** 预加载指定文件对应语言的 tree-sitter WASM（成功返回 true） */
export async function preloadSymbolParser(fileName: string): Promise<boolean> {
  const lang = treeSitterLangFor(fileName)
  if (!lang) return false
  const language = await ensureLanguageLoaded(lang)
  return language !== null
}

/** 清理已缓存的 parser / language（仅供测试隔离状态） */
export function resetSymbolParsersForTest(): void {
  if (sharedParser) {
    try {
      sharedParser.delete()
    } catch {
      // ignore
    }
    sharedParser = null
  }
  loadedLanguages.clear()
  loadingLanguages.clear()
}

/** 取符号对应的源码片段（1-based，含端点） */
export function sliceSymbol(content: string, symbol: ExtractedSymbol): string {
  const lines = content.split(/\r?\n/)
  return lines.slice(symbol.startLine - 1, symbol.endLine).join('\n')
}
