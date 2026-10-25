/** 形如 src/a.ts 或 src/a.ts:42 的片段才当作可点击路径 */
export function looksLikePath(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 200) return false
  if (trimmed.includes('\n') || /\s/.test(trimmed)) return false
  if (/^[a-z]+:\/\//i.test(trimmed)) return false
  return /^(?:[A-Za-z]:)?[\\/]?(?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z0-9]{1,8}(?::\d+)?$/.test(
    trimmed
  )
}

/** 拆出路径与可选行号 */
export function splitPathLine(value: string): { path: string; line: number | null } {
  const match = value.trim().match(/^(.*?)(?::(\d+))?$/)
  const filePath = match?.[1] ?? value.trim()
  const line = match?.[2] ? Number(match[2]) : null
  return { path: filePath, line: Number.isFinite(line) ? line : null }
}

/** 取路径最后一段（兼容 Windows / POSIX 分隔符） */
export function basename(targetPath: string): string {
  return targetPath.split(/[\\/]/).filter(Boolean).pop() ?? targetPath
}

/** 取父目录（兼容 Windows / POSIX 分隔符） */
export function dirname(targetPath: string): string {
  const index = Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\'))
  return index > 0 ? targetPath.slice(0, index) : targetPath
}

/** 渲染进程内的跨平台路径拼接（不能使用 Node 的 path 模块） */
export function joinPath(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const sep = trimmed.includes('\\') ? '\\' : '/'
  return `${trimmed}${sep}${name}`
}
