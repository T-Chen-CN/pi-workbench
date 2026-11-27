/**
 * 面板换窗口时带走的轻量 UI 状态。
 *
 * 拆到独立原生窗口或回位时，面板组件会在新窗口中重建。这里保留「就地手感」
 * （展开的目录、滚动位置），并通过 windowSync 在主窗口与拆出窗口之间同步。
 * 仅运行期保存，不落盘。
 */

const memory = new Map<string, Map<string, unknown>>()
const subscribers = new Set<(workspaceDir: string, name: string, value: unknown) => void>()
let writeListener: ((workspaceDir: string, name: string, value: unknown) => void) | null = null

export function setPanelUiWriteListener(
  listener: ((workspaceDir: string, name: string, value: unknown) => void) | null
): void {
  writeListener = listener
}

/** 订阅来自其它窗口的 UI 状态同步更新（供刚挂载的拆出面板二次应用展开/滚动快照） */
export function subscribePanelUiSync(
  listener: (workspaceDir: string, name: string, value: unknown) => void
): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

export function readPanelUi<T>(workspaceDir: string, name: string): T | undefined {
  return memory.get(workspaceDir)?.get(name) as T | undefined
}

/** 仅写入本窗口内存并通知本地订阅者（用于接收跨窗同步，避免回声广播） */
export function writePanelUiLocal(workspaceDir: string, name: string, value: unknown): void {
  const bucket = memory.get(workspaceDir) ?? new Map<string, unknown>()
  bucket.set(name, value)
  memory.set(workspaceDir, bucket)
  for (const listener of [...subscribers]) {
    listener(workspaceDir, name, value)
  }
}

export function writePanelUi(workspaceDir: string, name: string, value: unknown): void {
  const bucket = memory.get(workspaceDir) ?? new Map<string, unknown>()
  bucket.set(name, value)
  memory.set(workspaceDir, bucket)
  writeListener?.(workspaceDir, name, value)
}

/** 枚举工作区全部运行期 UI 状态快照（供新打开的拆出窗口初始化恢复） */
export function listPanelUi(workspaceDir: string): Array<{ name: string; value: unknown }> {
  const bucket = memory.get(workspaceDir)
  if (!bucket) return []
  return Array.from(bucket.entries(), ([name, value]) => ({ name, value }))
}

/** 工作区关闭时一并丢弃 */
export function clearPanelUi(workspaceDir: string): void {
  memory.delete(workspaceDir)
}
