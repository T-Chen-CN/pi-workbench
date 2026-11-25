/** Windows Git Bash PATH 补充（供应商密钥不再写入进程环境，见 provider-presets/credentials-store） */

import * as path from 'path'
import { existsSync } from 'fs'

export interface LoggerLike {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

/**
 * Windows 上 Pi 的 bash 工具需要 Git Bash：它只查 Program Files 和 PATH。
 * 若 Git 安装在用户目录（常见于 per-user 安装），这里把 bash.exe 所在目录补进 PATH。
 */
export function ensureBashOnPath(logger: LoggerLike): void {
  if (process.platform !== 'win32') return

  const localAppData = process.env.LOCALAPPDATA ?? ''
  const programFiles = process.env.ProgramFiles ?? ''
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? ''

  const candidates = [
    path.join(localAppData, 'Programs', 'Git', 'bin'),
    path.join(localAppData, 'Programs', 'Git', 'usr', 'bin'),
    path.join(programFiles, 'Git', 'bin'),
    path.join(programFilesX86, 'Git', 'bin'),
    'C:\\Program Files\\Git\\bin',
  ].filter((dir) => dir && existsSync(path.join(dir, 'bash.exe')))

  if (candidates.length === 0) {
    logger.warn('[Agent Manager] Git Bash not found; the bash tool will be unavailable')
    return
  }

  const currentPath = process.env.PATH ?? ''
  const existing = currentPath
    .split(path.delimiter)
    .map((entry) => entry.toLowerCase())
    .filter(Boolean)
  const missing = candidates.filter((dir) => !existing.includes(dir.toLowerCase()))

  if (missing.length > 0) {
    process.env.PATH = [...missing, currentPath].join(path.delimiter)
    logger.info('[Agent Manager] Added Git Bash to PATH:', missing.join(', '))
  }
}
