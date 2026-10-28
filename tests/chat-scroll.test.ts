import { describe, expect, it } from 'vitest'
import {
  FOLLOW_THRESHOLD_PX,
  SCROLL_BUTTON_THRESHOLD_PX,
  distanceFromBottom,
  pinToBottom,
  shouldFollow,
  shouldShowScrollButton,
} from '../src/hooks/chatScroll'

describe('chat scroll follow', () => {
  it('measures distance from the real bottom', () => {
    expect(distanceFromBottom({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 500 })).toBe(0)
    expect(distanceFromBottom({ scrollHeight: 2000, scrollTop: 1400, clientHeight: 500 })).toBe(100)
  })

  it('never reports a negative distance when scrolled past the end', () => {
    expect(distanceFromBottom({ scrollHeight: 2000, scrollTop: 3000, clientHeight: 500 })).toBe(0)
  })

  it('treats a zero-height container as pinned instead of scrolled away', () => {
    // 面板收起 / 标签页切走时 clientHeight 为 0，滚动位置无法计算
    expect(distanceFromBottom({ scrollHeight: 2000, scrollTop: 0, clientHeight: 0 })).toBe(0)
    expect(shouldFollow(distanceFromBottom({ scrollHeight: 2000, scrollTop: 0, clientHeight: 0 }))).toBe(
      true
    )
  })

  it('follows only inside the threshold', () => {
    expect(shouldFollow(FOLLOW_THRESHOLD_PX - 1)).toBe(true)
    expect(shouldFollow(FOLLOW_THRESHOLD_PX)).toBe(false)
    expect(shouldFollow(9999)).toBe(false)
  })

  it('shows the scroll button only past the larger threshold', () => {
    expect(shouldShowScrollButton(FOLLOW_THRESHOLD_PX)).toBe(false)
    expect(shouldShowScrollButton(SCROLL_BUTTON_THRESHOLD_PX)).toBe(false)
    expect(shouldShowScrollButton(SCROLL_BUTTON_THRESHOLD_PX + 1)).toBe(true)
  })

  it('pins to the full scroll height, including content outside the virtual list', () => {
    const element = { scrollTop: 0, scrollHeight: 4321 }
    pinToBottom(element)
    expect(element.scrollTop).toBe(4321)
    expect(() => pinToBottom(null)).not.toThrow()
  })
})
