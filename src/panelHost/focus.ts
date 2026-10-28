/**
 * 「当前正在被操作的宿主窗口」。
 *
 * toast / dialog 需要一个落点：用户在哪一类窗口里操作，提示就出现在哪。
 * 用可替换的 resolver 而不是直接读 store，避免 toastStore ↔ panelStore 循环依赖。
 */

import { MAIN_HOST } from './types'

let resolver: () => string = () => MAIN_HOST

export function setFocusedHostResolver(next: () => string): void {
  resolver = next
}

/** 焦点所在宿主；没有辅助窗口获得焦点时回落到主窗口 */
export function focusedHostId(): string {
  try {
    return resolver() || MAIN_HOST
  } catch {
    return MAIN_HOST
  }
}
