/**
 * 派活授权的**服务端**强制点（G9 / F-16 / F-17 / A-07）。
 *
 * 为什么不能只写在提示词里：模型可以自称「用户已同意」，而这是唯一决定
 * 「能不能在另一台机器上改代码」的地方。方案确认时落一份 scope，派活时逐项校验：
 * 设备 × 仓库的集合、工单额度、有效期。越界一律拒绝并回一条事件。
 */

export interface AuthorizationScopeItem {
  deviceId: string
  /** 终端侧绝对路径；非 git 目录不进来（G10） */
  workspacePath: string
}

export interface AuthorizationRecord {
  id: string
  items: AuthorizationScopeItem[]
  /** 工单额度（O-06：初始 5 张，按工单计不按工作单元计） */
  quota: number
  used: number
  /** 用户确认方案的时间与摘要（F-18 的凭据） */
  confirmedAt: number
  confirmedSummary: string
  expiresAt: number
  revokedAt: number | null
}

export type DispatchCheck =
  | { ok: true }
  | { ok: false; code: 'unknown-authorization' | 'expired' | 'revoked' | 'out-of-scope' | 'quota' }

export function checkDispatch(
  authorization: AuthorizationRecord | undefined | null,
  request: { deviceId: string; workspacePath: string; sameUnit?: boolean },
  now = Date.now()
): DispatchCheck {
  if (!authorization) return { ok: false, code: 'unknown-authorization' }
  if (authorization.revokedAt) return { ok: false, code: 'revoked' }
  if (authorization.expiresAt <= now) return { ok: false, code: 'expired' }

  const inScope = authorization.items.some(
    (item) =>
      item.deviceId === request.deviceId &&
      // 路径比较用统一分隔符，避免 Windows 反斜杠与 Linux 正斜杠混用时误判
      normalizePath(item.workspacePath) === normalizePath(request.workspacePath)
  )
  if (!inScope) return { ok: false, code: 'out-of-scope' }

  // 额度：同一工作单元为「收敛为一次提交」而追加的工单默认放行（O-06 的例外）
  if (!request.sameUnit && authorization.used >= authorization.quota) {
    return { ok: false, code: 'quota' }
  }
  return { ok: true }
}

export function consumeQuota(authorization: AuthorizationRecord, sameUnit?: boolean): AuthorizationRecord {
  return {
    ...authorization,
    used: sameUnit ? authorization.used : authorization.used + 1,
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export const DEFAULT_QUOTA = 5
/** 方案授权的默认有效期：一张方案的执行窗口，过期需重新确认 */
export const DEFAULT_AUTHORIZATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
