/**
 * 工作台插件系统。
 *
 * 插件只扩展 Pi Workbench 本身（命令 / 钩子），不接入 Pi Agent 的扩展机制。
 * 插件位于 {workspace}/.pi-workbench/plugins/<id>/，由 plugin.json 声明，
 * 入口为 CommonJS 模块并导出 activate(api)。插件运行在主进程，无沙箱。
 */
import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'

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
  plugins: LoadedPlugin[]
  commands: Map<string, { plugin: LoadedPlugin; handler: PluginCommandHandler; info: PluginCommandInfo }>
  watcher: fs.FSWatcher | null
  reloadTimer: NodeJS.Timeout | null
}

export interface PluginManagerOptions {
  /** 替换模块加载器（测试用） */
  requireModule?: (entryPath: string) => unknown
  /** 是否监听插件目录变化（默认 true） */
  watch?: boolean
  debounceMs?: number
  onChanged?: (workspaceDir: string) => void
}

const requireFromHere = createRequire(import.meta.url)

function defaultRequire(entryPath: string): unknown {
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

  /** 加载（或重新加载）某个工作区的插件 */
  loadWorkspace(workspaceDir: string): PluginInfo[] {
    this.unload(workspaceDir)

    const pluginsDir = path.join(workspaceDir, '.pi-workbench', 'plugins')
    const state: WorkspacePlugins = {
      plugins: [],
      commands: new Map(),
      watcher: null,
      reloadTimer: null,
    }
    this.workspaces.set(workspaceDir, state)

    try {
      fs.mkdirSync(pluginsDir, { recursive: true })
    } catch (error) {
      console.warn('[Plugins] Failed to create plugins directory:', error)
    }

    const enabledIds = this.readEnabledIds(workspaceDir)
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch (error) {
      console.warn('[Plugins] Failed to read plugins directory:', error)
    }

    for (const entry of entries) {
      const directory = path.join(pluginsDir, entry.name)
      const plugin = this.loadPlugin(directory, entry.name, enabledIds, workspaceDir)
      state.plugins.push(plugin)
    }

    this.rebuildCommandIndex(state)
    this.startWatcher(workspaceDir, pluginsDir, state)
    return this.listWorkspace(state)
  }

  /** 当前工作区的插件信息 */
  list(workspaceDir: string): PluginInfo[] {
    const state = this.workspaces.get(workspaceDir)
    if (!state) {
      return this.loadWorkspace(workspaceDir)
    }
    return this.listWorkspace(state)
  }

  loadedWorkspaces(): string[] {
    return [...this.workspaces.keys()]
  }

  async invoke(
    workspaceDir: string,
    commandId: string,
    args?: unknown
  ): Promise<PluginCommandResult> {
    const state = this.workspaces.get(workspaceDir)
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
    const state = this.workspaces.get(workspaceDir)
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

  /** 启用/禁用插件并持久化到工作区配置 */
  setEnabled(workspaceDir: string, pluginId: string, enabled: boolean): PluginInfo[] {
    const state = this.workspaces.get(workspaceDir)
    const allIds = state?.plugins.map((plugin) => plugin.info.id) ?? []
    const current = this.readEnabledIds(workspaceDir)
    // null 表示尚未配置，默认全部启用
    const base = current ?? allIds

    const enabledPlugins = enabled
      ? [...new Set([...base, pluginId])]
      : base.filter((id) => id !== pluginId)

    this.writeEnabledIds(workspaceDir, enabledPlugins)
    return this.loadWorkspace(workspaceDir)
  }

  reload(workspaceDir: string): PluginInfo[] {
    return this.loadWorkspace(workspaceDir)
  }

  unload(workspaceDir: string): void {
    const state = this.workspaces.get(workspaceDir)
    if (!state) return

    if (state.reloadTimer) {
      clearTimeout(state.reloadTimer)
      state.reloadTimer = null
    }
    state.watcher?.close()
    state.watcher = null

    for (const plugin of state.plugins) {
      try {
        plugin.deactivate?.()
      } catch (error) {
        console.warn(`[Plugins] deactivate failed for ${plugin.info.id}:`, error)
      }
    }

    this.workspaces.delete(workspaceDir)
  }

  disposeAll(): void {
    for (const workspaceDir of [...this.workspaces.keys()]) {
      this.unload(workspaceDir)
    }
  }

  private loadPlugin(
    directory: string,
    fallbackId: string,
    enabledIds: string[] | null,
    workspaceDir: string
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

    if (!enabled) return plugin

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
    const entryPath = path.resolve(root, mainFile)

    if (entryPath !== root && !entryPath.startsWith(root + path.sep)) {
      throw new Error('Plugin "main" must stay inside its own directory')
    }
    if (!fs.existsSync(entryPath)) {
      throw new Error(`Plugin entry not found: ${mainFile}`)
    }

    const load = this.options.requireModule ?? defaultRequire
    const moduleExports = load(entryPath) as {
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
        const declared = manifest.contributes?.commands?.find((command) => command.id === id)
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
        if (handler) {
          state.commands.set(info.id, { plugin, handler, info })
        }
      }
    }
  }

  private listWorkspace(state: WorkspacePlugins): PluginInfo[] {
    return state.plugins.map((plugin) => ({
      ...plugin.info,
      commands: plugin.info.commands.map((command) => ({ ...command })),
    }))
  }

  private readEnabledIds(workspaceDir: string): string[] | null {
    const configPath = path.join(workspaceDir, '.pi-workbench', 'config.json')
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        enabledPlugins?: unknown
        pluginsConfigured?: unknown
      }
      // 只有用户显式配置过（pluginsConfigured=true）才把列表当作启用白名单；
      // 否则默认全部启用。空数组表示“全部禁用”。
      if (config.pluginsConfigured === true && Array.isArray(config.enabledPlugins)) {
        return config.enabledPlugins.filter((id): id is string => typeof id === 'string')
      }
      return null
    } catch {
      return null
    }
  }

  private writeEnabledIds(workspaceDir: string, ids: string[]): void {
    const configDir = path.join(workspaceDir, '.pi-workbench')
    const configPath = path.join(configDir, 'config.json')
    let config: Record<string, unknown> = {}

    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    } catch {
      config = { version: '1.0', agentConfig: { temperature: 0.7 } }
    }

    config.enabledPlugins = ids
    config.pluginsConfigured = true
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  private isEnabled(id: string, enabledIds: string[] | null): boolean {
    if (enabledIds === null) return true
    return enabledIds.includes(id)
  }

  private startWatcher(
    workspaceDir: string,
    pluginsDir: string,
    state: WorkspacePlugins
  ): void {
    if (this.options.watch === false) return

    try {
      state.watcher = fs.watch(pluginsDir, { recursive: true }, () => {
        if (state.reloadTimer) clearTimeout(state.reloadTimer)
        state.reloadTimer = setTimeout(() => {
          state.reloadTimer = null
          this.loadWorkspace(workspaceDir)
          this.options.onChanged?.(workspaceDir)
        }, this.options.debounceMs ?? 500)
      })
      state.watcher.on('error', (error) => {
        console.warn('[Plugins] Watcher error:', error)
      })
    } catch (error) {
      console.warn('[Plugins] Failed to watch plugins directory:', error)
    }
  }
}
