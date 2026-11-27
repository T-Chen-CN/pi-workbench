/**
 * Node / worker_threads 环境的 web-tree-sitter 顶层导出符号提取器。
 *
 * 供 `electron/repo-map.ts`（含 `repo-map-worker.ts` 后台线程）调用，不引入 `electron` 模块；
 * 严格按语法树提取对外导出/公开符号，天然跳过注释与字符串字面量里的伪声明。
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import type Parser from 'web-tree-sitter'

const MAX_EXPORTS = 3

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

function languageForPath(filePath: string): TreeSitterLang | null {
  const lower = filePath.toLowerCase()
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

const hereDir = path.dirname(fileURLToPath(import.meta.url))
const appRootDir = path.resolve(hereDir, '..')

function findExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // 忽略不可访问路径
    }
  }
  return null
}

function locateCoreWasm(scriptName: string): string | null {
  return findExistingPath([
    path.join(appRootDir, 'dist', 'tree-sitter', scriptName),
    path.join(appRootDir, 'node_modules', 'web-tree-sitter', scriptName),
    path.join(process.cwd(), 'dist', 'tree-sitter', scriptName),
    path.join(process.cwd(), 'node_modules', 'web-tree-sitter', scriptName),
  ])
}

function locateLanguageWasm(lang: TreeSitterLang): string | null {
  const fileName = `tree-sitter-${lang}.wasm`
  return findExistingPath([
    path.join(appRootDir, 'dist', 'tree-sitter', fileName),
    path.join(appRootDir, 'node_modules', 'tree-sitter-wasms', 'out', fileName),
    path.join(process.cwd(), 'dist', 'tree-sitter', fileName),
    path.join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out', fileName),
  ])
}

let parserInitPromise: Promise<typeof Parser | null> | null = null
let sharedParser: Parser | null = null
const loadedLanguages = new Map<TreeSitterLang, Parser.Language | null>()
const loadingLanguages = new Map<TreeSitterLang, Promise<Parser.Language | null>>()

async function ensureParserReady(): Promise<typeof Parser | null> {
  if (!parserInitPromise) {
    parserInitPromise = (async () => {
      try {
        const mod = await import('web-tree-sitter')
        const ParserCtor = ((mod as unknown as { default?: typeof Parser }).default ??
          mod) as typeof Parser
        await ParserCtor.init({
          locateFile(scriptName: string) {
            return locateCoreWasm(scriptName) ?? scriptName
          },
        })
        if (!sharedParser) {
          sharedParser = new ParserCtor()
        }
        return ParserCtor
      } catch {
        return null
      }
    })()
  }
  const ctor = await parserInitPromise
  if (ctor && !sharedParser) {
    sharedParser = new ctor()
  }
  return ctor
}

async function ensureLanguage(lang: TreeSitterLang): Promise<Parser.Language | null> {
  if (loadedLanguages.has(lang)) {
    return loadedLanguages.get(lang) ?? null
  }
  let pending = loadingLanguages.get(lang)
  if (!pending) {
    pending = (async () => {
      try {
        const ParserCtor = await ensureParserReady()
        if (!ParserCtor) return null
        const wasmPath = locateLanguageWasm(lang)
        if (!wasmPath) {
          loadedLanguages.set(lang, null)
          return null
        }
        const bytes = await fs.promises.readFile(wasmPath)
        const language = await ParserCtor.Language.load(new Uint8Array(bytes))
        loadedLanguages.set(lang, language)
        return language
      } catch {
        loadedLanguages.set(lang, null)
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
      default: {
        const inner = current.childForFieldName('declarator')
        return inner ? extractCDeclaratorName(inner) : null
      }
    }
  }
  return null
}

function collectJsTsExports(root: Parser.SyntaxNode, add: (name: string | null | undefined) => void): void {
  for (const stmt of root.namedChildren) {
    if (stmt.type === 'export_statement') {
      const decl = stmt.childForFieldName('declaration')
      if (decl) {
        if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
          for (const child of decl.namedChildren) {
            if (child.type !== 'variable_declarator') continue
            const nameNode = child.childForFieldName('name')
            if (nameNode?.type === 'identifier') add(nameNode.text)
          }
        } else {
          add(decl.childForFieldName('name')?.text)
        }
        continue
      }

      const clause = stmt.namedChildren.find((child) => child.type === 'export_clause')
      if (clause) {
        for (const spec of clause.namedChildren) {
          if (spec.type !== 'export_specifier') continue
          const exported = spec.childForFieldName('alias') ?? spec.childForFieldName('name')
          add(exported?.text)
        }
        continue
      }

      const value = stmt.childForFieldName('value')
      if (value) {
        if (value.type === 'identifier') {
          add(value.text)
        } else if (value.type === 'function_expression' || value.type === 'class') {
          add(value.childForFieldName('name')?.text)
        }
      }
    } else if (stmt.type === 'expression_statement') {
      const expr = stmt.firstNamedChild
      if (expr?.type !== 'assignment_expression') continue
      const left = expr.childForFieldName('left')
      const right = expr.childForFieldName('right')
      if (left?.type !== 'member_expression' || !right) continue

      const obj = left.childForFieldName('object')
      const prop = left.childForFieldName('property')
      if (obj?.type === 'identifier' && obj.text === 'module' && prop?.text === 'exports') {
        if (right.type === 'object') {
          for (const entry of right.namedChildren) {
            if (entry.type === 'shorthand_property_identifier') {
              add(entry.text)
            } else if (entry.type === 'pair') {
              const key = entry.childForFieldName('key')
              if (key?.type === 'property_identifier' || key?.type === 'identifier') {
                add(key.text)
              }
            }
          }
        } else if (right.type === 'identifier') {
          add(right.text)
        } else if (right.type === 'function_expression' || right.type === 'class') {
          add(right.childForFieldName('name')?.text)
        }
      } else if (
        obj?.type === 'member_expression' &&
        obj.childForFieldName('object')?.text === 'module' &&
        obj.childForFieldName('property')?.text === 'exports'
      ) {
        add(prop?.text)
      } else if (obj?.type === 'identifier' && obj.text === 'exports') {
        add(prop?.text)
      }
    }
  }
}

function collectPythonExports(root: Parser.SyntaxNode, add: (name: string | null | undefined) => void): void {
  for (const stmt of root.namedChildren) {
    const target =
      stmt.type === 'decorated_definition' ? stmt.childForFieldName('definition') : stmt
    if (!target) continue
    if (target.type === 'function_definition' || target.type === 'class_definition') {
      const name = target.childForFieldName('name')?.text
      if (name && !name.startsWith('_')) add(name)
    }
  }
}

function collectGoExports(root: Parser.SyntaxNode, add: (name: string | null | undefined) => void): void {
  for (const stmt of root.namedChildren) {
    if (stmt.type === 'function_declaration' || stmt.type === 'method_declaration') {
      const name = stmt.childForFieldName('name')?.text
      if (name && /^[A-Z]/.test(name)) add(name)
    } else if (stmt.type === 'type_declaration') {
      for (const spec of stmt.namedChildren) {
        if (spec.type !== 'type_spec') continue
        const name = spec.childForFieldName('name')?.text
        if (name && /^[A-Z]/.test(name)) add(name)
      }
    }
  }
}

function collectRustExports(root: Parser.SyntaxNode, add: (name: string | null | undefined) => void): void {
  for (const item of root.namedChildren) {
    if (
      item.type !== 'function_item' &&
      item.type !== 'struct_item' &&
      item.type !== 'enum_item' &&
      item.type !== 'trait_item' &&
      item.type !== 'type_item'
    ) {
      continue
    }
    const isPub = item.namedChildren.some(
      (child) => child.type === 'visibility_modifier' && child.text.startsWith('pub')
    )
    if (!isPub) continue
    add(item.childForFieldName('name')?.text)
  }
}

function collectJavaExports(root: Parser.SyntaxNode, add: (name: string | null | undefined) => void): void {
  for (const node of root.namedChildren) {
    if (
      node.type !== 'class_declaration' &&
      node.type !== 'interface_declaration' &&
      node.type !== 'record_declaration' &&
      node.type !== 'enum_declaration'
    ) {
      continue
    }
    const modifiers = node.namedChildren.find((child) => child.type === 'modifiers')
    if (!modifiers || !/\bpublic\b/.test(modifiers.text)) continue
    add(node.childForFieldName('name')?.text)
  }
}

function collectCExports(container: Parser.SyntaxNode, add: (name: string | null | undefined) => void): void {
  for (const node of container.namedChildren) {
    switch (node.type) {
      case 'function_definition':
        add(extractCDeclaratorName(node.childForFieldName('declarator')))
        break
      case 'class_specifier':
      case 'struct_specifier':
        if (node.childForFieldName('body')) {
          add(node.childForFieldName('name')?.text)
        }
        break
      case 'template_declaration':
        collectCExports(node, add)
        break
      case 'namespace_definition':
      case 'linkage_specification': {
        const body = node.childForFieldName('body')
        if (body) collectCExports(body, add)
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
          add(decl?.text || typeNode.childForFieldName('name')?.text)
        }
        break
      }
    }
  }
}

/**
 * 通过 web-tree-sitter AST 提取最多 3 个顶层导出/公开符号名。
 * 不支持的扩展名或 WASM 不可用时返回 null，由调用方回退正则。
 */
export async function extractExportsAst(source: string, filePath: string): Promise<string[] | null> {
  const lang = languageForPath(filePath)
  if (!lang) return null

  const language = await ensureLanguage(lang)
  if (!language || !sharedParser) return null

  try {
    sharedParser.setLanguage(language)
    const tree = sharedParser.parse(source)
    try {
      const found: string[] = []
      const add = (name: string | null | undefined) => {
        if (!name || found.length >= MAX_EXPORTS || found.includes(name)) return
        found.push(name)
      }

      if (lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
        collectJsTsExports(tree.rootNode, add)
      } else if (lang === 'python') {
        collectPythonExports(tree.rootNode, add)
      } else if (lang === 'go') {
        collectGoExports(tree.rootNode, add)
      } else if (lang === 'rust') {
        collectRustExports(tree.rootNode, add)
      } else if (lang === 'java') {
        collectJavaExports(tree.rootNode, add)
      } else if (lang === 'cpp' || lang === 'c') {
        collectCExports(tree.rootNode, add)
      }

      return found
    } finally {
      tree.delete()
    }
  } catch {
    return null
  }
}
