/**
 * Simple diff algorithm for text comparison
 * Returns line-by-line differences with context
 */

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

/**
 * 对两段行数组做 LCS 差异比较（调用方已剥离公共前后缀）。
 * 匹配规模过大时退化为逐行配对，避免 DP 表占用过多内存。
 */
function diffMiddle(
  originalLines: string[],
  modifiedLines: string[],
  originalStart: number,
  modifiedStart: number
): DiffLine[] {
  const lines: DiffLine[] = []
  const n = originalLines.length
  const m = modifiedLines.length

  if (n * m > 4_000_000) {
    const max = Math.max(n, m)
    for (let i = 0; i < max; i++) {
      if (i < n) {
        lines.push({
          type: DiffLineType.Removed,
          originalLineNumber: originalStart + i + 1,
          content: originalLines[i],
        })
      }
      if (i < m) {
        lines.push({
          type: DiffLineType.Added,
          modifiedLineNumber: modifiedStart + i + 1,
          content: modifiedLines[i],
        })
      }
    }
    return lines
  }

  // dp[i][j] = originalLines[i..] 与 modifiedLines[j..] 的最长公共子序列长度
  const width = m + 1
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        originalLines[i] === modifiedLines[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }

  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (originalLines[i] === modifiedLines[j]) {
      lines.push({
        type: DiffLineType.Unchanged,
        originalLineNumber: originalStart + i + 1,
        modifiedLineNumber: modifiedStart + j + 1,
        content: originalLines[i],
      })
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      lines.push({
        type: DiffLineType.Removed,
        originalLineNumber: originalStart + i + 1,
        content: originalLines[i],
      })
      i++
    } else {
      lines.push({
        type: DiffLineType.Added,
        modifiedLineNumber: modifiedStart + j + 1,
        content: modifiedLines[j],
      })
      j++
    }
  }
  while (i < n) {
    lines.push({
      type: DiffLineType.Removed,
      originalLineNumber: originalStart + i + 1,
      content: originalLines[i],
    })
    i++
  }
  while (j < m) {
    lines.push({
      type: DiffLineType.Added,
      modifiedLineNumber: modifiedStart + j + 1,
      content: modifiedLines[j],
    })
    j++
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
