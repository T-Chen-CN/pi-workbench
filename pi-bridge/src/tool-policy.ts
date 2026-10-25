/**
 * 会话模式与工具可用性策略（纯函数）
 *
 * 模式决定“允许哪些工具”，平台决定“工具在当前环境是否可用”；
 * 两者分开，避免模式逻辑被环境分支污染。
 */
import type { SessionMode } from './approval-policy.js'

/** 只读模式可用工具 */
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const

/** 只在 Plan 模式有效的工具；执行模式必须排除 */
export const PLAN_ONLY_TOOLS = ['submit_plan'] as const

/** Plan 模式工具集 */
export const PLAN_MODE_TOOLS = [...READ_ONLY_TOOLS, ...PLAN_ONLY_TOOLS] as const

/**
 * 模式白名单。
 * null 表示“所有已注册工具”，执行模式再排除 PLAN_ONLY_TOOLS。
 */
const MODE_ALLOWLIST: Record<SessionMode, readonly string[] | null> = {
  readonly: READ_ONLY_TOOLS,
  plan: PLAN_MODE_TOOLS,
  ask: null,
  auto: null,
}

/** 只在 Windows 上可用的 SDK 工具 */
const WINDOWS_ONLY_TOOLS = new Set(['powershell'])

export function isToolAvailableOnPlatform(
  name: string,
  platform: NodeJS.Platform
): boolean {
  if (WINDOWS_ONLY_TOOLS.has(name)) return platform === 'win32'
  return true
}

/**
 * 计算某个会话模式下实际激活的工具名。
 *
 * - readonly / plan：使用固定白名单
 * - ask / auto：所有已注册工具，减去 Plan-only 和当前平台不可用的工具
 *
 * 结果只取决于模式、注册表和平台，不受会话历史影响。
 */
export function resolveModeTools(
  mode: SessionMode,
  registered: readonly string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  const available = registered.filter((name) => isToolAvailableOnPlatform(name, platform))
  const allow = MODE_ALLOWLIST[mode]

  if (allow) {
    const allowed = new Set(allow)
    return available.filter((name) => allowed.has(name))
  }

  const excluded = new Set<string>(PLAN_ONLY_TOOLS)
  return available.filter((name) => !excluded.has(name))
}
