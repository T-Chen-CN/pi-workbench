/**
 * 工作台插件系统。
 *
 * 插件只扩展 Pi Workbench 本身（命令 / 钩子），不接入 Pi Agent 的扩展机制。
 * 插件位于 {workspace}/.pi-workbench/plugins/<id>/，由 plugin.json 声明，
 * 入口为 CommonJS 模块并导出 activate(api)。插件运行在主进程，无沙箱。
 */
import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import chokidar, { type FSWatcher as ChokidarFSWatcher } from 'chokidar'
import { readJsonWithBackup, writeJsonAtomicSync } from './atomic-json.js'

export interface PluginManifest {
  id?: string
  name?: string
  version?: string
  description?: string
  main?: string
  contributes?: {
    commands?: Array<{ id: string; title?: string; description?: string }>
  }
}

export interface PluginCommandResult {
  success: boolean
  message?: string
  output?: string
  error?: string
}

export type PluginCommandHandler = (
  args?: unknown
) => PluginCommandResult | Promise<PluginCommandResult>

export type PluginHookHandler = (payload: unknown) => void | Promise<void>

export interface PluginCommandInfo {
  id: string
  title: string
  description?: string
  pluginId: string
  pluginName: string
}

export interface PluginInfo {
  id: string
  name: string
  version?: string
  description?: string
  enabled: boolean
  commands: PluginCommandInfo[]
  error?: string
}

export interface PluginApi {
  workspaceDir: string
  pluginDir: string
  pluginId: string
  registerCommand: (id: string, handler: PluginCommandHandler) => void
  on: (event: string, handler: PluginHookHandler) => void
  log: (...args: unknown[]) => void
}

interface LoadedPlugin {
  info: PluginInfo
  directory: string
  entryPath?: string
  handlers: Map<string, PluginCommandHandler>
  hooks: Map<string, PluginHookHandler[]>
  deactivate?: () => void | Promise<void>
}

interface WorkspacePlugins {
  workspaceDir: string
  plugins: LoadedPlugin[]
  commands: Map<string, { plugin: LoadedPlugin; handler: PluginCommandHandler; info: PluginCommandInfo }>
  watcher: ChokidarFSWatcher | null
  reloadTimer: NodeJS.Timeout | null
}

export interface PluginManagerOptions {
  /** 替换模块加载器（测试用） */
  requireModule?: (entryPath: string) => unknown
  /** 是否监听插件目录变化（默认 true） */
  watch?: boolean
  debounceMs?: number
  onChanged?: (workspaceDir: string) => void
  /** 插件启用白名单文件（必须位于应用自有目录，绝不能读工作区内的不可信配置） */
  stateFilePath?: string
}

const requireFromHere = createRequire(import.meta.url)

/** 清理插件目录及其所有子模块的 require.cache，避免热重载残留旧闭包 */
function purgePluginRequireCache(pluginRoot: string, entryPath: string): void {
  const normalizedRoot = process.platform === 'win32' ? pluginRoot.toLowerCase() : pluginRoot
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`
  for (const key of Object.keys(requireFromHere.cache)) {
    const normalizedKey = process.platform === 'win32' ? key.toLowerCase() : key
    if (normalizedKey === normalizedRoot || normalizedKey.startsWith(prefix)) {
      delete requireFromHere.cache[key]
    }
  }
  try {
    const resolved = requireFromHere.resolve(entryPath)
    delete requireFromHere.cache[resolved]
  } catch {
    // ignore
  }
}

/**
 * 计算插件目录内全部常规文件的确定性 SHA-256 哈希（覆盖 node_modules、原生 .node/.wasm、脚本与清单，仅跳过 .git）。
 * 发现任何符号链接立即抛错（fail-closed），阻止借软链逃逸或静默篡改代码绕过哈希钉住。
 */
export function computePluginDirectoryHash(directory: string): string {
  const rootStat = fs.lstatSync(directory)
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Plugin directory must not contain symbolic links: ${directory}`)
  }
  const hash = createHash('sha256')
  const files: string[] = []

  const walk = (dir: string, relBase: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        throw new Error(`Plugin directory must not contain symbolic links: ${rel}`)
      }
      if (entry.isDirectory()) {
        walk(full, rel)
      } else if (entry.isFile()) {
        files.push(rel)
      }
    }
  }

  walk(directory, '')
  files.sort()
  for (const rel of files) {
    hash.update(`file:${rel}\0`)
    hash.update(fs.readFileSync(path.join(directory, rel)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function defaultRequire(entryPath: string, pluginRoot?: string): unknown {
  if (pluginRoot) purgePluginRequireCache(pluginRoot, entryPath)
  const resolved = requireFromHere.resolve(entryPath)
  delete requireFromHere.cache[resolved]
  return requireFromHere(resolved)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PluginManager {
  private readonly options: PluginManagerOptions
  private readonly workspaces = new Map<string, WorkspacePlugins>()

  constructor(options: PluginManagerOptions = {}) {
    this.options = options
  }

  private mapKey(workspaceDir: string): string {
    const resolved = path.resolve(workspaceDir)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  /** 加载（或重新加载）某个工作区的插件 */
  loadWorkspace(workspaceDir: string): PluginInfo[] {
    this.unload(workspaceDir)

    const pluginsDir = path.join(workspaceDir, '.pi-workbench', 'plugins')
    const state: WorkspacePlugins = {
      workspaceDir,
      plugins: [],
      commands: new Map(),
      watcher: null,
      reloadTimer: null,
    }
    this.workspaces.set(this.mapKey(workspaceDir), state)

    try {
      fs.mkdirSync(pluginsDir, { recursive: true })
    } catch (error) {
      console.warn('[Plugins] Failed to create plugins directory:', error)
    }

    const enabledIds = this.readEnabledIds(workspaceDir)
    const pinnedHashes = this.readPinnedHashes(workspaceDir)
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch (error) {
      console.warn('[Plugins] Failed to read plugins directory:', error)
    }

    const seenIds = new Set<string>()
    const revokedIds = new Set<string>()
    for (const entry of entries) {
      const directory = path.join(pluginsDir, entry.name)
      const plugin = this.loadPlugin(
        directory,
        entry.name,
        enabledIds,
        pinnedHashes,
        workspaceDir,
        seenIds,
        revokedIds
      )
      state.plugins.push(plugin)
    }

    // 哈希缺失/变化或含符号链接时撤销持久化启用授权，强制要求用户显式重新启用
    if (revokedIds.size > 0 && enabledIds) {
      const remainingEnabled = enabledIds.filter((id) => !revokedIds.has(id))
      const remainingHashes = { ...pinnedHashes }
      for (const id of revokedIds) delete remainingHashes[id]
      this.writeEnabledIds(workspaceDir, remainingEnabled, remainingHashes)
    }

    this.rebuildCommandIndex(state)
    this.startWatcher(workspaceDir, pluginsDir, state)
    return this.listWorkspace(state)
  }

  /** 当前工作区的插件信息 */
  list(workspaceDir: string): PluginInfo[] {
    const state = this.workspaces.get(this.mapKey(workspaceDir))
    if (!state) {
      return this.loadWorkspace(workspaceDir)
    }
    return this.listWorkspace(state)
  }

  loadedWorkspaces(): string[] {
    return [...this.workspaces.values()].map((state) => state.workspaceDir)
  }

  async invoke(
    workspaceDir: string,
    commandId: string,
    args?: unknown
  ): Promise<PluginCommandResult> {
    const state = this.workspaces.get(this.mapKey(workspaceDir))
    const command = state?.commands.get(commandId)
    if (!command) {
      return { success: false, error: `Unknown command: ${commandId}` }
    }

    try {
      const result = await command.handler(args)
      return { ...result, success: result.success !== false }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  }

  /** 向插件派发钩子事件 */
  async emit(workspaceDir: string, event: string, payload: unknown): Promise<void> {
    const state = this.workspaces.get(this.mapKey(workspaceDir))
    if (!state) return

    for (const plugin of state.plugins) {
      const handlers = plugin.hooks.get(event)
      if (!handlers) continue
      for (const handler of handlers) {
        try {
          await handler(payload)
        } catch (error) {
          console.warn(`[Plugins] Hook "${event}" failed in ${plugin.info.id}:`, error)
        }
      }
    }
  }

  /** 启用/禁用插件并持久化到工作区配置（启用时钉住当前代码哈希，防止后续仓库更新/Agent 篡改被热重载静默执行） */
  setEnabled(workspaceDir: string, pluginId: string, enabled: boolean): PluginInfo[] {
    const current = this.readEnabledIds(workspaceDir)
    // 未配置时默认全部禁用：启用一个插件只把它自己写进白名单
    const base = current ?? []

    const enabledPlugins = enabled
      ? [...new Set([...base, pluginId])]
      : base.filter((id) => id !== pluginId)

    const hashes = { ...this.readPinnedHashes(workspaceDir) }
    if (enabled) {
      const pluginDir = this.findPluginDirectory(workspaceDir, pluginId)
      if (pluginDir) {
        hashes[pluginId] = computePluginDirectoryHash(pluginDir)
      } else {
        delete hashes[pluginId]
      }
    } else {
      delete hashes[pluginId]
    }

    this.writeEnabledIds(workspaceDir, enabledPlugins, hashes)
    return this.loadWorkspace(workspaceDir)
  }

  private findPluginDirectory(workspaceDir: string, pluginId: string): string | null {
    const pluginsDir = path.join(workspaceDir, '.pi-workbench', 'plugins')
    try {
      for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const directory = path.join(pluginsDir, entry.name)
        try {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(directory, 'plugin.json'), 'utf-8')
          ) as PluginManifest
          const id = typeof manifest.id === 'string' && manifest.id ? manifest.id : entry.name
          if (id === pluginId) return directory
        } catch {
          if (entry.name === pluginId) return directory
        }
      }
    } catch {
      // ignore
    }
    return null
  }

  /** 该工作区是否已经有显式的插件启用列表（用于首次启用时的风险提示） */
  hasExplicitEnableList(workspaceDir: string): boolean {
    return this.readEnabledIds(workspaceDir) !== null
  }

  reload(workspaceDir: string): PluginInfo[] {
    return this.loadWorkspace(workspaceDir)
  }

  unload(workspaceDir: string): void {
    const pending = this.unloadInternal(workspaceDir)
    if (pending.length > 0) {
      void Promise.allSettled(pending)
    }
  }

  /** 异步卸载：等待插件的异步 deactivate() 收尾完成 */
  async unloadAsync(workspaceDir: string): Promise<void> {
    const pending = this.unloadInternal(workspaceDir)
    if (pending.length > 0) {
      await Promise.allSettled(pending)
    }
  }

  private unloadInternal(workspaceDir: string): Array<Promise<unknown>> {
    const key = this.mapKey(workspaceDir)
    const state = this.workspaces.get(key)
    if (!state) return []

    if (state.reloadTimer) {
      clearTimeout(state.reloadTimer)
      state.reloadTimer = null
    }
    const pending: Array<Promise<unknown>> = []
    if (state.watcher) {
      const closing = state.watcher.close().catch(() => {})
      state.watcher = null
      pending.push(closing)
    }

    for (const plugin of state.plugins) {
      try {
        const res = plugin.deactivate?.()
        if (res && typeof (res as Promise<unknown>).then === 'function') {
          pending.push(
            Promise.resolve(res).catch((error) => {
              console.warn(`[Plugins] deactivate failed for ${plugin.info.id}:`, error)
            })
          )
        }
      } catch (error) {
        console.warn(`[Plugins] deactivate failed for ${plugin.info.id}:`, error)
      }
      if (plugin.entryPath) {
        purgePluginRequireCache(plugin.directory, plugin.entryPath)
      }
    }

    this.workspaces.delete(key)
    return pending
  }

  disposeAll(): void {
    for (const state of [...this.workspaces.values()]) {
      this.unload(state.workspaceDir)
    }
  }

  async disposeAllAsync(): Promise<void> {
    await Promise.allSettled(
      [...this.workspaces.values()].map((state) => this.unloadAsync(state.workspaceDir))
    )
  }

  private loadPlugin(
    directory: string,
    fallbackId: string,
    enabledIds: string[] | null,
    pinnedHashes: Record<string, string>,
    workspaceDir: string,
    seenIds: Set<string>,
    revokedIds: Set<string>
  ): LoadedPlugin {
    const manifestPath = path.join(directory, 'plugin.json')
    let manifest: PluginManifest = {}

    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest
    } catch (error) {
      return {
        info: {
          id: fallbackId,
          name: fallbackId,
          enabled: false,
          commands: [],
          error: `Invalid plugin.json: ${errorMessage(error)}`,
        },
        directory,
        handlers: new Map(),
        hooks: new Map(),
      }
    }

    const id = typeof manifest.id === 'string' && manifest.id ? manifest.id : fallbackId
    const enabled = this.isEnabled(id, enabledIds)
    const plugin: LoadedPlugin = {
      info: {
        id,
        name: typeof manifest.name === 'string' && manifest.name ? manifest.name : id,
        version: manifest.version,
        description: manifest.description,
        enabled,
        commands: [],
      },
      directory,
      handlers: new Map(),
      hooks: new Map(),
    }

    // 重复 id 只允许第一个插件激活，避免命令索引被静默覆盖
    if (seenIds.has(id)) {
      plugin.info.enabled = false
      plugin.info.error = `Duplicate plugin id: ${id}`
      console.warn(`[Plugins] Duplicate plugin id "${id}" in ${directory}; ignored`)
      return plugin
    }
    seenIds.add(id)

    if (!enabled) return plugin

    // 代码哈希钉住校验（fail-closed）：缺少哈希、目录含符号链接或内容变更一律拒绝执行并撤销授权，需用户显式重新启用
    const expectedHash = pinnedHashes[id]
    if (!expectedHash) {
      plugin.info.enabled = false
      plugin.info.error =
        'Plugin code hash is missing; re-enable the plugin to approve and pin its current code.'
      revokedIds.add(id)
      console.warn(`[Plugins] Missing pinned hash for "${id}" in ${directory}; refusing auto-activation`)
      return plugin
    }

    let actualHash: string
    try {
      actualHash = computePluginDirectoryHash(directory)
    } catch (error) {
      plugin.info.enabled = false
      plugin.info.error = errorMessage(error)
      revokedIds.add(id)
      console.warn(`[Plugins] Failed to verify plugin hash for "${id}" in ${directory}:`, error)
      return plugin
    }

    if (actualHash !== expectedHash) {
      plugin.info.enabled = false
      plugin.info.error =
        'Plugin files changed since approval; re-enable the plugin to trust the updated code.'
      revokedIds.add(id)
      console.warn(
        `[Plugins] Hash mismatch for "${id}" in ${directory}; disabled pending explicit re-enable`
      )
      return plugin
    }

    try {
      this.activatePlugin(plugin, manifest, directory, workspaceDir)
    } catch (error) {
      plugin.info.error = errorMessage(error)
      console.warn(`[Plugins] Failed to activate ${id}:`, error)
    }

    return plugin
  }

  private activatePlugin(
    plugin: LoadedPlugin,
    manifest: PluginManifest,
    directory: string,
    workspaceDir: string
  ): void {
    const mainFile = typeof manifest.main === 'string' && manifest.main ? manifest.main : 'index.js'
    const root = path.resolve(directory)
    const entryCandidate = path.resolve(root, mainFile)

    if (entryCandidate !== root && !entryCandidate.startsWith(root + path.sep)) {
      throw new Error('Plugin "main" must stay inside its own directory')
    }
    if (!fs.existsSync(entryCandidate)) {
      throw new Error(`Plugin entry not found: ${mainFile}`)
    }

    // 词法检查挡不住指向目录外的符号链接，入口必须用 realpath 再校验一次
    const realRoot = fs.realpathSync.native(root)
    const entryPath = fs.realpathSync.native(entryCandidate)
    if (entryPath !== realRoot && !entryPath.startsWith(realRoot + path.sep)) {
      throw new Error('Plugin entry must stay inside its own directory')
    }

    const moduleExports = (
      this.options.requireModule
        ? this.options.requireModule(entryPath)
        : defaultRequire(entryPath, realRoot)
    ) as {
      activate?: (api: PluginApi) => void
      deactivate?: () => void | Promise<void>
    }

    if (!moduleExports || typeof moduleExports.activate !== 'function') {
      throw new Error('Plugin must export an activate(api) function')
    }

    plugin.entryPath = entryPath
    plugin.deactivate = moduleExports.deactivate

    const api: PluginApi = {
      workspaceDir,
      pluginDir: directory,
      pluginId: plugin.info.id,
      registerCommand: (id, handler) => {
        plugin.handlers.set(id, handler)
        const declaredCommands = Array.isArray(manifest.contributes?.commands)
          ? manifest.contributes.commands
          : []
        const declared = declaredCommands.find((command) => command?.id === id)
        plugin.info.commands.push({
          id,
          title: declared?.title ?? id,
          description: declared?.description,
          pluginId: plugin.info.id,
          pluginName: plugin.info.name,
        })
      },
      on: (event, handler) => {
        const handlers = plugin.hooks.get(event) ?? []
        handlers.push(handler)
        plugin.hooks.set(event, handlers)
      },
      log: (...args) => {
        console.log(`[Plugin:${plugin.info.id}]`, ...args)
      },
    }

    moduleExports.activate(api)
  }

  private rebuildCommandIndex(state: WorkspacePlugins): void {
    state.commands.clear()
    for (const plugin of state.plugins) {
      if (!plugin.info.enabled || plugin.info.error) continue
      for (const info of plugin.info.commands) {
        const handler = plugin.handlers.get(info.id)
        if (!handler) continue
        if (state.commands.has(info.id)) {
          console.warn(
            `[Plugins] Duplicate command id "${info.id}" from ${plugin.info.id}; keeping the first`
          )
          continue
        }
        state.commands.set(info.id, { plugin, handler, info })
      }
    }
  }

  private listWorkspace(state: WorkspacePlugins): PluginInfo[] {
    return state.plugins.map((plugin) => ({
      ...plugin.info,
      commands: plugin.info.commands.map((command) => ({ ...command })),
    }))
  }

  private readonly memoryEnabled = new Map<string, string[]>()
  private readonly memoryHashes = new Map<string, Record<string, string>>()

  private stateFilePath(): string | null {
    return this.options.stateFilePath ?? null
  }

  private workspaceKey(workspaceDir: string): string {
    let resolved = path.resolve(workspaceDir)
    try {
      resolved = fs.realpathSync.native(resolved)
    } catch {
      // 目录尚未存在时退回 resolve 结果
    }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  private readStateStore(): Record<string, { enabledPlugins?: unknown; pluginHashes?: unknown }> {
    const storePath = this.stateFilePath()
    if (!storePath) return {}
    const result = readJsonWithBackup<Record<string, unknown>>(storePath)
    const raw = result.data
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const workspaces = (raw as { workspaces?: unknown }).workspaces
    if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)) return {}
    return workspaces as Record<string, { enabledPlugins?: unknown; pluginHashes?: unknown }>
  }

  /**
   * 启用白名单必须存放在应用自有配置目录（由主进程注入 stateFilePath），
   * 绝不读取工作区内的 `.pi-workbench/config.json`，否则打开恶意仓库会直接触发主进程 RCE。
   */
  private readEnabledIds(workspaceDir: string): string[] | null {
    const key = this.workspaceKey(workspaceDir)
    if (!this.stateFilePath()) {
      return this.memoryEnabled.get(key) ?? null
    }
    const entry = this.readStateStore()[key]
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.enabledPlugins)) {
      return null
    }
    return entry.enabledPlugins.filter((id): id is string => typeof id === 'string')
  }

  private readPinnedHashes(workspaceDir: string): Record<string, string> {
    const key = this.workspaceKey(workspaceDir)
    if (!this.stateFilePath()) {
      return this.memoryHashes.get(key) ?? {}
    }
    const entry = this.readStateStore()[key]
    if (!entry || typeof entry !== 'object' || !entry.pluginHashes || typeof entry.pluginHashes !== 'object') {
      return {}
    }
    const out: Record<string, string> = {}
    for (const [id, hash] of Object.entries(entry.pluginHashes as Record<string, unknown>)) {
      if (typeof hash === 'string' && hash) out[id] = hash
    }
    return out
  }

  private writeEnabledIds(
    workspaceDir: string,
    ids: string[],
    pluginHashes: Record<string, string>
  ): void {
    const key = this.workspaceKey(workspaceDir)
    const storePath = this.stateFilePath()
    if (!storePath) {
      this.memoryEnabled.set(key, [...ids])
      this.memoryHashes.set(key, { ...pluginHashes })
      return
    }
    const workspaces = this.readStateStore()
    workspaces[key] = { enabledPlugins: ids, pluginHashes }
    writeJsonAtomicSync(storePath, { version: 1, workspaces })
  }

  private isEnabled(id: string, enabledIds: string[] | null): boolean {
    // 默认禁用：插件在主进程拥有完整 Node 权限，不能在打开工作区时自动执行
    return enabledIds !== null && enabledIds.includes(id)
  }

  private snapshotPluginsDir(pluginsDir: string): string {
    const parts: string[] = []
    const walk = (dir: string, relPrefix: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (entry.name === '.git') continue
        const full = path.join(dir, entry.name)
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          walk(full, rel)
        } else if (entry.isFile()) {
          try {
            const st = fs.statSync(full)
            parts.push(`${rel}=${st.mtimeMs}:${st.size}`)
          } catch {
            // ignore transient files
          }
        }
      }
    }
    walk(pluginsDir, '')
    return parts.join('|')
  }

  private startWatcher(
    workspaceDir: string,
    pluginsDir: string,
    state: WorkspacePlugins
  ): void {
    if (this.options.watch === false) return

    try {
      const normalizedRoot = path.resolve(pluginsDir).replace(/\\/g, '/').replace(/\/+$/, '')
      const rootCmp = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
      const ignored = (candidatePath: string): boolean => {
        const normalized = candidatePath.replace(/\\/g, '/').replace(/\/+$/, '')
        const cmp = process.platform === 'win32' ? normalized.toLowerCase() : normalized
        if (cmp === rootCmp) return false
        if (!cmp.startsWith(`${rootCmp}/`)) return false
        const rel = normalized.slice(normalizedRoot.length + 1)
        return /(^|\/)\.git(\/|$)/.test(rel)
      }

      const initialSnapshot = this.snapshotPluginsDir(pluginsDir)
      const scheduleReload = (): void => {
        if (this.workspaces.get(this.mapKey(workspaceDir)) !== state) return
        if (state.reloadTimer) clearTimeout(state.reloadTimer)
        state.reloadTimer = setTimeout(() => {
          state.reloadTimer = null
          if (this.workspaces.get(this.mapKey(workspaceDir)) !== state) return
          this.loadWorkspace(workspaceDir)
          this.options.onChanged?.(workspaceDir)
        }, this.options.debounceMs ?? 500)
      }

      const watcher = chokidar.watch(pluginsDir, {
        ignoreInitial: true,
        ignored,
        persistent: true,
        ignorePermissionErrors: true,
        awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 25 },
      })
      watcher.on('all', scheduleReload)
      watcher.on('ready', () => {
        if (this.workspaces.get(this.mapKey(workspaceDir)) !== state) return
        if (this.snapshotPluginsDir(pluginsDir) !== initialSnapshot) {
          scheduleReload()
        }
      })
      watcher.on('error', (error) => {
        console.warn('[Plugins] Watcher error:', error)
      })
      state.watcher = watcher
    } catch (error) {
      console.warn('[Plugins] Failed to watch plugins directory:', error)
    }
  }
}
