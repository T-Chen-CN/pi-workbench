/**
 * Agent utilityProcess 通信协议（主进程 AgentHostClient ↔ utilityProcess agent-host-worker 共用）。
 *
 * 约束：零 `electron` 依赖，纯 TypeScript 类型与工具函数，供纯 Node Worker 与单元测试直接导入。
 */

import type { ModelOverrides } from 'pi-bridge'

export interface MessagePortLike {
  postMessage(message: unknown): void
  start?: () => void
  close?: () => void
  on?: (event: 'close' | 'message', listener: (...args: unknown[]) => void) => unknown
  once?: (event: 'close' | 'message', listener: (...args: unknown[]) => void) => unknown
}

export interface ParentPortMessageEvent {
  data: unknown
  ports?: readonly MessagePortLike[]
}

export interface ParentPortLike {
  on(event: 'message', listener: (event: ParentPortMessageEvent) => void): unknown
  off?: (event: 'message', listener: (event: ParentPortMessageEvent) => void) => unknown
  removeListener?: (event: 'message', listener: (event: ParentPortMessageEvent) => void) => unknown
  postMessage(message: unknown): void
}

/**
 * 主进程每次调用随帧同步给 Agent utilityProcess 的轻量快照。
 * 用于满足 pi-bridge 内部同步回调（`getLanguage` / `resolveSessionRoot` / `isSessionOfWorkspace` 等），
 * 避免跨进程阻塞或过期状态。
 */
export interface AgentHostSyncState {
  defaultPermissionLevel: unknown
  language: 'zh' | 'en'
  webAccessConfigVersion: string
  /** 已绑定到该工作区工作树协调器的会话 ID → 对应工作树根路径 */
  sessionRoots: Record<string, string>
  /** `PI_WORKBENCH_WEB_SEARCH_KEY_*` 环境变量增量，供内置 pi-web-access 扩展在配置更新后即时生效 */
  webSearchEnv?: Record<string, string | null>
}

/**
 * 初始化入参：严禁携带任何明文供应商 API Key / OAuth 凭证（凭证全部走受控 host RPC 按需读取）。
 */
export interface AgentHostInitPayload {
  workspaceDir: string
  agentDir: string
  apiConfig: {
    providerId: string
    modelId: string
    overrides?: Record<string, ModelOverrides>
  }
  allowModelNetwork: boolean
  webAccessExtensionPaths: string[]
  syncState: AgentHostSyncState
}

export type AgentHostRpcMethod =
  | 'initialize'
  | 'chat'
  | 'abort'
  | 'steer'
  | 'dispose'
  | 'requestSessionRoot'
  | 'listSessions'
  | 'openSession'
  | 'createSession'
  | 'closeSession'
  | 'renameSession'
  | 'deleteSession'
  | 'getContextUsage'
  | 'compactContext'
  | 'rewindToLastUser'
  | 'listBranches'
  | 'switchBranch'
  | 'getToolResultMeta'
  | 'readToolResultChunk'
  | 'getToolResultImage'
  | 'getToolResultText'
  | 'exportSessionMarkdown'
  | 'exportSessionHtml'
  | 'getSessionJsonlPath'
  | 'getModelCapabilities'
  | 'listPromptResources'
  | 'getPlan'
  | 'approvePlan'
  | 'rejectPlan'
  | 'getSessionSettings'
  | 'setSessionModel'
  | 'setSessionThinking'
  | 'setSessionPermission'
  | 'getSessionStats'
  | 'getSessionMessages'
  | 'getMessageHistory'
  | 'getCurrentSessionId'
  | 'hasRunningSessions'
  | 'credentials:runModify'

export type AgentHostCallbackMethod =
  | 'credentials:get'
  | 'credentials:set'
  | 'credentials:delete'
  | 'credentials:list'
  | 'credentials:has'
  | 'credentials:modify'
  | 'models:read'
  | 'models:write'
  | 'models:delete'
  | 'models:snapshot'
  | 'models:snapshotFor'
  | 'readDocument'
  | 'requestApproval'
  | 'resolveSessionRoot'
  | 'isSessionOfWorkspace'
  | 'getWorktreeContext'
  | 'onWorktreeSwitch'
  | 'getDefaultPermissionLevel'
  | 'getLanguage'
  | 'getWebAccessConfigVersion'

export type AgentHostEventName =
  | 'session-title'
  | 'session-root-changed'
  | 'agent-settled'
  | 'log'

export interface AgentChatRpcInput {
  sessionId?: string
  message: string
  requestId?: string
  images?: Array<{ data: string; mimeType: string }>
}

export interface AgentStreamWirePayload {
  requestId?: string
  workspaceDir: string
  sessionId?: string
  type: string
  [key: string]: unknown
}

export type MainToAgentWorkerMessage =
  | {
      type: 'rpc:req'
      id: number
      method: AgentHostRpcMethod
      args: readonly unknown[]
      syncState?: AgentHostSyncState
    }
  | {
      type: 'host:res'
      callId: number
      ok: boolean
      result?: unknown
      error?: string
      syncState?: AgentHostSyncState
    }
  | {
      type: 'attach-stream-port'
      portId: string
    }
  | {
      type: 'detach-stream-port'
      portId: string
    }
  | {
      type: 'sync-state'
      syncState: AgentHostSyncState
    }

export type AgentWorkerToMainMessage =
  | {
      type: 'ready'
    }
  | {
      type: 'rpc:res'
      id: number
      ok: boolean
      result?: unknown
      error?: string
      currentSessionId?: string | null
      runningSessionIds?: string[]
    }
  | {
      type: 'host:req'
      callId: number
      method: AgentHostCallbackMethod
      payload: unknown
    }
  | {
      type: 'host:event'
      event: AgentHostEventName
      payload: unknown
    }
  | {
      type: 'running-sessions-changed'
      runningSessionIds: string[]
      currentSessionId: string | null
    }
  | {
      type: 'stream-event'
      payload: AgentStreamWirePayload
    }

/** 序列化跨进程日志参数，避免不可克隆对象（Error / 函数 / DOM）导致 postMessage 抛错 */
export function serializeLogArgs(args: readonly unknown[]): unknown[] {
  return args.map((item) => {
    if (item instanceof Error) {
      return item.stack ?? item.message
    }
    if (
      item === null ||
      item === undefined ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      return item
    }
    try {
      return JSON.parse(JSON.stringify(item)) as unknown
    } catch {
      return String(item)
    }
  })
}
