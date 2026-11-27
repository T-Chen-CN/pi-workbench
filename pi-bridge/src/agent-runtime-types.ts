/**
 * AgentManager 内部运行时类型、常量与纯辅助函数。
 * 从 `agent-manager.ts` 拆出，供事件投影、标题服务与主协调器共用。
 */

import * as path from 'path'
import type {
  AgentSession,
  ResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { SessionExtras } from './session-extras.js'
import type { StallWatchdog } from './stall-watchdog.js'
import { THINKING_LEVELS } from './model-config.js'
import { catalogLimits, type ModelLimits } from './provider-presets.js'
import { mergeAgentUsage, readMessageUsage } from './session-view.js'
import type {
  AgentLogger,
  AgentMessage,
  AgentTraceEvent,
  AgentUsage,
  FileEdit,
} from './types.js'

const AGENT_SHELL_SENSITIVE_KEYS = new Set([
  'PI_WORKBENCH_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
])
const AGENT_SHELL_SENSITIVE_PREFIXES = ['PI_WORKBENCH_']

/** 清洗 Agent 派生 shell 子进程的敏感环境变量（Windows 大小写不敏感），防止联网搜索 Key 经 bash 暴露 */
export function sanitizeAgentShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (AGENT_SHELL_SENSITIVE_KEYS.has(upper)) continue
    if (AGENT_SHELL_SENSITIVE_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue
    sanitized[key] = value
  }
  return sanitized
}

/** 未注入 logger 时保持原有 console 行为 */
export const consoleAgentLogger: AgentLogger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: (...args) => console.debug(...args),
}

/** 模型响应空闲超时（毫秒）：连续这么久没有任何模型增量才判定卡死；不设整轮上限 */
export const STALL_TIMEOUT_MS = 180_000
/** abort 之后等待 SDK 收尾的宽限期；超过后强制结束本轮，防止永久挂起 */
export const ABORT_GRACE_MS = 10_000
/** 调用 session.abort() 本身的等待上限，避免 dispose / 重启被卡住 */
export const ABORT_TIMEOUT_MS = 5_000
/** dispose 时等 extras 落盘的上限：退出流程不能被写盘卡死 */
export const EXTRAS_SAVE_TIMEOUT_MS = 1_000
/** 初始化（模型运行时 + 会话创建）超时 */
export const INIT_TIMEOUT_MS = 30_000
/** 单次工具审批的等待上限；超时按拒绝处理（fail-closed） */
export const APPROVAL_TIMEOUT_MS = 120_000
/** 标题结果不可用（空回复 / 纯推理）时的重试上限：超过就永久保留回退标题 */
export const TITLE_MAX_FAILURES = 3
/** 单次编辑 diff 快照的最大读取字节数（超过则跳过快照，防止大文件同步读盘阻塞/OOM） */
export const MAX_EDIT_SNAPSHOT_BYTES = 2 * 1024 * 1024

export interface SessionRuntime {
  id: string
  sessionManager: SessionManager
  session: AgentSession
  /** 提示模板 / 技能等资源的加载器（R-13） */
  resourceLoader: ResourceLoader | null
  unsubscribe: (() => void) | null
  isProcessing: boolean
  onTextDelta: ((delta: string) => void) | null
  /** 逐轮 trace 回调：只在 `chat()` 期间有效 */
  turnTrace: ((event: AgentTraceEvent) => void) | null
  /** 跨轮常驻订阅（事件唤醒的轮次没有 `chat()` 调用，只能靠它拿到流式事件） */
  traceSinks: Set<(event: AgentTraceEvent) => void>
  /** 统一分发入口：turnTrace + traceSinks。始终非空，plan 扩展也经由它上报 */
  onTrace: (event: AgentTraceEvent) => void
  /** 本轮的空闲超时看门狗；工具执行与审批等待期间自动挂起 */
  watchdog: StallWatchdog | null
  /** 事件唤醒轮次（sendCustomMessage triggerTurn）由 SDK 事件维护的运行态与后台看门狗 */
  sdkStreaming: boolean
  bgWatchdog: StallWatchdog | null
  /** 当前 assistant 消息中已经收到过增量的 thinking 块 */
  thinkingDeltaSeen: Set<number>
  /** 按 contentIndex 隔离的 thinking 计时起点，防止交错 thinking 块串台 */
  thinkingStarts: Map<number, number>
  /** write/edit 工具开始时的目标路径，供 tool_end 附带 */
  toolFiles: Map<string, string>
  editSnapshots: Map<string, { path: string; oldContent: string; existed: boolean }>
  pendingEdits: FileEdit[]
  messageHistory: AgentMessage[]
  createdAt: number
  updatedAt: number
  /** 自动标题只尝试一次 */
  titleAttempted: boolean
  /** 模型返回不可用结果（空回复 / 纯推理）的次数；超过上限就不再重试 */
  titleFailures: number
  /** 未落盘新会话的临时标题 */
  pendingTitle: string | null
  /** 会话注册的全部工具；模式在此之上计算激活集，不受历史影响 */
  registeredTools: string[]
  /** 会话附加数据（思考时长 / 历史工具 Diff） */
  extras: SessionExtras
  extrasSave: Promise<void>
  thinkingDurationsThisMessage: number[]
  /** 最近一次已转发的 compaction entry id，用于 compaction_end 去重取锚点 */
  lastCompactionEntryId: string | null
  /** 最近一次已落盘的 compaction entry 元信息，供手动压缩返回稳定锚点 */
  lastCompactionEntry: { id: string; timestamp?: number; tokensBefore?: number } | null
  /** 正在进行的手动压缩 Promise；并发 chat() 必须等待其结束再决定继续或终止 */
  compactingPromise: Promise<{ success: boolean; error?: string }> | null
}

/** 模型的生效容量（输出上限不得超过上下文窗口） */
export function effectiveLimits(model: { contextWindow?: number; maxTokens?: number }): ModelLimits {
  return catalogLimits(model)
}

/**
 * 模型支持的思考档位。`thinkingLevelMap` 里值为 null 表示该档不支持；
 * 整张表缺失时视为全部档位可用（老模型条目没有这张表）。
 */
export function thinkingLevelsOf(model: { thinkingLevelMap?: Record<string, unknown> }): string[] {
  const map = model.thinkingLevelMap
  if (!map) return [...THINKING_LEVELS]
  // pi-ai 稀疏表语义：只有显式 null 表示该档禁用，缺失键视为沿用默认支持
  return THINKING_LEVELS.filter((level) => map[level] !== null).map(String)
}

/** 空闲超时的统一错误文案（渲染层直接展示） */
export function stallErrorMessage(): string {
  return `Agent response stalled: no output for ${Math.round(STALL_TIMEOUT_MS / 1000)}s.`
}

/** 消息上的毫秒时间戳；测试夹具或老数据可能没有 */
export function messageTimestamp(message: any): number | null {
  const value = message?.timestamp
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 收集本轮新增的全部 assistant 消息（按出现顺序），供最后回复判定与多步 usage 累加共用 */
export function collectRunAssistants(
  messages: any[],
  startIndex: number,
  startedAt: number
): any[] {
  const matched: any[] = []
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    const timestamp = messageTimestamp(message)
    if (timestamp === null) {
      if (i >= startIndex) matched.push(message)
      continue
    }
    if (timestamp >= startedAt) matched.push(message)
  }
  return matched
}

/** 找本轮新增的最后一条 assistant 消息（兼容压缩重建后的下标偏移） */
export function findRunAssistant(messages: any[], startIndex: number, startedAt: number): any | null {
  const list = collectRunAssistants(messages, startIndex, startedAt)
  return list.length > 0 ? list[list.length - 1] : null
}

/** 累加本轮多步 assistant 消息的 token 与费用 */
export function aggregateTurnUsage(assistants: any[]): AgentUsage | undefined {
  let acc: AgentUsage | undefined
  for (const msg of assistants) {
    acc = mergeAgentUsage(acc, readMessageUsage(msg))
  }
  return acc
}

/** 把工具参数里的路径解析为绝对路径 */
export function resolveToolPath(toolPath: unknown, root?: string, fallbackRoot?: string): string | null {
  if (typeof toolPath !== 'string' || !toolPath) return null
  return path.isAbsolute(toolPath)
    ? toolPath
    : path.resolve(root ?? fallbackRoot ?? process.cwd(), toolPath)
}

/** 工具路径是否位于会话根目录内 */
export function isInsideWorkspace(targetPath: string, root?: string, fallbackRoot?: string): boolean {
  const base = root ?? fallbackRoot
  if (!base) return false
  const relative = path.relative(path.resolve(base), path.resolve(targetPath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** write/edit 的工具行可附带文件路径；其他工具不暴露文件 */
export function resolveToolFilePath(
  toolName: string,
  args: any,
  root?: string,
  fallbackRoot?: string
): string | undefined {
  if (toolName !== 'write' && toolName !== 'edit') return undefined
  const target = resolveToolPath(args?.path, root, fallbackRoot)
  if (!target || !isInsideWorkspace(target, root, fallbackRoot)) return undefined
  return target
}
