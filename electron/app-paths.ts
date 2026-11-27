/**
 * 应用目录解析（严格两目录模型 + 可选便携模式）。
 *
 * - 开发模式：仓库根目录
 * - 打包版默认（标准模式）：
 *   - 程序目录 `getInstallDir()`：可执行文件所在目录（仅程序文件，更新时整包替换）
 *   - 唯一数据目录 `getAppDir()`：各系统标准用户数据目录 `<appData>/pi-workbench`
 *     （Windows `%APPDATA%\pi-workbench`、macOS `~/Library/Application Support/pi-workbench`、
 *      Linux `~/.config/pi-workbench`）
 * - 打包版便携模式（由免安装便携包在程序目录放置空 `portable` 标记文件，或显式传 `--data-dir`）：
 *   - 数据与程序同处 `getInstallDir()`（或 `--data-dir` 指定路径）
 */

import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

/** 便携版标记文件名（放在可执行文件 / AppImage 同级目录即启用单目录便携模式） */
export const PORTABLE_MARKER_FILE = 'portable'

/** 系统用户数据目录下的唯一应用文件夹名 */
export const APP_DATA_DIR_NAME = 'pi-workbench'

export interface ResolveAppPathsOptions {
  isPackaged?: boolean
  platform?: NodeJS.Platform
  appPath?: string
  exePath?: string
  appDataPath?: string
  appImagePath?: string
  argv?: string[]
  existsSync?: (target: string) => boolean
}

export interface ResolvedAppPaths {
  dataDir: string
  installDir: string
  portable: boolean
}

function readDataDirArg(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--data-dir=')) {
      const value = arg.slice('--data-dir='.length).trim()
      if (value) return value
    } else if (arg === '--data-dir') {
      const next = argv[index + 1]?.trim()
      if (next && !next.startsWith('-')) return next
    }
  }
  return null
}

let cachedDefaultPaths: { key: string; value: ResolvedAppPaths } | null = null

/** 清除默认路径解析缓存（仅用于测试切换模拟环境） */
export function resetAppPathsCache(): void {
  cachedDefaultPaths = null
}

function computeDefaultPathsCacheKey(): string {
  const isPackaged = Boolean(app.isPackaged)
  const platform = process.platform
  const appImagePath = process.env.APPIMAGE ?? ''
  if (!isPackaged) {
    return `dev\0${platform}\0${app.getAppPath()}`
  }
  const exeKey = appImagePath ? '' : app.getPath('exe')
  let appDataKey = ''
  try {
    appDataKey = app.getPath('appData')
  } catch {
    appDataKey = ''
  }
  return `pkg\0${platform}\0${appImagePath}\0${exeKey}\0${appDataKey}\0${process.argv.join('\0')}`
}

function resolveAppPathsUncached(options?: ResolveAppPathsOptions): ResolvedAppPaths {
  const isPackaged = options?.isPackaged ?? app.isPackaged
  const platform = options?.platform ?? process.platform
  const appImagePath = options?.appImagePath ?? process.env.APPIMAGE
  const argv = options?.argv ?? process.argv
  const checkExists = options?.existsSync ?? fs.existsSync

  if (!isPackaged) {
    const devDir = options?.appPath ?? app.getAppPath()
    return { dataDir: devDir, installDir: devDir, portable: false }
  }

  const installDir = appImagePath
    ? path.dirname(appImagePath)
    : path.dirname(options?.exePath ?? app.getPath('exe'))

  const cliDataDir = readDataDirArg(argv)
  if (cliDataDir) {
    return { dataDir: path.resolve(cliDataDir), installDir, portable: true }
  }

  // macOS .app 包内只读且会被更新整体替换，仅非 macOS 识别同级 portable 标记
  if (platform !== 'darwin' && installDir) {
    try {
      if (checkExists(path.join(installDir, PORTABLE_MARKER_FILE))) {
        return { dataDir: installDir, installDir, portable: true }
      }
    } catch {
      // 无法探测标记时回退标准模式
    }
  }

  const appDataPath = options?.appDataPath ?? app.getPath('appData')
  const dataDir = path.join(appDataPath, APP_DATA_DIR_NAME)
  return { dataDir, installDir, portable: false }
}

function resolveDefaultAppPaths(): ResolvedAppPaths {
  const key = computeDefaultPathsCacheKey()
  if (cachedDefaultPaths && cachedDefaultPaths.key === key) {
    return cachedDefaultPaths.value
  }
  const resolved = resolveAppPathsUncached()
  cachedDefaultPaths = { key, value: resolved }
  return resolved
}

/**
 * 纯函数路径解析，便于单测验证三平台与便携开关组合。
 * 生产调用省略参数时从 Electron `app` 与 `process` 读取真实环境，并按启动环境键缓存，
 * 避免高频 IPC / `pw-file://` 请求重复触发同步 `fs.existsSync`。
 */
export function resolveAppPaths(options?: ResolveAppPathsOptions): ResolvedAppPaths {
  if (options === undefined) {
    return { ...resolveDefaultAppPaths() }
  }
  return resolveAppPathsUncached(options)
}

/** 返回应用唯一数据目录（config / data / cache / logs 的共同根） */
export function getAppDir(): string {
  return resolveDefaultAppPaths().dataDir
}

/** 返回程序安装目录（只读程序文件所在目录） */
export function getInstallDir(): string {
  return resolveDefaultAppPaths().installDir
}

/** 当前是否以单目录便携模式运行（Windows 便携 zip 或 --data-dir） */
export function isPortableMode(): boolean {
  return resolveDefaultAppPaths().portable
}

/**
 * pi-bridge 构建产物的入口 URL。
 * 本模块与 main.js 同处 dist-electron（开发态在仓库根、打包后在 app.asar 根），
 * 因此退一级就是 pi-bridge 所在目录；不要在子目录模块里自行拼相对层级。
 */
export function getBridgeEntryUrl(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return pathToFileURL(path.join(here, '..', 'pi-bridge', 'dist', 'index.js')).href
}

/**
 * Pi SDK 的全局 agent 目录。
 *
 * SDK 的 getAgentDir() 默认是 `~/.pi/agent`；必须在任何 SDK 模块加载之前通过
 * 环境变量固定到应用数据目录，否则崩溃日志、扩展加载器、认证存储等默认入口会在
 * 用户主目录下创建文件。本模块是主进程最先加载的模块之一，赋值在这里生效。
 */
export const piAgentDir = path.join(getAppDir(), 'data', 'agent')
process.env.PI_CODING_AGENT_DIR = piAgentDir
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(piAgentDir, 'sessions')
