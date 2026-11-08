/**
 * 派活配置：白名单落盘、路径不上云、信任表登记、损坏回退。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const state = vi.hoisted(() => ({ appDir: '' }))

vi.mock('../electron/app-paths.js', () => ({
  getAppDir: () => state.appDir,
}))

import {
  dispatchConfigFile,
  findWorkspace,
  publicWorkspaces,
  readDispatchConfig,
  restoreDispatchTrust,
  workspaceIdFor,
  writeDispatchConfig,
} from '../electron/dispatch/config'
import { isTrustedWorkspacePath } from '../electron/workspace-trust'

let tmp = ''

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dispatch-config-'))
  state.appDir = tmp
  fs.mkdirSync(path.join(tmp, 'data', 'agent'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function makeWorkspace(name: string): string {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe('dispatch config', () => {
  it('defaults to disabled with no workspace', () => {
    expect(readDispatchConfig()).toEqual({ enabled: false, workspaces: [] })
  })

  it('keeps the id stable and derived from the canonical path', async () => {
    const dir = makeWorkspace('repo-a')
    const saved = await writeDispatchConfig({
      enabled: true,
      workspaces: [{ id: 'ignored', path: dir, label: 'Repo A', description: '前端' }],
    })
    expect(saved.workspaces).toHaveLength(1)
    expect(saved.workspaces[0].id).toBe(workspaceIdFor(dir))
    expect(saved.workspaces[0].id).toHaveLength(12)
    expect(readDispatchConfig().workspaces[0]).toMatchObject({ label: 'Repo A', description: '前端' })
  })

  it('never exposes absolute paths in the catalog sent to the cloud', async () => {
    const dir = makeWorkspace('repo-b')
    const saved = await writeDispatchConfig({
      enabled: true,
      workspaces: [{ id: '', path: dir, label: 'B', description: '' }],
    })
    const catalog = publicWorkspaces(saved)
    expect(catalog).toEqual([{ id: workspaceIdFor(dir), label: 'B', description: '' }])
    expect(JSON.stringify(catalog)).not.toContain(dir)
  })

  it('registers every whitelisted path as a trusted workspace', async () => {
    const dir = makeWorkspace('repo-c')
    await writeDispatchConfig({
      enabled: true,
      workspaces: [{ id: '', path: dir, label: 'C', description: '' }],
    })
    expect(isTrustedWorkspacePath(dir)).toBe(true)
  })

  it('drops duplicates but keeps paths that are temporarily missing', async () => {
    const dir = makeWorkspace('repo-d')
    const saved = await writeDispatchConfig({
      enabled: true,
      workspaces: [
        { id: '', path: dir, label: 'D1', description: '' },
        { id: '', path: dir, label: 'D2', description: '' },
        { id: '', path: path.join(tmp, 'gone'), label: 'Ghost', description: '' },
      ],
    })
    // 重复目录只留第一条；不存在的目录保留（外接盘没挂上不该丢白名单，界面标「目录已不存在」）
    expect(saved.workspaces).toHaveLength(2)
    expect(saved.workspaces[0].label).toBe('D1')
    expect(saved.workspaces[1].label).toBe('Ghost')
  })

  it('falls back to closed when the file is broken', () => {
    fs.writeFileSync(dispatchConfigFile(), '{ not json', 'utf-8')
    expect(readDispatchConfig()).toEqual({ enabled: false, workspaces: [] })
  })

  it('restores trust for saved workspaces after a restart', async () => {
    const dir = makeWorkspace('repo-e')
    await writeDispatchConfig({
      enabled: true,
      workspaces: [{ id: '', path: dir, label: 'E', description: '' }],
    })
    // 新进程里信任表是空的，只读配置不会登记 —— restoreDispatchTrust 才补上
    const restored = restoreDispatchTrust()
    expect(restored.workspaces).toHaveLength(1)
    expect(isTrustedWorkspacePath(dir)).toBe(true)
    expect(findWorkspace(restored, workspaceIdFor(dir))?.label).toBe('E')
  })
})
