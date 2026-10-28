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
  // 相对部分的分隔符跟基准目录对齐：Windows 上不留下混用的正斜杠
  const rest = name.replace(/[\\/]+/g, sep).replace(new RegExp(`^\\${sep}+`), '')
  return `${trimmed}${sep}${rest}`
}

/** 形如 C:\\dir 或 \\\\server\\share 的 Windows 路径 */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/

/**
 * 判断两个路径是否指向同一文件：分隔符归一，Windows 路径忽略大小写。
 * 渲染层不能读 `process.platform`，所以按路径形状推断。
 */
export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  const a = normalize(left)
  const b = normalize(right)
  if (a === b) return true
  if (!WINDOWS_PATH.test(left.trim()) && !WINDOWS_PATH.test(right.trim())) return false
  return a.toLowerCase() === b.toLowerCase()
}
