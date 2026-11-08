/**
 * 派活的 IPC：配置、工作区白名单、运行状态、急停。
 *
 * 与云端配置同一套约定：渲染层只能看到「要不要派活 / 派给哪些工作区 / 现在在跑什么」，
 * 绝对路径只在本机 UI 里出现（用户自己选的目录），**永远不上传**。
 */

import { dialog, type BrowserWindow } from 'electron'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { handleIpc } from './register.js'
import type { AgentIpcContext } from './agent.js'
import {
  findWorkspace,
  publicWorkspaces,
  readDispatchConfig,
  restoreDispatchTrust,
  workspaceIdFor,
  writeDispatchConfig,
  type DispatchConfig,
  type DispatchWorkspace,
} from '../dispatch/config.js'
import type { DispatchWorker, DispatchWorkerState } from '../dispatch/worker.js'
import { canonicalizePath, trustWorkspace } from '../workspace-trust.js'

export interface DispatchIpcContext {
  worker: DispatchWorker
  agentContext: AgentIpcContext
  getMainWindow: () => BrowserWindow | null
  getLanguage: () => 'zh' | 'en'
  logger: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void }
}

export interface PublicDispatchWorkspace {
  id: string
  path: string
  label: string
  description: string
  /** 目录是否还在：被删 / 被移走的要如实标出来 */
  exists: boolean
  /** 云端此刻看到的状态 */
  published: boolean
}

export interface PublicDispatchConfig {
  enabled: boolean
  workspaces: PublicDispatchWorkspace[]
  state: DispatchWorkerState
}

function toPublic(config: DispatchConfig, state: DispatchWorkerState): PublicDispatchConfig {
  const published = state.connected && state.publishedAt !== null
  return {
    enabled: config.enabled,
    workspaces: config.workspaces.map((item) => ({
      id: item.id,
      path: item.path,
      label: item.label,
      description: item.description,
      exists: exists(item.path),
      published: published && exists(item.path),
    })),
    state,
  }
}

function exists(target: string): boolean {
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

export function registerDispatchIpc(context: DispatchIpcContext): { dispose: () => Promise<void> } {
  const { worker } = context

  handleIpc('dispatch:config:get', async () => {
    try {
      return { success: true, config: toPublic(readDispatchConfig(), worker.getState()) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc(
    'dispatch:config:set',
    async (
      _event,
      patch: {
        enabled?: boolean
        workspaces?: Array<{ path?: string; id?: string; label?: string; description?: string }>
      }
    ) => {
      try {
        const current = readDispatchConfig()
        const next: DispatchConfig = {
          enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : current.enabled,
          workspaces: current.workspaces,
        }
        if (Array.isArray(patch?.workspaces)) {
          const workspaces: DispatchWorkspace[] = []
          for (const item of patch.workspaces) {
            const canonical =
              typeof item?.path === 'string' ? canonicalizePath(item.path) : null
            if (!canonical || !exists(canonical)) continue
            // 只允许「本来就在白名单里的」或「用户在对话框里刚选的」目录：
            // 这里的选择本身就是一次授权，登记进信任表
            trustWorkspace(canonical)
            const fallbackLabel = basename(canonical)
            workspaces.push({
              id: workspaceIdFor(canonical),
              path: canonical,
              label: (item.label ?? '').trim().slice(0, 120) || fallbackLabel,
              description: (item.description ?? '').slice(0, 400),
            })
          }
          next.workspaces = workspaces
        }
        const saved = await writeDispatchConfig(next)
        await worker.refresh()
        return { success: true, config: toPublic(saved, worker.getState()) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  handleIpc('dispatch:workspace:add', async () => {
    try {
      const options: Electron.OpenDialogOptions = {
        title:
          context.getLanguage() === 'en'
            ? 'Choose a workspace to dispatch'
            : '选择允许派活的工作区',
        properties: ['openDirectory', 'createDirectory'],
      }
      const parent = context.getMainWindow()
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      const picked = result.canceled ? '' : result.filePaths[0] ?? ''
      if (!picked) return { success: true, canceled: true, config: toPublic(readDispatchConfig(), worker.getState()) }
      const canonical = trustWorkspace(picked) ?? canonicalizePath(picked)
      if (!canonical) return { success: false, error: '无法解析所选目录' }
      const current = readDispatchConfig()
      if (findWorkspace(current, workspaceIdFor(canonical))) {
        return { success: true, config: toPublic(current, worker.getState()) }
      }
      const saved = await writeDispatchConfig({
        enabled: current.enabled,
        workspaces: [
          ...current.workspaces,
          {
            id: workspaceIdFor(canonical),
            path: canonical,
            label: basename(canonical),
            description: '',
          },
        ],
      })
      await worker.refresh()
      return { success: true, config: toPublic(saved, worker.getState()) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('dispatch:workspace:update', async (_event, input: { id: string; label?: string; description?: string }) => {
    try {
      const current = readDispatchConfig()
      const workspaces = current.workspaces.map((item) =>
        item.id === input?.id
          ? {
              ...item,
              label: (input.label ?? item.label).trim().slice(0, 120) || item.label,
              description: (input.description ?? item.description).slice(0, 400),
            }
          : item
      )
      const saved = await writeDispatchConfig({ ...current, workspaces })
      await worker.refresh()
      return { success: true, config: toPublic(saved, worker.getState()) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('dispatch:workspace:remove', async (_event, id: string) => {
    try {
      const current = readDispatchConfig()
      const saved = await writeDispatchConfig({
        ...current,
        workspaces: current.workspaces.filter((item) => item.id !== id),
      })
      await worker.refresh()
      return { success: true, config: toPublic(saved, worker.getState()) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  handleIpc('dispatch:state', async () => {
    try {
      return {
        success: true,
        state: worker.getState(),
        config: toPublic(readDispatchConfig(), worker.getState()),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** 急停：断中继 + abort 正在跑的本地会话，云端那条任务同时置为 canceled */
  handleIpc('dispatch:stop', async () => {
    try {
      await worker.stopNow()
      return { success: true, config: toPublic(readDispatchConfig(), worker.getState()) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 账本是排查用的：界面打开时先读进来，运行态由 worker 推送
  worker.loadLedger()

  // 开机先恢复信任表：白名单里的目录可能还没被用户在本次启动中打开过
  try {
    restoreDispatchTrust()
  } catch (error) {
    context.logger.warn('[Dispatch] restoring trusted workspaces failed', error)
  }

  return {
    dispose: async () => {
      await worker.stop()
    },
  }
}

/** 供界面显示的「云端此刻看到的工作区」（不含路径） */
export function publishedWorkspaces(config: DispatchConfig): Array<{
  id: string
  label: string
  description: string
}> {
  return publicWorkspaces(config)
}
