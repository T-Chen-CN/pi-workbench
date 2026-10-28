/**
 * 工作区文件监听的忽略规则。
 *
 * 依赖、构建产物与应用数据目录的变化不需要推送给渲染进程，
 * 否则 node_modules 的大量写入会淹没编辑器。
 *
 * 例外：`.pi-workbench/worktrees/**` 与 `.pi-worktrees/**` 是会话绑定的真实源码树，
 * 其中的写入（尤其是 Agent 直接改盘）必须推送，否则编辑器里打开的文档不会自动刷新。
 */

/** 任何位置都不推送：版本库元数据、依赖、构建产物 */
const HARD_IGNORED_SEGMENT = /(^|[\\/])(\.git|node_modules|cache|dist|dist-electron|release)([\\/]|$)/

/** 应用数据目录标记，可能出现多次（工作树里也有自己的 `.pi-workbench`） */
const APP_DATA_MARKER = /(?:^|[\\/])(\.pi-workbench|\.pi-worktrees)(?=[\\/]|$)/g

/** `path` 为相对工作区的路径（fs.watch 的 filename） */
export function isIgnoredWatchPath(filePath: string): boolean {
  if (HARD_IGNORED_SEGMENT.test(filePath)) return true

  // 以最内层的应用数据目录为准：工作树内部的 `.pi-workbench` 仍然要忽略
  let last: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  APP_DATA_MARKER.lastIndex = 0
  while ((match = APP_DATA_MARKER.exec(filePath)) !== null) last = match
  if (!last) return false

  // `.pi-worktrees/**` 整棵都是源码工作树
  if (last[1] === '.pi-worktrees') return false

  // `.pi-workbench/**` 里只有 `worktrees/**` 是源码；plugins / drafts / cache 继续忽略
  const rest = filePath.slice(last.index + last[0].length)
  return !/^[\\/]worktrees(?:[\\/]|$)/.test(rest)
}
