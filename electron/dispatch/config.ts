/**
 * 派活配置：`data/agent/dispatch.json`
 *
 * 只存三样东西：总开关、允许派活的工作区（含给人看的标签与描述）、每个工作区的
 * `id`（稳定标识，云端只认它，永远不下发绝对路径）。
 *
 * 纪律：
 * - **白名单就是授权**：写进这个文件等于把该目录加进 `trustedWorkspaceRoots`，
 *   否则 `agent:initialize` 会因为「工作区未批准」直接拒绝。
 * - 路径一律规范化后落盘（`realpath`），Windows 大小写差异不进文件。
 * - 落盘走原子写；损坏时回退到「全部关闭」，绝不让派活在不确定的配置下开启。
 */

import * as crypto from 'node:crypto'
import * as path from 'node:path'
import { getAppDir } from '../app-paths.js'
import { readJsonWithBackup, writeJsonAtomic } from '../atomic-json.js'
import { canonicalizePath, isTrustedWorkspacePath, trustWorkspace } from '../workspace-trust.js'

export interface DispatchWorkspace {
  /** 稳定 id（路径哈希），云端目录里只出现这个 */
  id: string
  /** 绝对路径，只在本地使用 */
  path: string
  /** 显示名（默认目录名） */
  label: string
  /** 给云端模型看的能力描述，必须写触发词，否则选错目标 */
  description: string
}

export interface DispatchConfig {
  /** 总开关；关掉之后云端派活会被明确拒绝，而不是排队 */
  enabled: boolean
  workspaces: DispatchWorkspace[]
}

const EMPTY: DispatchConfig = { enabled: false, workspaces: [] }

export function dispatchConfigFile(): string {
  return path.join(getAppDir(), 'data', 'agent', 'dispatch.json')
}

/** 工作区 id：路径哈希前 12 位，稳定且不泄漏路径 */
export function workspaceIdFor(targetPath: string): string {
  const canonical = canonicalizePath(targetPath) ?? path.resolve(targetPath)
  return crypto
    .createHash('sha1')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .digest('hex')
    .slice(0, 12)
}

function sanitizeWorkspace(raw: unknown): DispatchWorkspace | null {
  if (!raw || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const rawPath = typeof source.path === 'string' ? source.path.trim() : ''
  if (!rawPath) return null
  const canonical = canonicalizePath(rawPath)
  if (!canonical) return null
  const label = typeof source.label === 'string' ? source.label.trim() : ''
  const description = typeof source.description === 'string' ? source.description.trim() : ''
  return {
    id: workspaceIdFor(canonical),
    path: canonical,
    label: (label || path.basename(canonical)).slice(0, 120),
    description: description.slice(0, 400),
  }
}

export function readDispatchConfig(): DispatchConfig {
  const { data } = readJsonWithBackup<Record<string, unknown>>(dispatchConfigFile())
  if (!data || typeof data !== 'object') return { ...EMPTY, workspaces: [] }
  const workspaces = Array.isArray(data.workspaces)
    ? data.workspaces
        .map(sanitizeWorkspace)
        .filter((item): item is DispatchWorkspace => Boolean(item))
    : []
  // 同一个目录只留一条
  const seen = new Set<string>()
  const unique = workspaces.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  return { enabled: data.enabled === true, workspaces: unique }
}

/**
 * 把配置写回磁盘，并把每个工作区登记进信任表。
 *
 * 信任表是内存集合（`workspace-trust.ts`），不写这里的目录即使在白名单里也初始化
 * 不了 Agent —— 开机恢复配置时同样要调这个函数。
 */
export async function writeDispatchConfig(next: DispatchConfig): Promise<DispatchConfig> {
  const seen = new Set<string>()
  const workspaces = next.workspaces
    .map((item) =>
      sanitizeWorkspace({ path: item.path, label: item.label, description: item.description })
    )
    .filter((item): item is DispatchWorkspace => {
      // 同一个目录只留一条：id 由路径哈希得到，重复项必然 id 相同
      if (!item || seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
  const normalized: DispatchConfig = { enabled: next.enabled === true, workspaces }
  await writeJsonAtomic(dispatchConfigFile(), normalized)
  for (const item of workspaces) trustWorkspace(item.path)
  return normalized
}

/** 开机调用：把已保存的白名单重新登记进信任表（否则未打开过的目录无法初始化） */
export function restoreDispatchTrust(): DispatchConfig {
  const config = readDispatchConfig()
  for (const item of config.workspaces) trustWorkspace(item.path)
  return config
}

/** 交给云端的工作区清单：**只有 id / 标签 / 描述**，没有路径 */
export function publicWorkspaces(config: DispatchConfig): Array<{
  id: string
  label: string
  description: string
}> {
  return config.workspaces.map((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
  }))
}

export function findWorkspace(
  config: DispatchConfig,
  workspaceId: string
): DispatchWorkspace | null {
  return config.workspaces.find((item) => item.id === workspaceId) ?? null
}

/** 白名单里的目录可能被用户删掉 / 改名：这种要如实报给界面，不能假装还能派活 */
export function isDispatchablePath(targetPath: string): boolean {
  return isTrustedWorkspacePath(targetPath)
}
