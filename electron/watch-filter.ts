/**
 * 工作区文件监听的忽略规则。
 *
 * 依赖、构建产物与应用数据目录的变化不需要推送给渲染进程，
 * 否则 node_modules 的大量写入会淹没编辑器。
 *
 * 例外：`.pi-workbench/worktrees/**` 与 `.pi-worktrees/**` 是会话绑定的真实源码树，
 * 其中的写入（尤其是 Agent 直接改盘）必须推送，否则编辑器里打开的文档不会自动刷新。
 */

/** 任何深度都不推送：版本库元数据、依赖、Electron 构建输出 */
const ALWAYS_IGNORED_SEGMENT = /(^|[\\/])(\.git|node_modules|dist-electron)([\\/]|$)/

/** 仅在工作区根（或工作树根）顶层忽略的目录，避免误伤 `src/cache/`、`src/dist/` 等深层源码目录 */
const ROOT_ONLY_IGNORED_SEGMENT = /^(cache|dist|release|logs)([\\/]|$)/

/** 应用数据目录标记，可能出现多次（工作树里也有自己的 `.pi-workbench`） */
const APP_DATA_MARKER = /(?:^|[\\/])(\.pi-workbench|\.pi-worktrees)(?=[\\/]|$)/g

/** `path` 为相对工作区的路径（fs.watch 的 filename） */
export function isIgnoredWatchPath(filePath: string): boolean {
  const normalized = filePath.replace(/^(?:\.[\\/])+/, '')
  if (ALWAYS_IGNORED_SEGMENT.test(normalized)) return true
  if (ROOT_ONLY_IGNORED_SEGMENT.test(normalized)) return true

  // 以最内层的应用数据目录为准：工作树内部的 `.pi-workbench` 仍然要忽略
  let last: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  APP_DATA_MARKER.lastIndex = 0
  while ((match = APP_DATA_MARKER.exec(normalized)) !== null) last = match
  if (!last) return false

  const rest = normalized.slice(last.index + last[0].length)

  // `.pi-worktrees/<id>/**` 整棵都是源码工作树；仅过滤该工作树根下的构建产物目录
  if (last[1] === '.pi-worktrees') {
    const insideWorktree = /^[\\/][^\\/]+[\\/](.*)$/.exec(rest)?.[1] ?? ''
    return Boolean(insideWorktree && ROOT_ONLY_IGNORED_SEGMENT.test(insideWorktree))
  }

  // `.pi-workbench/**` 里只有 `worktrees/<id>/**` 是源码；plugins / drafts / cache 继续忽略
  if (!/^[\\/]worktrees(?:[\\/]|$)/.test(rest)) return true
  const insideWorktree = /^[\\/]worktrees[\\/][^\\/]+[\\/](.*)$/.exec(rest)?.[1] ?? ''
  return Boolean(insideWorktree && ROOT_ONLY_IGNORED_SEGMENT.test(insideWorktree))
}
