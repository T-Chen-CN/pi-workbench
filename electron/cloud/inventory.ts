/**
 * 工作区清单上报（F-09）：只报路径、remote、默认分支，不报文件内容。
 *
 * 非 git 目录照样上报，但 `isGit: false` —— 云端据此在派活列表里标灰并拒绝（G10）。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { sanitizeTerminalEnv } from '../terminal-manager.js'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 8_000

export interface WorkspaceInventoryItem {
  path: string
  name: string
  remote?: string
  defaultBranch?: string
  isGit: boolean
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      env: sanitizeTerminalEnv(process.env),
    })
    return stdout.trim()
  } catch {
    return null
  }
}

export async function describeWorkspace(workspacePath: string): Promise<WorkspaceInventoryItem> {
  const name = path.basename(workspacePath) || workspacePath
  if (!existsSync(workspacePath)) return { path: workspacePath, name, isGit: false }

  const inside = await git(workspacePath, ['rev-parse', '--is-inside-work-tree'])
  if (inside !== 'true') return { path: workspacePath, name, isGit: false }

  // 子目录不是仓库根时派活会绑错地方，所以上报仓库根
  const root = (await git(workspacePath, ['rev-parse', '--show-toplevel'])) || workspacePath
  const remote = await git(root, ['remote', 'get-url', 'origin'])
  const branch =
    (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))?.replace(
      /^origin\//,
      ''
    ) ||
    (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) ||
    undefined

  return {
    path: root,
    name: path.basename(root) || name,
    remote: remote ?? undefined,
    defaultBranch: branch && branch !== 'HEAD' ? branch : undefined,
    isGit: true,
  }
}

export async function describeWorkspaces(paths: string[]): Promise<WorkspaceInventoryItem[]> {
  const unique = [...new Set(paths.filter((item) => typeof item === 'string' && item.trim()))]
  const items = await Promise.all(unique.map((item) => describeWorkspace(item)))
  return items.sort((a, b) => a.name.localeCompare(b.name))
}
