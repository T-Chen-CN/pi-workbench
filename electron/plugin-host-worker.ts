/**
 * 工作台插件 utilityProcess 宿主入口（纯 Node / Electron `process.parentPort`，严禁引入 `electron`）。
 *
 * 仅加载由主进程完成清单扫描、白名单校验与全目录 SHA-256 哈希验证的插件入口，
 * 通过受控 `PluginApi` 向插件暴露命令注册、钩子订阅与日志回传，
 * 避免插件异常或崩溃直接拖垮 Electron 主进程或 Agent 进程。
 */

import * as path from 'path'
import { createRequire } from 'module'
import {
  serializeLogArgs,
  type ParentPortLike,
  type ParentPortMessageEvent,
} from './agent-host-protocol.js'

export interface VerifiedPluginDescriptor {
  id: string
  name: string
  directory: string
  entryPath: string
  declaredCommands: Array<{ id: string; title?: string; description?: string }>
}

export interface PluginWorkerCommandInfo {
  id: string
  title: string
  description?: string
  pluginId: string
  pluginName: string
}

export interface PluginWorkerCommandResult {
  success: boolean
  message?: string
  output?: string
  error?: string
}

export interface PluginWorkerActivationEntry {
  id: string
  commands: PluginWorkerCommandInfo[]
  error?: string
}

export interface PluginWorkerLoadResult {
  plugins: PluginWorkerActivationEntry[]
}

export type PluginWorkerRpcMethod = 'load-plugins' | 'invoke-command' | 'emit-hook' | 'dispose'

export type MainToPluginWorkerMessage = {
  type: 'rpc:req'
  id: number
  method: PluginWorkerRpcMethod
  payload: unknown
}

export type PluginWorkerToMainMessage =
  | { type: 'ready' }
  | {
      type: 'rpc:res'
      id: number
      ok: boolean
      result?: unknown
      error?: string
    }
  | {
      type: 'log'
      level: 'info' | 'warn'
      pluginId: string
      args: unknown[]
    }

type PluginCommandHandler = (
  args?: unknown
) => PluginWorkerCommandResult | Promise<PluginWorkerCommandResult>

type PluginHookHandler = (payload: unknown) => void | Promise<void>

interface WorkerPluginApi {
  workspaceDir: string
  pluginDir: string
  pluginId: string
  registerCommand: (id: string, handler: PluginCommandHandler) => void
  on: (event: string, handler: PluginHookHandler) => void
  log: (...args: unknown[]) => void
}

interface WorkerLoadedPlugin {
  id: string
  name: string
  directory: string
  entryPath: string
  commands: PluginWorkerCommandInfo[]
  handlers: Map<string, PluginCommandHandler>
  hooks: Map<string, PluginHookHandler[]>
  deactivate?: () => void | Promise<void>
  error?: string
}

export interface PluginHostWorkerDeps {
  requireModule?: (entryPath: string) => unknown
}

export interface PluginHostWorkerHandle {
  detach: () => void
}

const requireFromWorker = createRequire(import.meta.url)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function purgePluginRequireCache(pluginRoot: string, entryPath: string): void {
  const normalizedRoot = process.platform === 'win32' ? pluginRoot.toLowerCase() : pluginRoot
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`
  for (const key of Object.keys(requireFromWorker.cache)) {
    const normalizedKey = process.platform === 'win32' ? key.toLowerCase() : key
    if (normalizedKey === normalizedRoot || normalizedKey.startsWith(prefix)) {
      delete requireFromWorker.cache[key]
    }
  }
  try {
    const resolved = requireFromWorker.resolve(entryPath)
    delete requireFromWorker.cache[resolved]
  } catch {
    // ignore
  }
}

function defaultWorkerRequire(entryPath: string, pluginRoot: string): unknown {
  purgePluginRequireCache(pluginRoot, entryPath)
  const resolved = requireFromWorker.resolve(entryPath)
  delete requireFromWorker.cache[resolved]
  return requireFromWorker(resolved)
}

export function attachPluginHostWorker(
  port: ParentPortLike,
  deps: PluginHostWorkerDeps = {}
): PluginHostWorkerHandle {
  let loadedPlugins: WorkerLoadedPlugin[] = []
  const commandIndex = new Map<string, PluginCommandHandler>()

  const post = (message: PluginWorkerToMainMessage): void => {
    try {
      port.postMessage(message)
    } catch {
      // 父进程通道已关闭
    }
  }

  const emitLog = (level: 'info' | 'warn', pluginId: string, args: readonly unknown[]): void => {
    post({
      type: 'log',
      level,
      pluginId,
      args: serializeLogArgs(args),
    })
  }

  const deactivateAll = async (): Promise<void> => {
    const previous = loadedPlugins
    loadedPlugins = []
    commandIndex.clear()
    for (const plugin of previous) {
      try {
        await plugin.deactivate?.()
      } catch (error) {
        emitLog('warn', plugin.id, [`deactivate failed: ${errorMessage(error)}`])
      }
      if (!deps.requireModule) {
        purgePluginRequireCache(plugin.directory, plugin.entryPath)
      }
    }
  }

  const handleLoadPlugins = async (payload: {
    workspaceDir: string
    plugins: VerifiedPluginDescriptor[]
  }): Promise<PluginWorkerLoadResult> => {
    await deactivateAll()
    const entries: PluginWorkerActivationEntry[] = []

    for (const descriptor of payload.plugins) {
      const plugin: WorkerLoadedPlugin = {
        id: descriptor.id,
        name: descriptor.name,
        directory: descriptor.directory,
        entryPath: descriptor.entryPath,
        commands: [],
        handlers: new Map(),
        hooks: new Map(),
      }
      loadedPlugins.push(plugin)

      try {
        const mod = (
          deps.requireModule
            ? deps.requireModule(descriptor.entryPath)
            : defaultWorkerRequire(descriptor.entryPath, descriptor.directory)
        ) as {
          activate?: (api: WorkerPluginApi) => void
          deactivate?: () => void | Promise<void>
        }

        if (!mod || typeof mod.activate !== 'function') {
          throw new Error('Plugin must export an activate(api) function')
        }

        plugin.deactivate = mod.deactivate
        const api: WorkerPluginApi = {
          workspaceDir: payload.workspaceDir,
          pluginDir: descriptor.directory,
          pluginId: descriptor.id,
          registerCommand: (id, handler) => {
            plugin.handlers.set(id, handler)
            const declared = descriptor.declaredCommands.find((cmd) => cmd.id === id)
            plugin.commands.push({
              id,
              title: declared?.title ?? id,
              ...(declared?.description !== undefined ? { description: declared.description } : {}),
              pluginId: descriptor.id,
              pluginName: descriptor.name,
            })
          },
          on: (event, handler) => {
            const list = plugin.hooks.get(event) ?? []
            list.push(handler)
            plugin.hooks.set(event, list)
          },
          log: (...args: unknown[]) => {
            emitLog('info', descriptor.id, args)
          },
        }

        mod.activate(api)

        for (const cmd of plugin.commands) {
          const handler = plugin.handlers.get(cmd.id)
          if (!handler) continue
          if (commandIndex.has(cmd.id)) {
            emitLog('warn', descriptor.id, [
              `Duplicate command id "${cmd.id}"; keeping the first registration`,
            ])
            continue
          }
          commandIndex.set(cmd.id, handler)
        }

        entries.push({ id: descriptor.id, commands: plugin.commands })
      } catch (error) {
        plugin.error = errorMessage(error)
        plugin.commands = []
        plugin.handlers.clear()
        plugin.hooks.clear()
        entries.push({ id: descriptor.id, commands: [], error: plugin.error })
      }
    }

    return { plugins: entries }
  }

  const handleInvokeCommand = async (payload: {
    commandId: string
    args?: unknown
  }): Promise<PluginWorkerCommandResult> => {
    const handler = commandIndex.get(payload.commandId)
    if (!handler) {
      return { success: false, error: `Unknown command: ${payload.commandId}` }
    }
    try {
      const result = await handler(payload.args)
      return { ...result, success: result.success !== false }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  }

  const handleEmitHook = async (payload: {
    event: string
    payload: unknown
  }): Promise<{ ok: true }> => {
    for (const plugin of loadedPlugins) {
      if (plugin.error) continue
      const handlers = plugin.hooks.get(payload.event)
      if (!handlers) continue
      for (const handler of handlers) {
        try {
          await handler(payload.payload)
        } catch (error) {
          emitLog('warn', plugin.id, [
            `Hook "${payload.event}" failed: ${errorMessage(error)}`,
          ])
        }
      }
    }
    return { ok: true }
  }

  const handleRpc = async (method: PluginWorkerRpcMethod, payload: unknown): Promise<unknown> => {
    switch (method) {
      case 'load-plugins':
        return await handleLoadPlugins(
          payload as { workspaceDir: string; plugins: VerifiedPluginDescriptor[] }
        )
      case 'invoke-command':
        return await handleInvokeCommand(payload as { commandId: string; args?: unknown })
      case 'emit-hook':
        return await handleEmitHook(payload as { event: string; payload: unknown })
      case 'dispose':
        await deactivateAll()
        return { ok: true }
    }
  }

  const onMessage = (event: ParentPortMessageEvent): void => {
    const raw = event?.data
    if (!raw || typeof raw !== 'object') return
    const msg = raw as MainToPluginWorkerMessage
    if (msg.type !== 'rpc:req') return

    void (async () => {
      try {
        const result = await handleRpc(msg.method, msg.payload)
        post({ type: 'rpc:res', id: msg.id, ok: true, result })
      } catch (error) {
        post({ type: 'rpc:res', id: msg.id, ok: false, error: errorMessage(error) })
      }
    })()
  }

  port.on('message', onMessage)
  post({ type: 'ready' })

  return {
    detach: () => {
      port.off?.('message', onMessage)
      port.removeListener?.('message', onMessage)
    },
  }
}

const procParentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort
if (procParentPort) {
  attachPluginHostWorker(procParentPort)
}
