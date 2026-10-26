/**
 * 自动更新控制器。
 *
 * 只处理打包版本：
 * - Windows / Linux 使用 electron-updater：检查后自动下载，但绝不自动安装
 * - macOS 未签名，只能检查版本并引导用户前往 GitHub Release 手动下载
 *
 * Windows 的安装包缓存放在 `%LOCALAPPDATA%\Pi-Workbench-Update`（安装目录之外）：
 * electron-builder 的卸载器会按 `$INSTDIR` 路径前缀结束进程，安装器若从安装目录内
 * 启动会被自己当成应用杀掉。安装完成后由安装器写入 `...Update.flag`，新版本启动时
 * 依据标记清空外部缓存。Linux / macOS 保持 `{appDir}/cache`。
 */
import { app, net, shell } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
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

interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  /** Windows NSIS 安装目录；设置后 electron-updater 会传 `/D=` */
  installDirectory?: string
  logger: UpdateLogger
  on: (event: string, listener: (...args: any[]) => void) => unknown
  checkForUpdates: () => Promise<{
    isUpdateAvailable?: boolean
    updateInfo?: UpdateInfoLike
    downloadPromise?: Promise<unknown> | null
  } | null>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void
}

export interface UpdateControllerOptions {
  appDir: string
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
  /** 测试用：覆盖 %LOCALAPPDATA% */
  localAppData?: string
}

export const UPDATE_ERROR = {
  notPackaged: 'ERR_UPDATE_NOT_PACKAGED',
  manualDownload: 'ERR_UPDATE_MANUAL',
  notDownloaded: 'ERR_UPDATE_NOT_DOWNLOADED',
  noRelease: 'ERR_UPDATE_NO_RELEASE',
  network: 'ERR_UPDATE_NETWORK',
  rateLimit: 'ERR_UPDATE_RATE_LIMIT',
} as const

const DEFAULT_PUBLISH_TARGET: PublishTarget = {
  owner: 'T-Chen-CN',
  repo: 'pi-workbench',
  updaterCacheDirName: 'pi-workbench-updater',
}

/** Windows 外部更新缓存目录名（位于 %LOCALAPPDATA% 下） */
export const EXTERNAL_UPDATE_CACHE_DIR = 'Pi-Workbench-Update'

/**
 * electron-updater 的缓存基目录。
 * Windows 必须在安装目录之外：electron-builder 的卸载器按 `$INSTDIR` 路径前缀
 * 结束进程，安装器若从安装目录内启动会被误杀。
 */
export function resolveUpdaterCacheBase(options: {
  appDir: string
  platform: NodeJS.Platform
  localAppData?: string
}): string {
  if (options.platform !== 'win32') return path.join(options.appDir, 'cache')
  const base =
    options.localAppData ??
    process.env.LOCALAPPDATA ??
    path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, EXTERNAL_UPDATE_CACHE_DIR)
}

export interface UpdateCacheCleanupOptions {
  appDir: string
  platform: NodeJS.Platform
  localAppData?: string
  /** 旧版本使用的缓存子目录名（默认 pi-workbench-updater） */
  legacyCacheDirName?: string
  logger?: UpdateLogger
  retries?: number
  delayMs?: number
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 安装完成后的缓存清理。
 *
 * 安装器在安装完成后写入 `<cacheBase>.flag`；应用启动看到标记就删除整个外部缓存
 * 目录（连同目录本身）。安装器可能仍在退出、文件暂时被占用，因此带重试；失败时
 * 保留标记，下次启动继续清理。
 *
 * 同时清理旧版本遗留在安装目录内的更新缓存（Windows 迁移到外部缓存后不再使用）。
 */
export async function cleanupCompletedUpdateCache(
  options: UpdateCacheCleanupOptions
): Promise<boolean> {
  const logger = options.logger ?? console
  const cacheBase = resolveUpdaterCacheBase(options)
  const flagPath = `${cacheBase}.flag`
  const legacyDirName = options.legacyCacheDirName ?? DEFAULT_PUBLISH_TARGET.updaterCacheDirName
  const retries = Math.max(1, options.retries ?? 5)
  const delayMs = Math.max(0, options.delayMs ?? 500)

  let pending = false
  try {
    pending = fs.existsSync(flagPath)
  } catch {
    pending = false
  }

  if (pending) {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        fs.rmSync(cacheBase, { recursive: true, force: true })
        fs.rmSync(flagPath, { force: true })
        logger.info('[Updater] Cleared external update cache:', cacheBase)
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

  if (cacheBase !== path.join(options.appDir, 'cache')) {
    try {
      fs.rmSync(path.join(options.appDir, 'cache', legacyDirName), {
        recursive: true,
        force: true,
      })
    } catch (error) {
      logger.warn('[Updater] Failed to clear legacy update cache:', errorMessage(error))
    }
  }

  return !pending
}

/** 把 `1.2.3` / `v1.2.3` / `1.2.3-beta.1` 解析成数字三元组 */
export function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate)
  const now = parseVersion(current)
  if (!next || !now) return false
  for (let index = 0; index < 3; index += 1) {
    if (next[index] > now[index]) return true
    if (next[index] < now[index]) return false
  }
  return false
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
  private readonly cacheBase: string

  private state: UpdateState
  private updater: UpdaterLike | null = null
  private checkPromise: Promise<UpdateCheckResult> | null = null
  private downloadPromise: Promise<UpdateActionResult> | null = null

  constructor(options: UpdateControllerOptions) {
    this.appDir = options.appDir
    this.emit = options.emit
    this.currentVersion = options.currentVersion ?? app.getVersion()
    this.platform = options.platform ?? process.platform
    this.supported = options.supported ?? app.isPackaged
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath
    this.logger = options.logger ?? console
    this.openExternal = options.openExternal ?? ((url) => shell.openExternal(url))
    this.publishTarget = options.publishTarget ?? readPublishTarget(this.resourcesPath)
    this.createUpdater = options.createUpdater ?? null
    this.cacheBase = resolveUpdaterCacheBase({
      appDir: this.appDir,
      platform: this.platform,
      localAppData: options.localAppData,
    })
    this.fetchRelease =
      options.fetchRelease ??
      (() => this.fetchLatestGithubRelease())

    this.state = {
      status: this.supported ? 'idle' : 'unsupported',
      currentVersion: this.currentVersion,
      platform: this.platform,
      canAutoInstall: this.supported && this.platform !== 'darwin',
      downloadUrl: this.releasePageUrl(),
    }
  }

  getState(): UpdateState {
    return this.state
  }

  /** 检查更新。Windows / Linux 会在发现新版本后自动下载（autoDownload=true）。 */
  async check(): Promise<UpdateCheckResult> {
    if (!this.supported) {
      return { success: false, state: this.state, error: UPDATE_ERROR.notPackaged }
    }
    // 正在下载时重复检查会打断进度事件，直接返回当前状态
    if (this.state.status === 'downloading') {
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
    if (this.platform === 'darwin') {
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
    if (this.platform === 'darwin') {
      return { success: false, error: UPDATE_ERROR.manualDownload }
    }
    if (this.state.status !== 'downloaded') {
      return { success: false, error: UPDATE_ERROR.notDownloaded }
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

  /** macOS：打开 GitHub Release 页面手动下载 */
  async openDownloadPage(): Promise<UpdateActionResult> {
    try {
      await this.openExternal(this.state.downloadUrl ?? this.releasePageUrl())
      return { success: true }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  }

  private async runCheck(): Promise<UpdateCheckResult> {
    this.setState({ status: 'checking', message: undefined })
    try {
      const result =
        this.platform === 'darwin' ? await this.checkGithubRelease() : await this.checkUpdater()
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
        downloadUrl: release.html_url ?? this.releasePageUrl(),
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
      const response = await net.fetch(url, {
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
      // 固定安装器目标为当前应用目录：不依赖注册表 InstallLocation，
      // 避免卸载旧目录、却把新版装到默认目录的分叉。
      updater.installDirectory = this.appDir
      this.logger.info('[Updater] Install directory pinned:', this.appDir)
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

  /** 没有可用更新时，旧的待安装包已经过期，删掉以释放空间 */
  private clearStaleCache(): void {
    const cacheDir = path.join(this.cacheBase, this.publishTarget.updaterCacheDirName)
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true })
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
