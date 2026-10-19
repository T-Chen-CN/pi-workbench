/**
 * Simple diff algorithm for text comparison
 * Returns line-by-line differences with context
 */

export enum DiffLineType {
  Added = 'added',
  Removed = 'removed',
  Unchanged = 'unchanged',
  Context = 'context',
}

export interface DiffLine {
  type: DiffLineType
  lineNumber?: number
  content: string
}

export interface DiffResult {
  originalFile: string
  modifiedFile: string
  lines: DiffLine[]
  addedCount: number
  removedCount: number
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
  let addedCount = 0
  let removedCount = 0

  // Simple diff: show unchanged lines and mark changes
  const maxLength = Math.max(originalLines.length, modifiedLines.length)

  for (let i = 0; i < maxLength; i++) {
    const origLine = originalLines[i]
    const modLine = modifiedLines[i]

    if (origLine === modLine) {
      // Unchanged
      if (origLine !== undefined) {
        diffLines.push({
          type: DiffLineType.Unchanged,
          lineNumber: i + 1,
          content: origLine,
        })
      }
    } else {
      // Changed
      if (origLine !== undefined) {
        diffLines.push({
          type: DiffLineType.Removed,
          lineNumber: i + 1,
          content: origLine,
        })
        removedCount++
      }

      if (modLine !== undefined) {
        diffLines.push({
          type: DiffLineType.Added,
          lineNumber: i + 1,
          content: modLine,
        })
        addedCount++
      }
    }
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
