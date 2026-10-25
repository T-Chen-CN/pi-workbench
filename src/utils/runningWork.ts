import { useApprovalStore } from '../store/approvalStore'
import { useSessionStore } from '../store/sessionStore'

export interface RunningWorkSummary {
  /** 正在响应的会话数 */
  sessions: number
  /** 等待用户审批的请求数 */
  approvals: number
}

function workspacePrefix(workspacePath?: string): string | null {
  return workspacePath ? `${workspacePath}\u0000` : null
}

/** 统计运行中的会话与待审批请求；不包含终端 */
export function runningWorkFor(workspacePath?: string): RunningWorkSummary {
  const prefix = workspacePrefix(workspacePath)
  const sessions = Object.entries(useSessionStore.getState().streaming).filter(
    ([key, streaming]) => streaming && (!prefix || key.startsWith(prefix))
  ).length
  const approvals = useApprovalStore
    .getState()
    .requests.filter((request) => !workspacePath || request.workspaceDir === workspacePath).length
  return { sessions, approvals }
}

export function hasRunningWork(workspacePath?: string): boolean {
  const work = runningWorkFor(workspacePath)
  return work.sessions > 0 || work.approvals > 0
}
