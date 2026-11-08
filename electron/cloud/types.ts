/**
 * 云端 Agent 的数据模型（主进程侧副本）。
 *
 * 与 `src/types/cloud.ts` 结构完全一致：主进程 tsconfig 的 rootDir 是 electron/，
 * 不能直接引用 src/ 下的文件。两边一致性由 tests/cloud-types.test.ts 的类型断言守住。
 */

/**
 * 云端 Hermes Agent 的前端数据模型。
 *
 * 与本地 Agent（AgentTracePart）刻意独立：云端后端只提供 messages + SSE 事件，
 * 没有计划 / 压缩 / 审批队列之外的本地概念。字段命名保持与本地一致，
 * 方便两套时间线组件观感统一。
 */

/** 连接状态：未配置（没有 token）→ connecting → connected / error */
export type CloudConnectionState = 'unconfigured' | 'connecting' | 'connected' | 'error'

export interface CloudConnectionInfo {
  /** 网关（单入口）地址：本地唯一出口，没有直连兜底 */
  gatewayUrl: string
  dashboardUrl: string
  /** 设备 token 是否已就位（渲染层只能知道有没有） */
  hasDeviceToken: boolean
  deviceScopes: string[]
  deviceId: string
}

/** 本机设备身份（`cloud:device:get` 的返回）。`id` 只读，`name` 可改 */
export interface CloudDeviceSummary {
  /** 本机生成的 uuid —— 认设备用它，不随改名变化 */
  id: string
  /** 显示名；每轮请求作为 `author.name` 发出 */
  name: string
  /** 系统给出的默认名（输入清空时回到这里） */
  defaultName: string
}

/**
 * `POST /v1/runs` 的 `author`：上游注释写明 "memory-attribution label only; grants nothing"。
 * 只影响记忆归属与审计，**不进 prompt**、不构成任何授权。
 */
export interface CloudDeviceAuthor {
  /** `pi-workbench/<uuid>`，斜杠只是命名空间分隔，不含用户可控内容 */
  id: string
  name: string
  is_bot: false
}

/** 后端 /v1/capabilities 的子集（只取前端实际用到的） */
export interface CloudCapabilities {
  platform?: string
  model?: string
  runStop?: boolean
  runSteer?: boolean
  approvalEvents?: boolean
  runApprovalResponse?: boolean
}

export type CloudRunStatus =
  | 'queued'
  | 'started'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** 主人进程丢了（owner epoch 丢失）：非终态，等 POST /v1/runs/{id}/resolve-unknown 收尾 */
  | 'unknown'

/** 未结算账本条目：这一轮"出去了就收不回来"的动作 */
/** 自检里的一项健康检查（`/health/detailed` 的 readiness.checks） */
export interface CloudDiagnosticCheck {
  name: string
  status: string
  /** 人话补充（磁盘占用、队列深度…） */
  detail?: string
}

/** 工具集一行：`enabled` 是开关，`configured` 是有没有装好依赖，两件事别混 */
export interface CloudDiagnosticToolset {
  name: string
  label: string
  enabled: boolean
  configured: boolean
  tools: string[]
}

/** 自检结果：每块独立成败，一块挂了不影响其它块显示 */
export interface CloudDiagnostics {
  fetchedAt: number
  version?: string
  platform?: string
  gatewayState?: string
  readiness: { ok: boolean; error?: string; checks: CloudDiagnosticCheck[] }
  toolsets: { ok: boolean; error?: string; items: CloudDiagnosticToolset[] }
  skills: { ok: boolean; error?: string; names: string[] }
  models: { ok: boolean; error?: string; items: string[] }
}

/** 定时任务的最近一次执行（服务端 executions 表的一行） */
export interface CloudJobExecution {
  id?: string
  status?: string
  claimedAt?: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

/** 定时任务（`/api/jobs` 的归一化记录，字段按服务端 `_normalize_job_record` 取） */
export interface CloudJob {
  id: string
  name: string
  prompt: string
  /** 原始调度表达式（`30m` / `0 9 * * *` / ISO 时间） */
  schedule: string
  /** 服务端给的人话版本（`every 30m`） */
  scheduleDisplay: string
  /** `scheduled` | `paused` | `completed` | `error`（服务端 `effective_job_state`） */
  state: string
  enabled: boolean
  nextRunAt?: string
  lastRunAt?: string
  repeat?: number | null
  pausedReason?: string
  latestExecution?: CloudJobExecution
  liveExecution?: CloudJobExecution
}

/**
 * 新建任务时交给服务端的草稿（`POST /api/jobs` 的 body 子集）。
 *
 * `deliver` 不暴露：桌面端只关心任务本身，投递用服务端默认的 `local`。
 */
export interface CloudJobDraft {
  name: string
  /** 调度表达式：`30m` / `every 2h` / `in 30m` / `0 9 * * *` / ISO 时间 */
  schedule: string
  /** 每次要 Agent 执行的提示词 */
  prompt: string
  /** 最多跑几次；不填表示不限次 */
  repeat?: number
}

export type CloudWriteClass = 'external' | 'system' | 'irreversible'

export type CloudWriteStatus =
  | 'pending'
  | 'done'
  | 'failed'
  | 'unknown'
  | 'confirmed_done'
  | 'confirmed_missing'
  | 'ignored'

export interface CloudPendingWrite {
  /** `runId:toolCallId` */
  id: string
  runId: string
  sessionId: string | null
  toolName: string
  writeClass: CloudWriteClass
  /** 命令摘要（命令文本会被截断到 300 字符） */
  summary: string
  startedAt: number
  status: CloudWriteStatus
  settledAt?: number
  confirmedAt?: number
  /** 由历史消息推断出来的结果（不是亲眼看到回执） */
  inferred?: boolean
}

/** 会话列表行（GET /api/sessions 的条目，只保留前端展示用到的字段） */
export interface CloudSession {
  id: string
  title: string
  preview: string
  /** epoch 毫秒 */
  lastActive: number
  startedAt: number
  messageCount: number
  toolCallCount: number
  inputTokens: number
  outputTokens: number
  /** 实际花费优先，缺失时用估算值（美元） */
  costUsd: number
  model: string
  /** 子会话（delegation / cron 产生的） */
  parentSessionId: string | null
  pinned: boolean
  archived: boolean
}

export type CloudToolStatus = 'running' | 'success' | 'error'

/** 时间线单元。历史与流式事件映射到同一套形状。 */
/**
 * 子代理轨道：一次 `delegate_task` 派出去的子任务。
 *
 * 事件来自 SSE 的 `subagent.start` / `subagent.complete`；**历史消息里没有**
 * （`/api/sessions/:id/messages` 只有工具行），所以重开会话只能看到空档，
 * 这一层要在 UI 上说明，而不是假装没有子代理。
 */
export type CloudSubagentStatus = 'running' | 'completed' | 'failed' | 'timeout'

/**
 * 审批回执（服务端 `choices` 的子集）。
 * 故意不含 `always`：它会把命令写进服务端永久白名单（`S-08` 禁止），映射层就丢弃。
 */
export type CloudApprovalChoice = 'once' | 'session' | 'deny'

/** 原生审批档位（`approvals.mode`）。不自造预设，就用这三个 */
export type CloudApprovalMode = 'manual' | 'smart' | 'off'

/** 服务端当前生效的审批策略（白名单子集：只读，不含任何密钥） */
export interface CloudApprovalPolicy {
  /** 读不到或值不认识时为 null（UI 显示「未知」，不猜） */
  mode: CloudApprovalMode | null
  timeoutSeconds: number | null
  /** `approvals.deny` 的条数（**只计数，不留内容**） */
  denyCount: number
  disabledToolsets: string[]
  terminalBackend: string
}

export type CloudTracePart =
  | { type: 'text'; id: string; role: 'user' | 'assistant'; text: string }
  | { type: 'thinking'; id: string; text: string; redacted?: boolean }
  | {
      type: 'tool'
      id: string
      toolCallId: string
      toolName: string
      argsSummary: string
      status: CloudToolStatus
      resultPreview?: string
      exitCode?: number
      durationMs?: number
    }
  | {
      type: 'approval'
      id: string
      /**
       * 服务端 `prompt_id` / `request_id`。拿不到时退化为 **runId**：两者都能
       * 唯一定位一轮里的待决请求，而合成序号会让 `approval.responded` 匹配不上。
       */
      requestId: string
      /** 应答时要带（canonical 语义）；run-scoped 语义下没有 */
      generation?: number
      /**
       * 这条审批拦下的工具调用（审批请求总是紧跟在 `tool.started` 之后）。
       * 审计的「真实结果」靠它对上号，断流后从历史补结果也靠它。
       */
      toolCallId?: string
      /** 命令原文（卡片正文） */
      command: string
      /** 命中的危险模式（审计与 UI 都用它） */
      patternKeys: string[]
      /** 已剔除 `always` 的可选项 */
      choices: CloudApprovalChoice[]
      /** 后端给的等待秒数（实机不给，由配置 `approvals.timeout` 兜底） */
      timeoutSeconds?: number
      /** 卡片建立时刻：没有 `timeoutSeconds` 时用它 + 策略里的超时算倒计时 */
      requestedAt?: number
      /** 截止时刻（`requestedAt + timeoutSeconds`）：倒计时用绝对时间，重渲染不重置 */
      expiresAt?: number
      /** 本地做出的决定（回填点） */
      decision?: CloudApprovalChoice
      decidedAt?: number
      /** 本地判定超时：服务端随后按其 `approvals.timeout` 拒绝 */
      expiredAt?: number
      /** 后端已结算，但不是本地点的那一下（超时 / 别的客户端） */
      settled?: boolean
    }
  | {
      type: 'interjection'
      id: string
      text: string
      /** 服务端确认已投递（run.steered）；false 时还在路上 */
      delivered: boolean
      /** 本轮结束时仍未投递（终态里的 pending_steer） */
      undelivered?: boolean
    }
  | {
      type: 'clarify'
      id: string
      promptId: string
      /** 应答必须带上，否则后端 stale_generation */
      generation: number
      question: string
      /** 空数组表示纯自由回答 */
      choices: string[]
      multiSelect?: boolean
      timeoutSeconds?: number
      /** 已提交的答案（乐观写入，失败会撤回） */
      answer?: string
      /** 后端已结算：可能是我们答的，也可能是超时或被别的端答了 */
      settled?: boolean
    }
  | {
      type: 'subagent'
      id: string
      goal: string
      status: CloudSubagentStatus
      subagentId?: string
      delegationId?: string
      taskIndex?: number
      taskCount?: number
      model?: string
      toolCount?: number
      summary?: string
      durationMs?: number
      inputTokens?: number
      outputTokens?: number
      reasoningTokens?: number
      apiCalls?: number
      costUsd?: number
      filesRead?: number
      filesWritten?: number
      /** 子代理最后几条工具输出的尾巴（服务端已脱敏并截断） */
      outputTail?: string
      /** 失败分类（服务端给的 verdict） */
      failureReason?: string
      childSessionId?: string
    }
  | {
      type: 'divider'
      id: string
      kind: 'session_meta' | 'disconnect' | 'run_error' | 'reattach'
      detail?: string
    }

/** 云端会话导出格式：md / 自带样式 HTML / 原始片段 JSON */
export type CloudExportFormat = 'md' | 'html' | 'json'

/** 一轮的 token 用量（终态帧里给，字段名照抄上游） */
export interface CloudRunUsage {
  input: number
  output: number
  total?: number
}

/** 帧的来源：属于哪个会话。并行轮次时渲染层靠它把别的会话的帧丢掉 */
export interface CloudFrameOrigin {
  sessionId?: string | null
}

/** 主进程 → 渲染层的事件帧 */
export type CloudFrame = CloudFrameOrigin &
  (
  /** 全量替换（打开会话的历史 / 轮次结束后的校正） */
  | { kind: 'parts'; parts: CloudTracePart[] }
  /** 增量：按 id 覆盖或追加 */
  | { kind: 'part'; part: CloudTracePart }
  | {
      kind: 'run'
      runId: string
      state: CloudRunStatus
      error?: string
      /** 终态帧里的用量：tokens 是「这一轮」的，不是累计 */
      usage?: CloudRunUsage
      /** 这一轮实际用的模型（上游没填就没有） */
      model?: string | null
      /** 上游说这一轮的输出被截断了：不能当正常完成 */
      partial?: boolean
      /** 上游说这一轮被打断（超时 / 关停），输出不完整 */
      interrupted?: boolean
    }
  /** 新会话的 id：第一条消息发出后由主进程回填 */
  | { kind: 'session'; sessionId: string }
  | { kind: 'error'; runId: string; error: string }
)

export interface CloudDashboardState {
  visible: boolean
  loading: boolean
  url: string
  error: string | null
}

export interface CloudStatusPayload {
  state: CloudConnectionState
  error: string | null
  capabilities: CloudCapabilities | null
}

/** `cloud:device:get` / `cloud:device:set` 的返回 */
export interface CloudDeviceResult {
  success: boolean
  device?: CloudDeviceSummary
  error?: string
}

export interface CloudConfigGetResult {
  success: boolean
  config: CloudConnectionInfo
  error?: string
}

/** 配对失败原因：服务端错误码之外，桌面端补一个「插件没有这个接口」 */
export type CloudPairErrorCode =
  | 'pairing_not_found'
  | 'pairing_expired'
  | 'pairing_used'
  | 'rate_limited'
  | 'pairing_disabled'
  | 'pairing_unsupported'

/** 配对输入：完整链接已在渲染层拆好，主进程只收网关 + 连接码 */
export interface CloudGatewayPairInput {
  code: string
  gatewayUrl?: string
  name?: string
}

/** 配对结果：成功时回最新配置；失败不落 token */
export interface CloudGatewayPairResult {
  success: boolean
  config?: CloudConnectionInfo
  tokenPrefix?: string
  name?: string
  code?: CloudPairErrorCode
  error?: string
}

export interface CloudConnectResult {
  success: boolean
  state: CloudConnectionState
  capabilities?: CloudCapabilities | null
  error?: string
}

export interface CloudSessionsResult {
  success: boolean
  sessions: CloudSession[]
  hasMore?: boolean
  error?: string
}

export interface CloudMessagesResult {
  success: boolean
  parts: CloudTracePart[]
  session?: CloudSession | null
  hasMore?: boolean
  error?: string
}

export interface CloudRunStartResult {
  success: boolean
  runId?: string
  sessionId?: string
  error?: string
}

export interface CloudRunResult {
  success: boolean
  state?: CloudRunStatus
  error?: string
}

export interface CloudDashboardBounds {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}
