/** 纯 Node 路径安全原语（零 Electron 依赖，可供 worker_threads 直接引用） */

import * as path from 'path'
import { lstatSync, readlinkSync, realpathSync } from 'fs'

export function normalizeForComparison(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * realpath 规范化；目标尚不存在时向上找到最近的已存在祖先再拼回剩余路径（覆盖多级新建）。
 *
 * 必须用 lstatSync 识别悬挂符号链接（目标尚不存在但链接本身存在）：
 * 若按普通缺失段回退到父目录，工作区内的 `evil -> /etc/target` 会被误判成工作区内路径，
 * 随后写入会穿透到链接指向的越界目标。
 */
export function canonicalizePath(targetPath: string): string | null {
  if (typeof targetPath !== 'string' || !targetPath) return null

  let current = path.resolve(targetPath)
  const missingSegments: string[] = []
  let symlinkHops = 0

  for (let depth = 0; depth < 64; depth++) {
    try {
      const resolved = realpathSync.native(current)
      return missingSegments.length > 0
        ? path.join(resolved, ...missingSegments.reverse())
        : resolved
    } catch {
      try {
        const linkStat = lstatSync(current)
        if (linkStat.isSymbolicLink()) {
          symlinkHops += 1
          if (symlinkHops > 20) return null
          const linkTarget = readlinkSync(current)
          current = path.resolve(path.dirname(current), linkTarget)
          continue
        }
      } catch {
        // 确实不存在：继续向父目录回退
      }
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
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}
