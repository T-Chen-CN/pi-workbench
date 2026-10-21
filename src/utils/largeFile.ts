export type LargeFileMode = 'normal' | 'large' | 'readonly'

export interface LargeFileInfo {
  mode: LargeFileMode
  bytes: number
  lines: number
}

/** 关闭换行 / 折叠（>2MB 或 >50k 行） */
const LARGE_BYTES = 2 * 1024 * 1024
const LARGE_LINES = 50_000
/** 只读打开（>10MB 或 >200k 行） */
const READONLY_BYTES = 10 * 1024 * 1024
const READONLY_LINES = 200_000

function countLines(content: string): number {
  if (content.length === 0) return 0
  let lines = 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1
  }
  return lines
}

/**
 * 根据内容判断是否需要进入大文件模式。
 * 只读阈值更高；大文件模式只影响编辑器选项，不改变内容。
 */
export function detectLargeFile(content: string): LargeFileInfo {
  const bytes = content.length
  const lines = countLines(content)
  if (bytes > READONLY_BYTES || lines > READONLY_LINES) {
    return { mode: 'readonly', bytes, lines }
  }
  if (bytes > LARGE_BYTES || lines > LARGE_LINES) {
    return { mode: 'large', bytes, lines }
  }
  return { mode: 'normal', bytes, lines }
}
