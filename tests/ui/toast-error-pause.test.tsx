/**
 * Error Toast 8 秒自动消失与悬停/聚焦暂停回归（D8）。
 */

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TOAST_DURATION_MS,
  ERROR_TOAST_DURATION_MS,
  ToastContainer,
  type ToastMessage,
} from '../../src/components/ui/Toast'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('Toast auto-dismiss & error hover/focus pause (D8)', () => {
  it('keeps success and info toasts at 3s auto-dismiss with role="status"', () => {
    const onClose = vi.fn()
    const messages: ToastMessage[] = [
      { id: 'ok-1', message: '已保存', type: 'success' },
      { id: 'info-1', message: '已同步', type: 'info' },
    ]

    render(<ToastContainer messages={messages} onClose={onClose} />)

    const statuses = screen.getAllByRole('status')
    expect(statuses).toHaveLength(2)

    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS - 100)
    })
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(100 + 200)
    })
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalledWith('ok-1')
    expect(onClose).toHaveBeenCalledWith('info-1')
  })

  it('renders error toast with role="alert" + aria-live="assertive" and defaults to 8s timeout', () => {
    const onClose = vi.fn()
    const messages: ToastMessage[] = [{ id: 'err-1', message: '写入失败', type: 'error' }]

    render(<ToastContainer messages={messages} onClose={onClose} />)

    const alert = screen.getByRole('alert')
    expect(alert.getAttribute('aria-live')).toBe('assertive')

    // 超过常规 3s 仍保持可见
    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS + 1000)
    })
    expect(onClose).not.toHaveBeenCalled()

    // 7900ms 仍未关闭
    act(() => {
      vi.advanceTimersByTime(ERROR_TOAST_DURATION_MS - DEFAULT_TOAST_DURATION_MS - 1100)
    })
    expect(onClose).not.toHaveBeenCalled()

    // 到达 8000ms + 退场动画后关闭
    act(() => {
      vi.advanceTimersByTime(100 + 200)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith('err-1')
  })

  it('pauses error toast countdown on mouse hover and resumes remaining time on leave', () => {
    const onClose = vi.fn()
    const messages: ToastMessage[] = [{ id: 'err-hover', message: '网络断开', type: 'error' }]

    render(<ToastContainer messages={messages} onClose={onClose} />)
    const alert = screen.getByRole('alert')

    // 经过 3000ms，剩余 5000ms
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    fireEvent.mouseEnter(alert)

    // 悬停 20 秒期间绝不自动消失
    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(onClose).not.toHaveBeenCalled()

    // 移出鼠标后只走剩余 5000ms
    fireEvent.mouseLeave(alert)
    act(() => {
      vi.advanceTimersByTime(4900)
    })
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(100 + 200)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith('err-hover')
  })

  it('pauses error toast countdown on focus and resumes remaining time on blur', () => {
    const onClose = vi.fn()
    const messages: ToastMessage[] = [{ id: 'err-focus', message: '鉴权失效', type: 'error' }]

    render(<ToastContainer messages={messages} onClose={onClose} />)
    const alert = screen.getByRole('alert')
    const closeBtn = alert.querySelector('button')!

    // 经过 5000ms，剩余 3000ms
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    fireEvent.focus(closeBtn)

    // 聚焦期间不关闭
    act(() => {
      vi.advanceTimersByTime(15_000)
    })
    expect(onClose).not.toHaveBeenCalled()

    // 焦点在 toast 内部流转时不恢复倒计时
    fireEvent.blur(alert, { relatedTarget: closeBtn })
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(onClose).not.toHaveBeenCalled()

    // 真正失焦后走完剩余 3000ms
    fireEvent.blur(closeBtn, { relatedTarget: document.body })
    act(() => {
      vi.advanceTimersByTime(2900)
    })
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(100 + 200)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith('err-focus')
  })

  it('stays paused while either hover or focus is active', () => {
    const onClose = vi.fn()
    const messages: ToastMessage[] = [{ id: 'err-both', message: '保存冲突', type: 'error' }]

    render(<ToastContainer messages={messages} onClose={onClose} />)
    const alert = screen.getByRole('alert')
    const closeBtn = alert.querySelector('button')!

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    fireEvent.mouseEnter(alert)
    fireEvent.focus(closeBtn)

    // 移出鼠标但仍聚焦 → 继续暂停
    fireEvent.mouseLeave(alert)
    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    expect(onClose).not.toHaveBeenCalled()

    // 失焦后恢复剩余 6000ms
    fireEvent.blur(closeBtn, { relatedTarget: document.body })
    act(() => {
      vi.advanceTimersByTime(5900)
    })
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(100 + 200)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
