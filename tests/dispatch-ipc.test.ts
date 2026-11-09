/**
 * 派活 IPC：白名单只能通过系统对话框扩张，渲染层递进来的陌生路径一律丢掉。
 *
 * 这条约束就是「白名单 = 授权」的落地形式：如果 `config:set` 能随手加目录，
 * 云端（或任何能发 IPC 的渲染层代码）就能把 `/` 变成可派活目标。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

interface Handler {
  (event: unknown, ...args: unknown[]): unknown
}

const mocks = vi.hoisted(() => ({
  appDir: '',
  handlers: new Map<string, Handler>(),
  dialogPicks: [] as string[]
}))

vi.mock('electron', () => ({
  app: { isReady: () => false, getAppPath: () => mocks.appDir, getPath: () => mocks.appDir },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      mocks.handlers.set(channel, handler)
    },
    removeHandler: () => {}
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [mocks.dialogPicks.shift() ?? ''] })
  },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => {} },
  net: { fetch: async () => new Response('{}') },
  BrowserWindow: class {},
  WebContentsView: class {}
}))

vi.mock('../electron/app-paths.js', () => ({ getAppDir: () => mocks.appDir }))

import { readDispatchConfig, writeDispatchConfig, workspaceIdFor } from '../electron/dispatch/config'
import { isTrustedWorkspacePath } from '../electron/workspace-trust'
import { registerDispatchIpc } from '../electron/ipc/dispatch'

function call<T = Record<string, unknown>>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`IPC handler not registered: ${channel}`)
  return Promise.resolve(handler({}, ...args) as T)
}

let tmp = ''
let repo = ''
let other = ''

beforeEach(async () => {
  // 必须 `realpathSync.native`：白名单落盘走 `canonicalizePath()`（同样是 native），
  // CI 上 tmpdir 可能是 8.3 短名（Windows `RUNNER~1`）或符号链接（macOS `/var`），
  // 非 native 版不展开，断言会两边不等。
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dispatch-ipc-')))
  mocks.appDir = tmp
  mocks.handlers.clear()
  mocks.dialogPicks.length = 0
  repo = path.join(tmp, 'repo')
  other = path.join(tmp, 'other')
  fs.mkdirSync(repo, { recursive: true })
  fs.mkdirSync(other, { recursive: true })
  fs.mkdirSync(path.join(tmp, 'data', 'agent'), { recursive: true })

  const state = {
    enabled: false,
    connected: false,
    lastFrameAt: null,
    lastError: null,
    runningTaskId: null,
    runningWorkspace: null,
    queued: 0,
    publishedAt: null,
    recent: []
  }
  const worker = {
    getState: () => state,
    refresh: async () => undefined,
    loadLedger: () => undefined,
    stop: async () => undefined,
    stopNow: async () => undefined
  }
  registerDispatchIpc({
    worker: worker as never,
    agentContext: {} as never,
    getMainWindow: () => null,
    getLanguage: () => 'zh' as const,
    logger: { warn: () => {} }
  })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('dispatch ipc', () => {
  it('refuses to whitelist a path the user never picked', async () => {
    await writeDispatchConfig({
      enabled: false,
      workspaces: [{ id: '', path: repo, label: 'repo', description: '' }]
    })

    const result = await call<{ success: boolean; config: { workspaces: Array<{ path: string }> } }>(
      'dispatch:config:set',
      { enabled: true, workspaces: [{ path: repo }, { path: other }] }
    )

    expect(result.success).toBe(true)
    // 陌生目录被丢掉，只留下原本在白名单里的那个
    expect(result.config.workspaces.map((item) => item.path)).toEqual([repo])
    expect(readDispatchConfig().workspaces).toHaveLength(1)
  })

  it('adds a workspace only through the system dialog', async () => {
    mocks.dialogPicks.push(other)
    const result = await call<{ success: boolean; config: { workspaces: Array<{ path: string }> } }>(
      'dispatch:workspace:add'
    )
    expect(result.success).toBe(true)
    expect(result.config.workspaces.map((item) => item.path)).toEqual([other])
    // 对话框点选 = 授权：目录进了信任表，Agent 才初始化得起来
    expect(isTrustedWorkspacePath(other)).toBe(true)
    expect(isTrustedWorkspacePath(path.join(tmp, 'never-picked'))).toBe(false)
  })

  it('keeps the label editable but the path fixed', async () => {
    await writeDispatchConfig({
      enabled: true,
      workspaces: [{ id: '', path: repo, label: 'repo', description: '' }]
    })
    const result = await call<{ config: { workspaces: Array<{ label: string; path: string }> } }>(
      'dispatch:workspace:update',
      { id: workspaceIdFor(repo), label: '前端仓库', description: '跑测试用' }
    )
    expect(result.config.workspaces[0]).toMatchObject({ label: '前端仓库', path: repo })
  })

  it('removes a workspace from the whitelist', async () => {
    await writeDispatchConfig({
      enabled: true,
      workspaces: [{ id: '', path: repo, label: 'repo', description: '' }]
    })
    const result = await call<{ config: { workspaces: unknown[] } }>('dispatch:workspace:remove', workspaceIdFor(repo))
    expect(result.config.workspaces).toHaveLength(0)
    expect(readDispatchConfig().workspaces).toHaveLength(0)
  })

  it('reports a missing directory as exists=false instead of dropping it', async () => {
    await writeDispatchConfig({
      enabled: true,
      workspaces: [{ id: '', path: other, label: 'other', description: '' }]
    })
    fs.rmSync(other, { recursive: true, force: true })
    const result = await call<{ config: { workspaces: Array<{ exists: boolean; published: boolean }> } }>(
      'dispatch:config:get'
    )
    expect(result.config.workspaces[0]).toMatchObject({ exists: false, published: false })
    expect(readDispatchConfig().workspaces).toHaveLength(1)
  })
})
