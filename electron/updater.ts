/**
 * 自动更新控制器。
 *
 * 只处理打包版本：
 * - Windows 安装版 / Linux AppImage 使用 electron-updater：检查后自动下载，但绝不自动安装
 * - macOS（未签名）与便携版（含 `portable` 标记）：仅检查 GitHub Release 并引导用户手动下载
 *
 * 三平台标准模式下，更新缓存统一落在 `{dataDir}/cache/pi-workbench-updater/`：
 * 因为数据目录与程序安装目录分离，Windows NSIS 卸载器不会误杀从数据目录启动的安装器，
 * 全机严格维持「程序目录 + 唯一数据目录」两处位置。
 */
import { app, shell } from 'electron'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
// electron-updater 是 CommonJS 模块：主进程以 ESM 运行，命名导入在 Node 的
// CJS 互操作下不可靠，必须走默认导入再取属性。
// 注意：autoUpdater 是惰性 getter，只有在真正创建更新器时才能访问，
// 否则会在测试/非 Electron 环境里提前实例化。
import electronUpdater from 'electron-updater'

export type UpdateStatusKind =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

export interface UpdateState {
  status: UpdateStatusKind
  currentVersion: string
  platform: NodeJS.Platform
  /** 可自动下载并安装（Windows / Linux）；macOS 为 false */
  canAutoInstall: boolean
  /** 新版本号（available / downloading / downloaded / not-available） */
  version?: string
  percent?: number
  releaseNotes?: string
  /** 面向用户的错误码或原始错误信息 */
  message?: string
  checkedAt?: number
  /** macOS 手动下载地址 */
  downloadUrl?: string
}

export interface UpdateCheckResult {
  success: boolean
  state: UpdateState
  error?: string
}

export interface UpdateActionResult {
  success: boolean
  error?: string
}

export interface UpdateLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

export interface PublishTarget {
  owner: string
  repo: string
  updaterCacheDirName: string
}

interface GithubRelease {
  tag_name?: string
  body?: string | null
  html_url?: string
  draft?: boolean
  prerelease?: boolean
}

interface UpdateInfoLike {
  version?: string
  releaseNotes?: unknown
}

interface DownloadProgressLike {
  percent?: number
}

interface AppAdapterLike {
  readonly version: string
  readonly name: string
  readonly isPackaged: boolean
  readonly appUpdateConfigPath: string
  readonly userDataPath: string
  readonly baseCachePath: string
  whenReady: () => Promise<void>
  relaunch: () => void
  quit: () => void
  onQuit: (handler: (exitCode: number) => void) => void
}

interface UpdaterEventMap {
  'checking-for-update': []
  'update-available': [info: UpdateInfoLike]
  'update-not-available': [info: UpdateInfoLike]
  'download-progress': [progress: DownloadProgressLike]
  'update-downloaded': [info: UpdateInfoLike]
  error: [error: unknown]
}

interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  /** Windows NSIS 安装目录；设置后 electron-updater 会传 `/D=` */
  installDirectory?: string
  logger: UpdateLogger
  on: <K extends keyof UpdaterEventMap>(
    event: K,
    listener: (...args: UpdaterEventMap[K]) => void
  ) => unknown
  checkForUpdates: () => Promise<{
    isUpdateAvailable?: boolean
    updateInfo?: UpdateInfoLike
    downloadPromise?: Promise<unknown> | null
  } | null>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void
}

export interface UpdateControllerOptions {
  /** 唯一数据目录（用于存放更新缓存 `{appDir}/cache/pi-workbench-updater`） */
  appDir: string
  /** 程序安装目录（Windows 固定 NSIS `/D=`；默认回退 appDir） */
  installDir?: string
  /** 是否为单目录便携版（便携版仅检查更新并引导下载，不自动运行 NSIS 安装器） */
  portable?: boolean
  emit: (state: UpdateState) => void
  currentVersion?: string
  platform?: NodeJS.Platform
  supported?: boolean
  resourcesPath?: string
  logger?: UpdateLogger
  openExternal?: (url: string) => Promise<void>
  publishTarget?: PublishTarget
  fetchRelease?: () => Promise<GithubRelease>
  createUpdater?: () => UpdaterLike
  /** 安装前确认钩子（Decision 4.A）：返回 false 时中止安装，绝不派生 NSIS 安装器 */
  confirmBeforeInstall?: () => boolean
  /** Windows 下将含空格的安装目录解析为 8.3 短路径（测试可注入） */
  resolveShortPath?: (dir: string) => string | null
}

export const UPDATE_ERROR = {
  notPackaged: 'ERR_UPDATE_NOT_PACKAGED',
  manualDownload: 'ERR_UPDATE_MANUAL',
  notDownloaded: 'ERR_UPDATE_NOT_DOWNLOADED',
  cancelled: 'ERR_UPDATE_CANCELLED',
  noRelease: 'ERR_UPDATE_NO_RELEASE',
  network: 'ERR_UPDATE_NETWORK',
  rateLimit: 'ERR_UPDATE_RATE_LIMIT',
} as const

const DEFAULT_PUBLISH_TARGET: PublishTarget = {
  owner: 'T-Chen-CN',
  repo: 'pi-workbench',
  updaterCacheDirName: 'pi-workbench-updater',
}

/**
 * electron-updater 的缓存基目录：三平台统一收口到 `{dataDir}/cache`
 * （其下由 electron-updater 建 `pi-workbench-updater/` 子目录），不再在 `%LOCALAPPDATA%` 额外建第 3 个目录。
 */
export function resolveUpdaterCacheBase(options: {
  appDir: string
  platform: NodeJS.Platform
}): string {
  return path.join(options.appDir, 'cache')
}

export interface UpdateCacheCleanupOptions {
  appDir: string
  platform: NodeJS.Platform
  /** 更新缓存子目录名（默认 pi-workbench-updater） */
  legacyCacheDirName?: string
  logger?: UpdateLogger
  retries?: number
  delayMs?: number
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 差分会用到、清理时必须保留的缓存项：
 * - installer.exe：已安装版本的安装包，electron-updater 以此为差分下载的旧文件
 * - current.blockmap：该版本的块表，缺失时下次要从远端重新拉旧 blockmap
 */
const RETAINED_CACHE_ENTRIES = new Set(['installer.exe', 'current.blockmap'])

/** 删除更新缓存目录里除差分基准以外的内容；目录清空后一并移除 */
function pruneUpdaterCacheDir(cacheDir: string): void {
  if (!fs.existsSync(cacheDir)) return
  for (const entry of fs.readdirSync(cacheDir)) {
    if (RETAINED_CACHE_ENTRIES.has(entry)) continue
    fs.rmSync(path.join(cacheDir, entry), { recursive: true, force: true })
  }
  if (fs.readdirSync(cacheDir).length === 0) {
    fs.rmdirSync(cacheDir)
  }
}

/**
 * Windows 安装完成后的缓存清理：只操作 `{cacheBase}/{updaterCacheDirName}`，
 * 保留差分基准 `installer.exe` 与 `current.blockmap`，绝不触碰同级的 `drafts/` 与 `temp/`。
 */
export function pruneUpdateCache(cacheBase: string, updaterCacheDirName: string): void {
  pruneUpdaterCacheDir(path.join(cacheBase, updaterCacheDirName))
}

/**
 * 安装完成后的缓存清理。
 *
 * 安装器在安装完成后写入 `{cacheBase}/{updaterCacheDirName}.flag`；应用启动看到标记就清理更新缓存：
 * Windows 保留差分基准 `installer.exe` 与 `current.blockmap`；其他平台删除整个更新子目录。
 * 绝不删除 `{cacheBase}` 本身或其下的 `drafts/` / `temp/`。
 */
export async function cleanupCompletedUpdateCache(
  options: UpdateCacheCleanupOptions
): Promise<boolean> {
  const logger = options.logger ?? console
  const cacheBase = resolveUpdaterCacheBase(options)
  const updaterDirName = options.legacyCacheDirName ?? DEFAULT_PUBLISH_TARGET.updaterCacheDirName
  const flagPath = path.join(cacheBase, `${updaterDirName}.flag`)
  const legacyFlagPath = `${cacheBase}.flag`
  const retries = Math.max(1, options.retries ?? 5)
  const delayMs = Math.max(0, options.delayMs ?? 500)

  const activeFlags = [flagPath, legacyFlagPath].filter((candidate) => {
    try {
      return fs.existsSync(candidate)
    } catch {
      return false
    }
  })
  let pending = activeFlags.length > 0

  if (pending) {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        if (options.platform === 'win32') {
          pruneUpdateCache(cacheBase, updaterDirName)
        } else {
          // 非 Windows 只删更新子目录，绝不能误删 drafts/temp
          fs.rmSync(path.join(cacheBase, updaterDirName), { recursive: true, force: true })
        }
        for (const flag of activeFlags) {
          fs.rmSync(flag, { force: true })
        }
        logger.info('[Updater] Cleaned completed update cache:', path.join(cacheBase, updaterDirName))
        pending = false
        break
      } catch (error) {
        if (attempt === retries) {
          logger.warn('[Updater] Deferred update cache cleanup:', errorMessage(error))
        } else {
          logger.warn('[Updater] Update cache busy, retrying:', errorMessage(error))
          await delay(delayMs)
        }
      }
    }
  }

  return !pending
}

interface ParsedSemver {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function parseSemver(value: string): ParsedSemver | null {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (!match) return null
  const prerelease = match[4] ? match[4].split('.').filter((part) => part.length > 0) : []
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

/** 把 `1.2.3` / `v1.2.3` / `1.2.3-beta.1` 解析成数字三元组 */
export function parseVersion(value: string): [number, number, number] | null {
  const parsed = parseSemver(value)
  if (!parsed) return null
  return [parsed.major, parsed.minor, parsed.patch]
}

/** 按 SemVer 2.0 规则比较版本号（含 prerelease：`0.11.2-rc.1 < 0.11.2`） */
export function compareSemver(left: string, right: string): number | null {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) return null
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1

  const aPre = a.prerelease
  const bPre = b.prerelease
  if (aPre.length === 0 && bPre.length === 0) return 0
  if (aPre.length === 0) return 1
  if (bPre.length === 0) return -1

  const len = Math.min(aPre.length, bPre.length)
  for (let i = 0; i < len; i += 1) {
    const idA = aPre[i]
    const idB = bPre[i]
    if (idA === idB) continue
    const numA = /^\d+$/.test(idA)
    const numB = /^\d+$/.test(idB)
    if (numA && numB) return Number(idA) > Number(idB) ? 1 : -1
    if (numA !== numB) return numA ? -1 : 1
    return idA > idB ? 1 : -1
  }
  if (aPre.length !== bPre.length) return aPre.length > bPre.length ? 1 : -1
  return 0
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const cmp = compareSemver(candidate, current)
  return cmp !== null && cmp > 0
}

/** 在 Windows 上尝试将含空格目录解析为 8.3 短路径，供 NSIS `/D=` 无引号传参使用 */
function defaultResolveWindowsShortPath(dir: string): string | null {
  if (process.platform !== 'win32') return null
  if (/["&|<>^%!;\r\n]/.test(dir)) return null
  try {
    if (!fs.existsSync(dir)) return null
    const raw = execFileSync(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/c', `for %I in ("${dir}") do @echo %~sI`],
      { windowsHide: true, encoding: 'utf8', timeout: 2000 }
    ).trim()
    if (!raw || /\s/.test(raw) || !fs.existsSync(raw)) return null
    return raw.replace(/[\\/]+$/, '')
  } catch {
    return null
  }
}

/** GitHub 的 release notes 可能是字符串或按版本分组的数组，统一成纯文本 */
export function normalizeReleaseNotes(notes: unknown): string | undefined {
  const plain = (value: string) =>
    value
      .replace(/<[^>]+>/g, '')
      .replace(/\r\n/g, '\n')
      .trim()

  if (typeof notes === 'string') {
    const text = plain(notes)
    return text || undefined
  }
  if (Array.isArray(notes)) {
    const parts = notes
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return ''
        const record = entry as { version?: unknown; note?: unknown }
        const version = typeof record.version === 'string' ? record.version : ''
        const note = typeof record.note === 'string' ? plain(record.note) : ''
        if (!note) return ''
        return version ? `${version}\n${note}` : note
      })
      .filter(Boolean)
    return parts.length > 0 ? parts.join('\n\n') : undefined
  }
  return undefined
}

/** 把底层错误归类成渲染进程可翻译的错误码 */
export function classifyUpdateError(message: string): string {
  const normalized = message.toLowerCase()
  if (
    normalized.includes('no published versions') ||
    normalized.includes('no published') ||
    normalized.includes('http error 404') ||
    normalized.includes('404') ||
    normalized.includes('not found')
  ) {
    return UPDATE_ERROR.noRelease
  }
  if (normalized.includes('rate limit') || normalized.includes('403')) {
    return UPDATE_ERROR.rateLimit
  }
  if (
    normalized.includes('enotfound') ||
    normalized.includes('econnrefused') ||
    normalized.includes('econnreset') ||
    normalized.includes('etimedout') ||
    normalized.includes('network') ||
    normalized.includes('timeout') ||
    normalized.includes('getaddrinfo')
  ) {
    return UPDATE_ERROR.network
  }
  return message
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readPublishTarget(resourcesPath: string): PublishTarget {
  try {
    const content = fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf-8')
    const read = (key: string) =>
      new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(content)?.[1]?.trim()
    const owner = read('owner')
    const repo = read('repo')
    const updaterCacheDirName = read('updaterCacheDirName')
    if (owner && repo) {
      return {
        owner,
        repo,
        updaterCacheDirName: updaterCacheDirName || DEFAULT_PUBLISH_TARGET.updaterCacheDirName,
      }
    }
  } catch {
    // 开发环境或缺少 app-update.yml 时使用仓库默认值
  }
  return DEFAULT_PUBLISH_TARGET
}

export class UpdateController {
  private readonly appDir: string
  private readonly installDir: string
  private readonly portable: boolean
  private readonly emit: (state: UpdateState) => void
  private readonly currentVersion: string
  private readonly platform: NodeJS.Platform
  private readonly supported: boolean
  private readonly resourcesPath: string
  private readonly logger: UpdateLogger
  private readonly openExternal: (url: string) => Promise<void>
  private readonly publishTarget: PublishTarget
  private readonly fetchRelease: () => Promise<GithubRelease>
  private readonly createUpdater: (() => UpdaterLike) | null
  private readonly confirmBeforeInstall: (() => boolean) | null
  private readonly resolveShortPath: (dir: string) => string | null
  private readonly cacheBase: string

  private state: UpdateState
  private updater: UpdaterLike | null = null
  private checkPromise: Promise<UpdateCheckResult> | null = null
  private downloadPromise: Promise<UpdateActionResult> | null = null

  constructor(options: UpdateControllerOptions) {
    this.appDir = options.appDir
    this.installDir = options.installDir ?? options.appDir
    this.portable = options.portable ?? false
    this.emit = options.emit
    this.currentVersion = options.currentVersion ?? app.getVersion()
    this.platform = options.platform ?? process.platform
    this.supported = options.supported ?? app.isPackaged
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath
    this.logger = options.logger ?? console
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url))
    this.publishTarget = options.publishTarget ?? readPublishTarget(this.resourcesPath)
    this.createUpdater = options.createUpdater ?? null
    this.confirmBeforeInstall = options.confirmBeforeInstall ?? null
    this.resolveShortPath = options.resolveShortPath ?? defaultResolveWindowsShortPath
    this.cacheBase = resolveUpdaterCacheBase({
      appDir: this.appDir,
      platform: this.platform,
    })
    this.fetchRelease =
      options.fetchRelease ??
      (() => this.fetchLatestGithubRelease())

    this.state = {
      status: this.supported ? 'idle' : 'unsupported',
      currentVersion: this.currentVersion,
      platform: this.platform,
      canAutoInstall: this.supported && this.platform !== 'darwin' && !this.portable,
      downloadUrl: this.releasePageUrl(),
    }
  }

  private get usesManualDownload(): boolean {
    return this.platform === 'darwin' || this.portable
  }

  getState(): UpdateState {
    return this.state
  }

  /** 检查更新。Windows / Linux 会在发现新版本后自动下载（autoDownload=true）。 */
  async check(): Promise<UpdateCheckResult> {
    if (!this.supported) {
      return { success: false, state: this.state, error: UPDATE_ERROR.notPackaged }
    }
    // 正在下载或已下载等待安装时，重复检查既会打断进度事件，也会把
    // downloaded 状态打回 available 导致重复弹窗；直接返回当前状态。
    if (this.state.status === 'downloading' || this.state.status === 'downloaded') {
      return { success: true, state: this.state }
    }
    if (this.checkPromise) return this.checkPromise

    this.checkPromise = this.runCheck().finally(() => {
      this.checkPromise = null
    })
    return this.checkPromise
  }

  /** 手动重试下载（自动下载失败时使用） */
  async download(): Promise<UpdateActionResult> {
    if (!this.supported) {
      return { success: false, error: UPDATE_ERROR.notPackaged }
    }
    if (this.usesManualDownload) {
      return { success: false, error: UPDATE_ERROR.manualDownload }
    }
    if (this.state.status === 'downloaded') {
      return { success: true }
    }
    if (this.downloadPromise) return this.downloadPromise

    this.downloadPromise = (async () => {
      try {
        await this.getUpdater().downloadUpdate()
        return { success: true }
      } catch (error) {
        const message = classifyUpdateError(errorMessage(error))
        this.logger.error('[Updater] Download failed:', message)
        this.setState({ status: 'error', message })
        return { success: false, error: message }
      } finally {
        this.downloadPromise = null
      }
    })()
    return this.downloadPromise
  }

  /** 退出并安装已下载的更新。调用前渲染进程负责确认运行中的任务。 */
  install(): UpdateActionResult {
    if (!this.supported) {
      return { success: false, error: UPDATE_ERROR.notPackaged }
    }
    if (this.usesManualDownload) {
      return { success: false, error: UPDATE_ERROR.manualDownload }
    }
    if (this.state.status !== 'downloaded') {
      return { success: false, error: UPDATE_ERROR.notDownloaded }
    }
    if (this.confirmBeforeInstall && !this.confirmBeforeInstall()) {
      this.logger.info('[Updater] Install cancelled by pre-install guard')
      return { success: false, error: UPDATE_ERROR.cancelled }
    }
    try {
      this.logger.info('[Updater] Installing update', this.state.version)
      // assisted（oneClick=false）安装器只有 isSilent=true 才会带 /S；
      // 否则用户点过“重启并安装”后还会看到第二次安装向导。
      this.getUpdater().quitAndInstall(true, true)
      return { success: true }
    } catch (error) {
      const message = errorMessage(error)
      this.logger.error('[Updater] Install failed:', message)
      return { success: false, error: message }
    }
  }

  /** 只允许打开 https://github.com 下的发布页，避免恶意远端响应注入非预期协议或钓鱼域 */
  private sanitizeGithubUrl(candidate: string | undefined): string {
    if (candidate) {
      try {
        const parsed = new URL(candidate)
        if (parsed.protocol === 'https:' && parsed.hostname === 'github.com') {
          return parsed.toString()
        }
      } catch {
        // fallback below
      }
    }
    return this.releasePageUrl()
  }

  /** macOS：打开 GitHub Release 页面手动下载 */
  async openDownloadPage(): Promise<UpdateActionResult> {
    try {
      await this.openExternal(this.sanitizeGithubUrl(this.state.downloadUrl))
      return { success: true }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  }

  private async runCheck(): Promise<UpdateCheckResult> {
    this.setState({ status: 'checking', message: undefined })
    try {
      const result = this.usesManualDownload
        ? await this.checkGithubRelease()
        : await this.checkUpdater()
      return result
    } catch (error) {
      const message = classifyUpdateError(errorMessage(error))
      this.logger.warn('[Updater] Check failed:', message)
      this.setState({ status: 'error', message, checkedAt: Date.now() })
      return { success: false, state: this.state, error: message }
    }
  }

  private async checkUpdater(): Promise<UpdateCheckResult> {
    const updater = this.getUpdater()
    const result = await updater.checkForUpdates()

    // autoDownload 会返回下载 Promise；失败时 electron-updater 已通过 error 事件
    // 通知界面，这里必须挂一个 catch，否则会成为未处理的 rejection。
    result?.downloadPromise?.catch(() => undefined)

    // 事件通常已经更新了状态；这里用 isUpdateAvailable 兜底，避免把“无更新”
    // 误判成“有新版本”（checkForUpdates 无更新时也会返回 updateInfo）。
    if (!result || result.isUpdateAvailable === false) {
      this.clearStaleCache()
      const version = result?.updateInfo?.version
      this.setState({ status: 'not-available', version, checkedAt: Date.now() })
      return { success: true, state: this.state }
    }

    if (this.state.status === 'checking') {
      this.setState({
        status: 'available',
        version: result.updateInfo?.version,
        releaseNotes: normalizeReleaseNotes(result.updateInfo?.releaseNotes),
        checkedAt: Date.now(),
      })
    }
    return { success: true, state: this.state }
  }

  private async checkGithubRelease(): Promise<UpdateCheckResult> {
    const release = await this.fetchRelease()
    const latest = (release.tag_name ?? '').replace(/^v/, '')
    if (!latest) {
      const message = UPDATE_ERROR.noRelease
      this.setState({ status: 'error', message, checkedAt: Date.now() })
      return { success: false, state: this.state, error: message }
    }

    if (isNewerVersion(latest, this.currentVersion)) {
      this.logger.info('[Updater] New macOS release available:', latest)
      this.setState({
        status: 'available',
        version: latest,
        releaseNotes: normalizeReleaseNotes(release.body),
        downloadUrl: this.sanitizeGithubUrl(release.html_url),
        checkedAt: Date.now(),
      })
    } else {
      this.setState({ status: 'not-available', version: latest, checkedAt: Date.now() })
    }
    return { success: true, state: this.state }
  }

  private async fetchLatestGithubRelease(): Promise<GithubRelease> {
    const url = `https://api.github.com/repos/${this.publishTarget.owner}/${this.publishTarget.repo}/releases/latest`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      // 走 globalThis.fetch（受 system-proxy 包装器控制），确保 useSystemProxy=false 时不被绕过
      const response = await globalThis.fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'pi-workbench-updater',
        },
        signal: controller.signal,
      })
      if (response.status === 404) {
        throw new Error(UPDATE_ERROR.noRelease)
      }
      if (response.status === 403) {
        throw new Error(UPDATE_ERROR.rateLimit)
      }
      if (!response.ok) {
        throw new Error(`GitHub release request failed: HTTP ${response.status}`)
      }
      return (await response.json()) as GithubRelease
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(UPDATE_ERROR.network)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private getUpdater(): UpdaterLike {
    if (this.updater) return this.updater

    const updater = this.createUpdater
      ? this.createUpdater()
      : this.createDefaultUpdater()

    updater.autoDownload = true
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.logger = this.logger
    if (this.platform === 'win32') {
      // 固定安装器目标为当前程序安装目录（而非用户数据目录）：
      // 不依赖注册表 InstallLocation，避免卸载旧目录却装到默认目录的分叉。
      // NSIS /D= 不允许尾随反斜杠且不接受带引号的含空格路径：含空格时优先转为 8.3 短路径，
      // 无法消除空格时跳过 /D=，退回 NSIS 读取注册表 InstallLocation，避免传出被静默忽略的引号参数。
      const pinnedDir = this.installDir.replace(/[\\/]+$/, '')
      if (/\s/.test(pinnedDir)) {
        const shortPath = this.resolveShortPath(pinnedDir)
        if (shortPath && !/\s/.test(shortPath)) {
          updater.installDirectory = shortPath
          this.logger.info('[Updater] Install directory pinned via 8.3 short path:', shortPath)
        } else {
          this.logger.warn(
            '[Updater] Skipping NSIS /D= because install directory contains spaces and has no 8.3 short path:',
            pinnedDir
          )
        }
      } else {
        updater.installDirectory = pinnedDir
        this.logger.info('[Updater] Install directory pinned:', pinnedDir)
      }
    }
    this.attachEvents(updater)
    this.updater = updater
    return updater
  }

  private createDefaultUpdater(): UpdaterLike {
    const adapter: AppAdapterLike = {
      version: this.currentVersion,
      name: app.getName(),
      isPackaged: this.supported,
      // 打包后 app-update.yml 由 electron-builder 生成
      appUpdateConfigPath: path.join(this.resourcesPath, 'app-update.yml'),
      userDataPath: app.getPath('userData'),
      // Windows 使用安装目录之外的专用缓存：安装器不能从 $INSTDIR 内启动，
      // 否则会被卸载器的按路径进程检测误杀。
      baseCachePath: this.cacheBase,
      whenReady: () => app.whenReady(),
      relaunch: () => app.relaunch(),
      quit: () => app.quit(),
      onQuit: (handler) => {
        app.once('quit', () => handler(0))
      },
    }

    // 必须复用 electron-updater 的单例：用 `new NsisUpdater(options, adapter)`
    // 构造时，electron-updater 会把内置 HTTP 执行器置空，检查更新会直接失败。
    // 单例已按平台选择好 updater 类型，这里只替换 app 适配器以改缓存目录。
    const autoUpdater = electronUpdater.autoUpdater
    ;(autoUpdater as unknown as { app: AppAdapterLike }).app = adapter
    this.logger.info('[Updater] Update cache base:', adapter.baseCachePath)
    return autoUpdater as unknown as UpdaterLike
  }

  private attachEvents(updater: UpdaterLike): void {
    updater.on('checking-for-update', () => {
      this.setState({ status: 'checking' })
    })

    updater.on('update-available', (info: UpdateInfoLike) => {
      this.logger.info('[Updater] Update available:', info?.version)
      this.setState({
        status: 'available',
        version: info?.version,
        releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
        checkedAt: Date.now(),
      })
    })

    updater.on('update-not-available', (info: UpdateInfoLike) => {
      this.logger.info('[Updater] No update available')
      this.clearStaleCache()
      this.setState({
        status: 'not-available',
        version: info?.version,
        checkedAt: Date.now(),
      })
    })

    updater.on('download-progress', (progress: DownloadProgressLike) => {
      this.setState({
        status: 'downloading',
        percent: Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0))),
      })
    })

    updater.on('update-downloaded', (info: UpdateInfoLike) => {
      this.logger.info('[Updater] Update downloaded:', info?.version)
      this.setState({
        status: 'downloaded',
        version: info?.version ?? this.state.version,
        percent: 100,
      })
    })

    updater.on('error', (error: unknown) => {
      const message = classifyUpdateError(errorMessage(error))
      this.logger.error('[Updater] Updater error:', message)
      this.setState({ status: 'error', message })
    })
  }

  /** 没有可用更新时，旧的待安装包已经过期，删掉以释放空间（保留差分基准） */
  private clearStaleCache(): void {
    const cacheDir = path.join(this.cacheBase, this.publishTarget.updaterCacheDirName)
    try {
      if (this.platform === 'win32') {
        pruneUpdaterCacheDir(cacheDir)
      } else {
        fs.rmSync(cacheDir, { recursive: true, force: true })
      }
    } catch (error) {
      this.logger.warn('[Updater] Failed to clear stale update cache:', errorMessage(error))
    }
  }

  private setState(next: Partial<UpdateState> & { status: UpdateStatusKind }): void {
    this.state = { ...this.state, ...next }
    this.emit(this.state)
  }

  private releasePageUrl(): string {
    return `https://github.com/${this.publishTarget.owner}/${this.publishTarget.repo}/releases/latest`
  }
}
