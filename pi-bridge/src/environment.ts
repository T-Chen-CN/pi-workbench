/** 供应商环境变量租约与 Windows Git Bash PATH 补充 */

import * as path from 'path'
import { existsSync } from 'fs'
import { API_KEY_ENV } from './model-config.js'

export interface LoggerLike {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

/**
 * 供应商密钥通过 process.env 提供给 Pi SDK（models.json 只存变量名）。
 * 多个 Agent 实例共享进程环境，用引用计数保证最后一个实例释放后才清理。
 */
const providerEnvState = {
  users: 0,
  saved: new Map<string, string | undefined>(),
}
const PROVIDER_ENV_KEYS = ['PI_WORKBENCH_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const

export function acquireProviderEnv(apiKey: string, provider: string): void {
  if (providerEnvState.users === 0) {
    providerEnvState.saved.clear()
    for (const key of PROVIDER_ENV_KEYS) {
      providerEnvState.saved.set(key, process.env[key])
      delete process.env[key]
    }
  }
  providerEnvState.users++

  process.env[API_KEY_ENV] = apiKey
  if (provider === 'anthropic') {
    process.env.ANTHROPIC_API_KEY = apiKey
  } else if (provider === 'openai') {
    process.env.OPENAI_API_KEY = apiKey
  }
}

export function releaseProviderEnv(): void {
  if (providerEnvState.users === 0) return
  providerEnvState.users--
  if (providerEnvState.users > 0) return

  for (const [key, value] of providerEnvState.saved) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  providerEnvState.saved.clear()
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
