/**
 * ChatPanel 轮次控制与初始化状态的模块级注册表。
 *
 * 面板拆出/回位时 `PanelSlot` 会以 `key={host}` 卸载旧 `ChatPanel` 并挂载新实例；
 * 若停止标记、强制发送标记、预算提醒标记或提交回调放在组件 `useRef` 里，
 * 拆窗后的新实例点击「停止」无法影响旧实例仍在飞行的 `chat()` Promise，
 * 且旧实例收尾时会用陈旧闭包继续派发排队消息。
 */

import type { FormEvent } from 'react'
import type { AgentImagePayload } from '../types/electron'
import type { ChatAttachment } from '../store/chatStore'

export interface ChatSubmitOptions {
  skipUserMessage?: boolean
  targetSessionId?: string
  images?: AgentImagePayload[]
  attachments?: ChatAttachment[]
  consumeAttachments?: boolean
}

export type ChatSubmitHandler = (
  e?: FormEvent,
  override?: string,
  options?: ChatSubmitOptions
) => Promise<void>

const stoppedKeys = new Set<string>()
const forceSendKeys = new Set<string>()
const budgetWarnedKeys = new Set<string>()
const submitHandlers = new Map<string, ChatSubmitHandler>()
const initializedWorkspaces = new Map<string, { imageModels: string[] }>()

export function markTurnStopped(key: string): void {
  stoppedKeys.add(key)
}

export function clearTurnStopped(key: string): void {
  stoppedKeys.delete(key)
}

export function isTurnStopped(key: string): boolean {
  return stoppedKeys.has(key)
}

export function markForceSend(key: string): void {
  forceSendKeys.add(key)
}

export function clearForceSend(key: string): void {
  forceSendKeys.delete(key)
}

export function isForceSend(key: string): boolean {
  return forceSendKeys.has(key)
}

export function markBudgetWarned(key: string): void {
  budgetWarnedKeys.add(key)
}

export function clearBudgetWarned(key: string): void {
  budgetWarnedKeys.delete(key)
}

export function isBudgetWarned(key: string): boolean {
  return budgetWarnedKeys.has(key)
}

export function registerChatSubmitHandler(
  workspacePath: string,
  handler: ChatSubmitHandler
): void {
  submitHandlers.set(workspacePath, handler)
}

export function unregisterChatSubmitHandler(
  workspacePath: string,
  handler: ChatSubmitHandler
): void {
  if (submitHandlers.get(workspacePath) === handler) {
    submitHandlers.delete(workspacePath)
  }
}

export function getChatSubmitHandler(workspacePath: string): ChatSubmitHandler | undefined {
  return submitHandlers.get(workspacePath)
}

export function markWorkspaceChatInitialized(
  workspacePath: string,
  imageModels: string[]
): void {
  initializedWorkspaces.set(workspacePath, { imageModels: [...imageModels] })
}

export function clearWorkspaceChatInitialized(workspacePath: string): void {
  initializedWorkspaces.delete(workspacePath)
}

export function isWorkspaceChatInitialized(workspacePath: string): boolean {
  return initializedWorkspaces.has(workspacePath)
}

export function getWorkspaceChatImageModels(workspacePath: string): string[] {
  return initializedWorkspaces.get(workspacePath)?.imageModels ?? []
}

export function clearConversationTurnControl(key: string): void {
  stoppedKeys.delete(key)
  forceSendKeys.delete(key)
  budgetWarnedKeys.delete(key)
}

export function clearWorkspaceTurnControl(workspacePath: string): void {
  const prefix = `${workspacePath}\u0000`
  for (const key of [...stoppedKeys]) {
    if (key.startsWith(prefix)) stoppedKeys.delete(key)
  }
  for (const key of [...forceSendKeys]) {
    if (key.startsWith(prefix)) forceSendKeys.delete(key)
  }
  for (const key of [...budgetWarnedKeys]) {
    if (key.startsWith(prefix)) budgetWarnedKeys.delete(key)
  }
  submitHandlers.delete(workspacePath)
  initializedWorkspaces.delete(workspacePath)
}

export function resetAllChatTurnControl(): void {
  stoppedKeys.clear()
  forceSendKeys.clear()
  budgetWarnedKeys.clear()
  submitHandlers.clear()
  initializedWorkspaces.clear()
}
