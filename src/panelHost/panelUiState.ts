/**
 * 面板换窗口时带走的轻量 UI 状态。
 *
 * 拆到独立窗口 = 面板组件在另一个 document 里重建，组件内部的 state 会丢。
 * 业务状态都在各自的 store 里，这里只放「就地手感」：展开的目录、滚动位置。
 * 仅运行期保存，不落盘。
 */

const memory = new Map<string, Map<string, unknown>>()

export function readPanelUi<T>(workspaceDir: string, name: string): T | undefined {
  return memory.get(workspaceDir)?.get(name) as T | undefined
}

export function writePanelUi(workspaceDir: string, name: string, value: unknown): void {
  const bucket = memory.get(workspaceDir) ?? new Map<string, unknown>()
  bucket.set(name, value)
  memory.set(workspaceDir, bucket)
}

/** 工作区关闭时一并丢弃 */
export function clearPanelUi(workspaceDir: string): void {
  memory.delete(workspaceDir)
}
