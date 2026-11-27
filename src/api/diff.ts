/**
 * Line-level text diff powered by fast-diff (Myers O(ND) with linear space).
 * Returns line-by-line differences with 1-based original/modified line numbers.
 */

import fastDiff from 'fast-diff'
import type { FileEdit } from '../types/electron'

export enum DiffLineType {
  Added = 'added',
  Removed = 'removed',
  Unchanged = 'unchanged',
  Context = 'context',
}

export interface DiffLine {
  type: DiffLineType
  /** 该行在原始文件中的行号（Added 行没有） */
  originalLineNumber?: number
  /** 该行在修改后文件中的行号（Removed 行没有） */
  modifiedLineNumber?: number
  content: string
}

export interface DiffResult {
  originalFile: string
  modifiedFile: string
  lines: DiffLine[]
  addedCount: number
  removedCount: number
}

const SURROGATE_START = 0xd800
const SURROGATE_END = 0xdfff
const MAX_BMP_CODE = 0xffff
/** 单字符 UTF-16 编码上限（跳过 U+0000 与代理区 U+D800..U+DFFF，保留安全裕量） */
const MAX_UNIQUE_LINES = 60_000

function fallbackPairedDiff(
  originalLines: string[],
  modifiedLines: string[],
  originalStart: number,
  modifiedStart: number
): DiffLine[] {
  const lines: DiffLine[] = []
  const max = Math.max(originalLines.length, modifiedLines.length)
  for (let i = 0; i < max; i++) {
    if (i < originalLines.length) {
      lines.push({
        type: DiffLineType.Removed,
        originalLineNumber: originalStart + i + 1,
        content: originalLines[i],
      })
    }
    if (i < modifiedLines.length) {
      lines.push({
        type: DiffLineType.Added,
        modifiedLineNumber: modifiedStart + i + 1,
        content: modifiedLines[i],
      })
    }
  }
  return lines
}

/**
 * 将唯一行映射为单个非代理 BMP 字符，使 fast-diff 直接以行粒度执行线性空间 Myers 差分。
 * 唯一行数超过 MAX_UNIQUE_LINES 时返回 null，交由调用方走安全退化路径。
 */
function encodeLinesToChars(
  originalLines: string[],
  modifiedLines: string[]
): { encodedOld: string; encodedNew: string } | null {
  const lineToChar = new Map<string, string>()
  let nextCode = 1
  let uniqueCount = 0

  const encode = (source: string[]): string | null => {
    const chars = new Array<string>(source.length)
    for (let i = 0; i < source.length; i++) {
      const line = source[i]
      let ch = lineToChar.get(line)
      if (ch === undefined) {
        if (uniqueCount >= MAX_UNIQUE_LINES) return null
        if (nextCode >= SURROGATE_START && nextCode <= SURROGATE_END) {
          nextCode = SURROGATE_END + 1
        }
        if (nextCode > MAX_BMP_CODE) return null
        ch = String.fromCharCode(nextCode++)
        uniqueCount++
        lineToChar.set(line, ch)
      }
      chars[i] = ch
    }
    return chars.join('')
  }

  const encodedOld = encode(originalLines)
  if (encodedOld === null) return null
  const encodedNew = encode(modifiedLines)
  if (encodedNew === null) return null
  return { encodedOld, encodedNew }
}

/**
 * 对两段行数组做行级 Myers 差分（调用方已剥离公共前后缀）。
 * 线性空间复杂度，大文件不会分配 O(N*M) DP 矩阵。
 */
function diffMiddle(
  originalLines: string[],
  modifiedLines: string[],
  originalStart: number,
  modifiedStart: number
): DiffLine[] {
  const n = originalLines.length
  const m = modifiedLines.length

  if (n === 0 && m === 0) return []
  if (n === 0) {
    return modifiedLines.map((content, idx) => ({
      type: DiffLineType.Added,
      modifiedLineNumber: modifiedStart + idx + 1,
      content,
    }))
  }
  if (m === 0) {
    return originalLines.map((content, idx) => ({
      type: DiffLineType.Removed,
      originalLineNumber: originalStart + idx + 1,
      content,
    }))
  }

  const encoded = encodeLinesToChars(originalLines, modifiedLines)
  if (!encoded) {
    return fallbackPairedDiff(originalLines, modifiedLines, originalStart, modifiedStart)
  }

  const chunks = fastDiff(encoded.encodedOld, encoded.encodedNew)
  const lines: DiffLine[] = []
  let origIdx = 0
  let modIdx = 0

  for (const [op, text] of chunks) {
    const count = text.length
    if (op === 0) {
      for (let k = 0; k < count; k++) {
        lines.push({
          type: DiffLineType.Unchanged,
          originalLineNumber: originalStart + origIdx + 1,
          modifiedLineNumber: modifiedStart + modIdx + 1,
          content: originalLines[origIdx],
        })
        origIdx++
        modIdx++
      }
    } else if (op === -1) {
      for (let k = 0; k < count; k++) {
        lines.push({
          type: DiffLineType.Removed,
          originalLineNumber: originalStart + origIdx + 1,
          content: originalLines[origIdx],
        })
        origIdx++
      }
    } else if (op === 1) {
      for (let k = 0; k < count; k++) {
        lines.push({
          type: DiffLineType.Added,
          modifiedLineNumber: modifiedStart + modIdx + 1,
          content: modifiedLines[modIdx],
        })
        modIdx++
      }
    }
  }

  return lines
}

export function computeDiff(
  originalText: string,
  modifiedText: string,
  originalFileName: string = 'original',
  modifiedFileName: string = 'modified'
): DiffResult {
  const originalLines = originalText.split('\n')
  const modifiedLines = modifiedText.split('\n')

  const diffLines: DiffLine[] = []

  // 公共前缀
  let prefix = 0
  while (
    prefix < originalLines.length &&
    prefix < modifiedLines.length &&
    originalLines[prefix] === modifiedLines[prefix]
  ) {
    diffLines.push({
      type: DiffLineType.Unchanged,
      originalLineNumber: prefix + 1,
      modifiedLineNumber: prefix + 1,
      content: originalLines[prefix],
    })
    prefix++
  }

  // 公共后缀（从末尾往前）
  let originalEnd = originalLines.length
  let modifiedEnd = modifiedLines.length
  while (
    originalEnd > prefix &&
    modifiedEnd > prefix &&
    originalLines[originalEnd - 1] === modifiedLines[modifiedEnd - 1]
  ) {
    originalEnd--
    modifiedEnd--
  }

  diffLines.push(
    ...diffMiddle(
      originalLines.slice(prefix, originalEnd),
      modifiedLines.slice(prefix, modifiedEnd),
      prefix,
      prefix
    )
  )

  for (let offset = 0; originalEnd + offset < originalLines.length; offset++) {
    const originalIndex = originalEnd + offset
    const modifiedIndex = modifiedEnd + offset
    diffLines.push({
      type: DiffLineType.Unchanged,
      originalLineNumber: originalIndex + 1,
      modifiedLineNumber: modifiedIndex + 1,
      content: originalLines[originalIndex],
    })
  }

  let addedCount = 0
  let removedCount = 0
  for (const line of diffLines) {
    if (line.type === DiffLineType.Added) addedCount++
    else if (line.type === DiffLineType.Removed) removedCount++
  }

  return {
    originalFile: originalFileName,
    modifiedFile: modifiedFileName,
    lines: diffLines,
    addedCount,
    removedCount,
  }
}

export function formatDiffStats(result: DiffResult): string {
  return `+${result.addedCount} -${result.removedCount}`
}

/**
 * 把同一轮对话里对同一文件的多次修改合并成一条：
 * oldContent 取第一次修改前的内容，newContent 取最后一次修改后的内容。
 * 这样审阅队列里每个文件只出现一次。
 */
export function mergeFileEdits(edits: FileEdit[]): FileEdit[] {
  const byPath = new Map<string, FileEdit>()

  for (const edit of edits) {
    const existing = byPath.get(edit.path)
    if (existing) {
      byPath.set(edit.path, { ...existing, newContent: edit.newContent })
    } else {
      byPath.set(edit.path, { ...edit })
    }
  }

  return [...byPath.values()]
}
