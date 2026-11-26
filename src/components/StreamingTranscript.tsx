/**
 * 基于 `use-stick-to-bottom` 的统一流式会话滚动容器（桌面云端页 + 云端 Web 共用）。
 *
 * - 内容区高度变化（流式打字、代码高亮完成、公式/Mermaid 渲染、思考块展开）由 ResizeObserver 自动跟底；
 * - 用户一旦上滑立即解锁，绝不抢滚轮；距底超过 120px 时浮出「回到底部 / N 条新消息」按钮；
 * - 支持 `Alt+↓` 快捷回底与发送前通过 ref 强制贴底；无 ResizeObserver 环境（jsdom）自动降级为原生滚动。
 */

import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { distanceFromBottom, shouldFollow, shouldShowScrollButton } from '../hooks/chatScroll'

export interface StreamingTranscriptHandle {
  scrollToBottom: () => void
}

export interface StreamingTranscriptProps {
  /** 消息条目数量：离开底部时收到新消息用于累计「N 条新消息」提示 */
  messageCount: number
  scrollToBottomLabel: string
  newMessagesLabel: (count: number) => string
  className?: string
  contentClassName?: string
  children: React.ReactNode
}

const StickToBottomTranscript = React.forwardRef<
  StreamingTranscriptHandle,
  StreamingTranscriptProps
>(function StickToBottomTranscript(
  {
    messageCount,
    scrollToBottomLabel,
    newMessagesLabel,
    className = 'min-h-0 flex-1 overflow-y-auto px-5 py-4',
    contentClassName = 'flex flex-col gap-4',
    children,
  },
  ref
) {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    initial: 'instant',
    resize: 'instant',
  })
  const [showButton, setShowButton] = useState(false)
  const [newCount, setNewCount] = useState(0)
  const lastCountRef = useRef(messageCount)

  const pinToBottom = useCallback(() => {
    setShowButton(false)
    setNewCount(0)
    void scrollToBottom('instant')
  }, [scrollToBottom])

  useImperativeHandle(ref, () => ({ scrollToBottom: pinToBottom }), [pinToBottom])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const sync = () => {
      const distance = distanceFromBottom(element)
      setShowButton(shouldShowScrollButton(distance))
      if (shouldFollow(distance)) setNewCount(0)
    }
    sync()
    element.addEventListener('scroll', sync, { passive: true })
    return () => element.removeEventListener('scroll', sync)
  }, [scrollRef, messageCount])

  useEffect(() => {
    if (isAtBottom) {
      setNewCount(0)
      setShowButton(false)
    }
  }, [isAtBottom])

  useEffect(() => {
    const previous = lastCountRef.current
    lastCountRef.current = messageCount
    if (messageCount > previous && !isAtBottom) {
      setNewCount((count) => count + (messageCount - previous))
    } else if (messageCount <= previous) {
      setNewCount(0)
    }
  }, [messageCount, isAtBottom])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && event.key === 'ArrowDown') {
        event.preventDefault()
        pinToBottom()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pinToBottom])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className={className}>
        <div ref={contentRef} className={contentClassName}>
          {children}
        </div>
      </div>
      {showButton && (
        <button
          type="button"
          onClick={pinToBottom}
          className="absolute bottom-3 right-4 z-10 flex items-center gap-1 border border-line bg-raised px-2 py-1 type-caption text-ink-muted shadow-print transition-colors hover:text-ink"
        >
          <ArrowDown size={12} aria-hidden="true" />
          {newCount > 0 ? newMessagesLabel(newCount) : scrollToBottomLabel}
        </button>
      )}
    </div>
  )
})

const FallbackTranscript = React.forwardRef<StreamingTranscriptHandle, StreamingTranscriptProps>(
  function FallbackTranscript(
    {
      messageCount,
      scrollToBottomLabel,
      newMessagesLabel,
      className = 'min-h-0 flex-1 overflow-y-auto px-5 py-4',
      contentClassName = 'flex flex-col gap-4',
      children,
    },
    ref
  ) {
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const stickRef = useRef(true)
    const lastCountRef = useRef(messageCount)
    const [showButton, setShowButton] = useState(false)
    const [newCount, setNewCount] = useState(0)

    const pinToBottom = useCallback(() => {
      stickRef.current = true
      setShowButton(false)
      setNewCount(0)
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    }, [])

    useImperativeHandle(ref, () => ({ scrollToBottom: pinToBottom }), [pinToBottom])

    useEffect(() => {
      const previous = lastCountRef.current
      lastCountRef.current = messageCount
      if (stickRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      } else if (messageCount > previous) {
        setNewCount((count) => count + (messageCount - previous))
      }
    }, [messageCount])

    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className={className}
          onScroll={() => {
            const element = scrollRef.current
            if (!element) return
            const distance = distanceFromBottom(element)
            stickRef.current = shouldFollow(distance)
            setShowButton(shouldShowScrollButton(distance))
            if (stickRef.current) setNewCount(0)
          }}
        >
          <div className={contentClassName}>{children}</div>
        </div>
        {showButton && (
          <button
            type="button"
            onClick={pinToBottom}
            className="absolute bottom-3 right-4 z-10 flex items-center gap-1 border border-line bg-raised px-2 py-1 type-caption text-ink-muted shadow-print transition-colors hover:text-ink"
          >
            <ArrowDown size={12} aria-hidden="true" />
            {newCount > 0 ? newMessagesLabel(newCount) : scrollToBottomLabel}
          </button>
        )}
      </div>
    )
  }
)

export const StreamingTranscript = React.forwardRef<
  StreamingTranscriptHandle,
  StreamingTranscriptProps
>(function StreamingTranscript(props, ref) {
  if (typeof ResizeObserver === 'undefined') {
    return <FallbackTranscript ref={ref} {...props} />
  }
  return <StickToBottomTranscript ref={ref} {...props} />
})
