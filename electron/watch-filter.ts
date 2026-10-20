/**
 * 工作区文件监听的忽略规则。
 *
 * 依赖、构建产物与应用数据目录的变化不需要推送给渲染进程，
 * 否则 node_modules 的大量写入会淹没编辑器。
 */
const IGNORED_SEGMENT =
  /(^|[\\/])(\.git|node_modules|\.pi-workbench|cache|dist|dist-electron|release)([\\/]|$)/

/** path 为相对工作区的路径（fs.watch 的 filename） */
export function isIgnoredWatchPath(filePath: string): boolean {
  return IGNORED_SEGMENT.test(filePath)
}
