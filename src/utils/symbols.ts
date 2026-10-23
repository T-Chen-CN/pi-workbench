/**
 * 轻量符号提取（E-01）
 *
 * Monaco 没有公开的“查询文档符号”API，这里用按语言的行模式识别常见声明，
 * 用于把单个函数 / 类作为上下文附加。识别不到时由调用方回退到整文件。
 */

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
  { pattern: /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*interface\s+(\w+)/, kind: 'interface' },
]

function patternsFor(fileName: string): Array<{ pattern: RegExp; kind: SymbolKind }> {
  const lower = fileName.toLowerCase()
  if (/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/.test(lower)) return TS_PATTERNS
  if (/\.py$/.test(lower)) return PYTHON_PATTERNS
  if (/\.go$/.test(lower)) return GO_PATTERNS
  if (/\.rs$/.test(lower)) return RUST_PATTERNS
  if (/\.(java|kt|cs|scala)$/.test(lower)) return JVM_PATTERNS
  return []
}

const MAX_SYMBOLS = 200

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

export function extractSymbols(content: string, fileName: string): ExtractedSymbol[] {
  const patterns = patternsFor(fileName)
  if (patterns.length === 0) return []

  const usesBraces = !/\.py$/i.test(fileName)
  const lines = content.split(/\r?\n/)
  const candidates: Candidate[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('*')) continue
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

/** 取符号对应的源码片段（1-based，含端点） */
export function sliceSymbol(content: string, symbol: ExtractedSymbol): string {
  const lines = content.split(/\r?\n/)
  return lines.slice(symbol.startLine - 1, symbol.endLine).join('\n')
}
