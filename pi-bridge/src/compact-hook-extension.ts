/**
 * 压缩前钩子的转发扩展。
 *
 * `session_before_compact` 只在扩展侧可见（`session.subscribe` 收不到），
 * 而压缩前的完整分支历史只有这里有——P1 的记忆抽取就挂这个钩子。
 * 本扩展始终注册（不受 `builtinExtensions` 开关影响），因为它是内核供给的一部分，
 * 不是一个可选能力。
 */

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

export interface CompactHookContext {
  onBeforeCompact?: (event: {
    reason: 'manual' | 'threshold' | 'overflow'
    tokensBefore?: number
    entryCount: number
    willRetry: boolean
  }) => void
  logger: { warn: (...args: unknown[]) => void }
}

export function createCompactHookExtension(context: CompactHookContext): ExtensionFactory {
  return (pi) => {
    // 这个 handler 在压缩前被 await：不能抛（会掀掉压缩流程），也不能长时间阻塞
    pi.on('session_before_compact', async (event: any) => {
      try {
        const tokensBefore =
          typeof event?.preparation?.tokensBefore === 'number'
            ? event.preparation.tokensBefore
            : undefined
        context.onBeforeCompact?.({
          reason:
            event?.reason === 'manual' || event?.reason === 'overflow'
              ? event.reason
              : 'threshold',
          tokensBefore,
          entryCount: Array.isArray(event?.branchEntries) ? event.branchEntries.length : 0,
          willRetry: Boolean(event?.willRetry),
        })
      } catch (error) {
        context.logger.warn('[Agent Manager] session_before_compact hook failed:', error)
      }
      return undefined
    })
  }
}
