/** 工作区信任与路径包含校验 */

import * as path from 'path'
import { realpathSync, statSync } from 'fs'
import { getAppDir } from './app-paths.js'

/** 用户明确批准过的工作区根（realpath 规范化后的小写形式，Windows 大小写不敏感） */
export const trustedWorkspaceRoots = new Set<string>()

export function normalizeForComparison(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/** realpath 规范化；目标尚不存在时向上找到最近的已存在祖先再拼回剩余路径（覆盖多级新建） */
export function canonicalizePath(targetPath: string): string | null {
  if (typeof targetPath !== 'string' || !targetPath) return null

  let current = path.resolve(targetPath)
  const missingSegments: string[] = []

  for (let depth = 0; depth < 64; depth++) {
    try {
      const resolved = realpathSync.native(current)
      return missingSegments.length > 0
        ? path.join(resolved, ...missingSegments.reverse())
        : resolved
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return null
      missingSegments.push(path.basename(current))
      current = parent
    }
  }

  return null
}

/**
 * 判断 target 是否位于 root 内。使用 path.relative 而不是字符串前缀比较，
 * 避免 C:\foo 与 C:\foobar 这类前缀误判，也能正确处理符号链接解析后的路径。
 */
export function isPathInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(normalizeForComparison(root), normalizeForComparison(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** 登记用户通过原生目录选择器批准的工作区根 */
export function trustWorkspace(targetPath: string): string | null {
  const canonical = canonicalizePath(targetPath)
  if (!canonical) return null
  try {
    if (!statSync(canonical).isDirectory()) return null
  } catch {
    return null
  }
  trustedWorkspaceRoots.add(normalizeForComparison(canonical))
  return canonical
}

export function isTrustedWorkspacePath(targetPath: string): boolean {
  const canonical = canonicalizePath(targetPath)
  return canonical !== null && trustedWorkspaceRoots.has(normalizeForComparison(canonical))
}

/**
 * 监听允许的目录：受信任根，或位于任一受信任根内的子目录（会话绑定的工作树）。
 *
 * 只授予「监听」能力，写 / 删 / 改仍走 `resolveAllowedFileTarget` 的原有校验。
 */
export function resolveWatchableRoot(targetPath: string): string | null {
  const canonical = canonicalizePath(targetPath)
  if (!canonical) return null
  const normalized = normalizeForComparison(canonical)
  if (trustedWorkspaceRoots.has(normalized)) return canonical
  for (const root of trustedWorkspaceRoots) {
    if (isPathInsideRoot(root, normalized)) return canonical
  }
  return null
}

/** 文件写删改操作允许的范围：受信任工作区与应用缓存目录 */
export function resolveAllowedFileTarget(targetPath: string): string | null {
  const target = canonicalizePath(targetPath)
  if (!target) return null

  const roots = [...trustedWorkspaceRoots]
  const cacheRoot = canonicalizePath(path.join(getAppDir(), 'cache'))
  if (cacheRoot) roots.push(normalizeForComparison(cacheRoot))

  return roots.some((root) => isPathInsideRoot(root, target)) ? target : null
}

/** 受保护的应用/工作区根目录：允许操作其中内容，但不允许删除或改名根本身 */
export function isProtectedRoot(canonicalPath: string): boolean {
  const normalized = normalizeForComparison(canonicalPath)
  if (trustedWorkspaceRoots.has(normalized)) return true
  const cacheRoot = canonicalizePath(path.join(getAppDir(), 'cache'))
  return cacheRoot !== null && normalizeForComparison(cacheRoot) === normalized
}

/** 校验工作区与文件路径，用于草稿等按文件持久化的能力 */
export function resolveWorkspaceFile(
  workspacePath: string,
  filePath: string
): { workspace: string; file: string } | null {
  if (!isTrustedWorkspacePath(workspacePath)) return null
  const workspace = canonicalizePath(workspacePath)
  const file = canonicalizePath(filePath)
  if (!workspace || !file || !isPathInsideRoot(workspace, file)) return null
  return { workspace, file }
}
