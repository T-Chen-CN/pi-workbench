/**
 * 聊天消息区滚动与贴底跟随（遵循 chatScroll 约定：距底 < 64px 才自动跟随流式输出）。
 * 封装虚拟列表挂载、容器尺寸变化补贴底、未读新消息计数与 Alt+↓ 快捷回底。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../store/chatStore'
import { useSessionStore } from '../store/sessionStore'
import { useVirtualRows } from './useVirtualRows'
import { useHostKeydown } from '../panelHost/HostContext'
import {
  distanceFromBottom,
  pinToBottom as pinChatToBottom,
  shouldFollow,
  shouldShowScrollButton,
} from './chatScroll'

export interface UseChatScrollParams {
  messages: ChatMessage[]
  activeKey: string | null
  activeSessionId: string | null
  workspacePath: string
  active: boolean
  onSessionSwitch?: () => void
}

export function useChatScroll(params: UseChatScrollParams) {
  const { messages, activeKey, activeSessionId, workspacePath, active, onSessionSwitch } = params

  const [showScrollButton, setShowScrollButton] = useState(false)
  const [newMessageCount, setNewMessageCount] = useState(0)
  const lastMessageCountRef = useRef(0)
  const stickToBottomRef = useRef(true)

  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const getItemKey = useCallback(
    (index: number) => {
      const msg = messagesRef.current[index]
      return msg ? `${activeKey ?? ''}:${msg.id}` : `${activeKey ?? ''}:${index}`
    },
    [activeKey]
  )

  const { parentRef: transcriptRef, virtualizer } = useVirtualRows({
    count: messages.length,
    estimateSize: 96,
    overscan: 8,
    getItemKey,
  })

  /** 贴到滚动容器真实底部（消息列表之外的提示 / 错误块也算在内） */
  const pinToBottom = useCallback(() => {
    const element = transcriptRef.current
    // 容器隐藏时 clientHeight 为 0，写入 scrollTop 会被钳回顶部；等恢复可见再补
    if (!element || element.clientHeight === 0) return
    pinChatToBottom(element)
  }, [transcriptRef])

  /** 回到底部并恢复跟随（发送消息、Alt+↓、点击回底按钮共用） */
  const scrollToBottom = useCallback(() => {
    stickToBottomRef.current = true
    setShowScrollButton(false)
    setNewMessageCount(0)
    if (messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
    }
    pinToBottom()
    // 新行首帧只有 estimateSize 占位，measure 完成后总高度会变；下一帧按真实高度再贴一次
    requestAnimationFrame(() => {
      if (!stickToBottomRef.current) return
      pinToBottom()
    })
  }, [messages.length, pinToBottom, virtualizer])

  /** 供挂载 / 尺寸回调等非渲染期执行路径调用，避免闭包过期 */
  const scrollToBottomRef = useRef(scrollToBottom)
  scrollToBottomRef.current = scrollToBottom

  const onSessionSwitchRef = useRef(onSessionSwitch)
  onSessionSwitchRef.current = onSessionSwitch

  // 激活会话切换时回到最新位置、清除回底按钮与未读计数
  useEffect(() => {
    stickToBottomRef.current = true
    lastMessageCountRef.current = messagesRef.current.length
    setShowScrollButton(false)
    setNewMessageCount(0)
    const key = activeKey
    if (!key) return
    useSessionStore.getState().markUnread(workspacePath, activeSessionId!, false)
    onSessionSwitchRef.current?.()
  }, [activeKey, activeSessionId, workspacePath])

  // 贴底时才跟随内容增长（流式输出、新消息、列表外的提示块）
  useEffect(() => {
    if (!stickToBottomRef.current || messages.length === 0) return
    virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
    pinToBottom()
    const frame = requestAnimationFrame(() => {
      if (!stickToBottomRef.current) return
      pinToBottom()
    })
    return () => cancelAnimationFrame(frame)
  }, [messages, virtualizer, pinToBottom, activeKey])

  // 容器与内容区尺寸变化（面板展开、拆窗接入、窗口缩放、Mermaid/KaTeX/代码块异步增高）时补一次贴底：
  // 不依赖 messages.length，避免每来一条消息就销毁重建 ResizeObserver
  useEffect(() => {
    const element = transcriptRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    let height = element.clientHeight
    let scrollHeight = element.scrollHeight
    const observer = new ResizeObserver(() => {
      const nextHeight = element.clientHeight
      const nextScrollHeight = element.scrollHeight
      const changed = nextHeight !== height || nextScrollHeight !== scrollHeight
      height = nextHeight
      scrollHeight = nextScrollHeight
      if (changed && nextHeight > 0 && stickToBottomRef.current) pinToBottom()
    })
    observer.observe(element)
    const contentChild = element.firstElementChild
    if (contentChild) observer.observe(contentChild)
    return () => observer.disconnect()
  }, [transcriptRef, activeSessionId, pinToBottom])

  const handleTranscriptScroll = () => {
    const element = transcriptRef.current
    if (!element) return
    // 布局未就绪（容器隐藏时 clientHeight 为 0）不参与判定，否则会把跟随状态误置为 false
    const distance = distanceFromBottom(element)
    stickToBottomRef.current = shouldFollow(distance)
    setShowScrollButton(shouldShowScrollButton(distance))
    if (stickToBottomRef.current) setNewMessageCount(0)
  }

  useEffect(() => {
    const previous = lastMessageCountRef.current
    lastMessageCountRef.current = messages.length
    if (messages.length > previous && previous > 0 && !stickToBottomRef.current) {
      setNewMessageCount((count) => count + (messages.length - previous))
    }
  }, [messages.length])

  useHostKeydown(
    (event) => {
      if (event.altKey && event.key === 'ArrowDown') {
        event.preventDefault()
        scrollToBottom()
      }
    },
    [messages.length],
    active
  )

  return {
    transcriptRef,
    virtualizer,
    stickToBottomRef,
    showScrollButton,
    newMessageCount,
    scrollToBottom,
    scrollToBottomRef,
    handleTranscriptScroll,
  }
}
