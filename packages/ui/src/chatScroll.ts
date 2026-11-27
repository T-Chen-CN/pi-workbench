/**
 * 聊天记录滚动跟随的判定与贴底动作。
 *
 * 抽成纯函数的原因：`scrollHeight / clientHeight` 在 jsdom 里没有布局，
 * 判定逻辑必须能脱离真实滚动容器单独验证。
 */

/** 距底小于该值视为贴底（继续跟随新内容） */
export const FOLLOW_THRESHOLD_PX = 64
/** 距底超过该值才显示「回到底部」按钮，避免轻微抖动 */
export const SCROLL_BUTTON_THRESHOLD_PX = 120

export interface ScrollMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

/** 距底部像素数；布局未就绪（高度为 0）时返回 0，避免误判为“已上滑” */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  if (metrics.clientHeight <= 0) return 0
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight)
}

/** 是否应继续跟随新内容 */
export function shouldFollow(distance: number): boolean {
  return distance < FOLLOW_THRESHOLD_PX
}

/** 是否显示「回到底部」 */
export function shouldShowScrollButton(distance: number): boolean {
  return distance > SCROLL_BUTTON_THRESHOLD_PX
}

/** 贴到滚动容器真实底部（消息行之外的提示 / 错误块也算在内） */
export function pinToBottom(element: { scrollTop: number; scrollHeight: number } | null): void {
  if (!element) return
  element.scrollTop = element.scrollHeight
}
