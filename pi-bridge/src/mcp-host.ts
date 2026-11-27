/**
 * MCP 客户端宿主（McpClientHost）：管理多台 MCP 服务器的并发连接、故障隔离、
 * 工具发现、工具调用（含超时、中止、截断与脱敏）及子进程清理。
 */

import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { consoleAgentLogger, sanitizeAgentShellEnv } from './agent-runtime-types.js'
import { withTimeout } from './async-utils.js'
import {
  MCP_DEFAULT_TIMEOUT_MS,
  canonicalMcpFingerprintInput,
  maskMcpSecretRecord,
  mcpQualifiedToolName,
  type McpFingerprintTarget,
  type McpServerConfig,
  type McpServerStatus,
  type McpTestResult,
  type McpToolInfo,
} from './mcp-types.js'
import type { AgentLogger } from './types.js'

const MCP_CLIENT_INFO = { name: 'pi-workbench', version: '1.0.0' }
const DEFAULT_CALL_TIMEOUT_MS = 60_000
const CLOSE_TIMEOUT_MS = 4_000
const MAX_LIST_TOOLS_PAGES = 16
/** 单次 MCP 工具文本结果字节上限（128 KB），防止大响应撑爆模型上下文或内存 */
export const MCP_MAX_TOOL_TEXT_BYTES = 128 * 1024
const TRUNCATION_NOTICE = '\n\n[Output truncated at 128 KB]'

export interface McpClientHostOptions {
  logger?: AgentLogger
  envSanitizer?: (env: Record<string, string | undefined>) => Record<string, string | undefined>
  defaultCwd?: string
  /** stdio 子进程启动后回调，必须返回注销函数以便退出/断连时解除登记 */
  onChildPid?: (pid: number, kill: () => void) => () => void
  /** 工具文本输出脱敏钩子 */
  outputRedactor?: (text: string) => string
}

export type McpToolContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface McpCallToolResult {
  content: McpToolContentPart[]
  isError?: boolean
  details?: Record<string, unknown>
}

interface ActiveConnection {
  config: McpServerConfig
  client: Client
  transport: Transport
  unregisterPid: (() => void) | null
}

interface ToolLookupEntry {
  serverId: string
  toolName: string
  info: McpToolInfo
  timeoutMs: number
}

/** 计算 MCP 服务器配置的确定性 SHA-256 指纹（用于仓库级配置变更检测与信任钉住） */
export function computeMcpServerFingerprint(config: McpFingerprintTarget): string {
  return createHash('sha256').update(canonicalMcpFingerprintInput(config)).digest('hex')
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

function toStringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} }
  }
  const record = schema as Record<string, unknown>
  if (record.type === 'object') {
    return record.properties && typeof record.properties === 'object'
      ? { ...record }
      : { ...record, properties: {} }
  }
  return { type: 'object', properties: {}, ...record }
}

function shouldFallbackToSse(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) {
    return error.code === 404 || error.code === 405 || error.code === 400 || error.code === -1
  }
  const msg = errorMessageOf(error)
  return /\b(404|405)\b|method not allowed|text\/event-stream|unexpected content type/i.test(msg)
}

/** 按 UTF-8 字节预算安全截断文本，不破坏 UTF-16 代理对，也不产生乱码 */
function truncateUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 }
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) {
    return { text, truncated: false }
  }
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (Buffer.byteLength(text.slice(0, mid), 'utf-8') <= maxBytes) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  // 避免停在高代理码位上截断四字节字符
  if (lo > 0) {
    const code = text.charCodeAt(lo - 1)
    if (code >= 0xd800 && code <= 0xdbff) lo -= 1
  }
  return { text: text.slice(0, lo), truncated: true }
}

function createAbortError(): Error {
  const error = new Error('MCP tool call was aborted.')
  error.name = 'AbortError'
  return error
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    void promise.catch(() => {})
    return Promise.reject(createAbortError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

async function closeClientAndTransport(
  client: Client | null,
  transport: Transport | null,
  unregisterPid: (() => void) | null,
  logger: AgentLogger
): Promise<void> {
  const closeTask = (async () => {
    if (client) {
      try {
        await client.close()
      } catch (error) {
        logger.debug('[MCP Host] Error closing client:', error)
      }
    }
    if (transport) {
      try {
        await transport.close()
      } catch (error) {
        logger.debug('[MCP Host] Error closing transport:', error)
      }
    }
  })()

  try {
    await withTimeout(closeTask, CLOSE_TIMEOUT_MS, 'MCP transport close')
  } catch (error) {
    logger.warn('[MCP Host] Close timed out:', errorMessageOf(error))
  } finally {
    try {
      unregisterPid?.()
    } catch {
      // ignore
    }
  }
}

export class McpClientHost {
  private readonly logger: AgentLogger
  private readonly envSanitizer: (
    env: Record<string, string | undefined>
  ) => Record<string, string | undefined>
  private readonly defaultCwd?: string
  private readonly onChildPid?: (pid: number, kill: () => void) => () => void
  private readonly outputRedactor?: (text: string) => string

  private connections = new Map<string, ActiveConnection>()
  private statuses = new Map<string, McpServerStatus>()
  private statusOrder: string[] = []
  private toolLookup = new Map<string, ToolLookupEntry>()
  private generation = 0
  private disposed = false

  constructor(options: McpClientHostOptions = {}) {
    this.logger = options.logger ?? consoleAgentLogger
    this.envSanitizer = options.envSanitizer ?? sanitizeAgentShellEnv
    this.defaultCwd = options.defaultCwd
    this.onChildPid = options.onChildPid
    this.outputRedactor = options.outputRedactor
  }

  private buildBaseStatus(
    config: McpServerConfig,
    state: McpServerStatus['state'],
    extra: Partial<Pick<McpServerStatus, 'error' | 'tools' | 'checkedAt'>> = {}
  ): McpServerStatus {
    const status: McpServerStatus = {
      id: config.id,
      name: config.name,
      transport: config.transport,
      enabled: config.enabled,
      source: config.source ?? 'global',
      state,
      tools: extra.tools ?? [],
    }
    if (config.command !== undefined) status.command = config.command
    if (config.args !== undefined) status.args = [...config.args]
    if (config.cwd !== undefined) status.cwd = config.cwd
    if (config.url !== undefined) status.url = config.url
    if (config.timeoutMs !== undefined) status.timeoutMs = config.timeoutMs
    const envMasked = maskMcpSecretRecord(config.env)
    if (envMasked) status.envMasked = envMasked
    const headersMasked = maskMcpSecretRecord(config.headers)
    if (headersMasked) status.headersMasked = headersMasked
    if (extra.error !== undefined) status.error = extra.error
    if (extra.checkedAt !== undefined) status.checkedAt = extra.checkedAt
    return status
  }

  private redactText(text: string): string {
    if (!this.outputRedactor) return text
    try {
      return this.outputRedactor(text)
    } catch (error) {
      this.logger.warn('[MCP Host] outputRedactor failed:', errorMessageOf(error))
      return text
    }
  }

  private async listAllTools(
    client: Client,
    config: McpServerConfig,
    timeoutMs: number
  ): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_TOOLS_PAGES; page += 1) {
      const response = await withTimeout(
        client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs }),
        timeoutMs,
        `MCP listTools (${config.id})`
      )
      for (const tool of response.tools ?? []) {
        const qualifiedName = mcpQualifiedToolName(config.id, tool.name)
        tools.push({
          serverId: config.id,
          serverName: config.name,
          name: tool.name,
          qualifiedName,
          description: tool.description,
          readOnly: tool.annotations?.readOnlyHint === true,
          inputSchema: normalizeInputSchema(tool.inputSchema),
        })
      }
      if (!response.nextCursor || response.nextCursor === cursor) break
      cursor = response.nextCursor
    }
    return tools
  }

  /**
   * 建立单台 MCP 服务器连接并拉取工具列表。
   * 任何步骤失败都会立即释放已打开的 transport/子进程后再抛出。
   */
  private async openConnection(
    config: McpServerConfig,
    registerChildPid: boolean
  ): Promise<{ connection: ActiveConnection; tools: McpToolInfo[] }> {
    const timeoutMs = config.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS

    const connectTransport = async (
      transport: Transport,
      getUnregister: () => (() => void) | null
    ): Promise<{ connection: ActiveConnection; tools: McpToolInfo[] }> => {
      const client = new Client(MCP_CLIENT_INFO)
      client.onerror = (error) => {
        this.logger.warn(`[MCP Host] Client error (${config.id}):`, errorMessageOf(error))
      }
      try {
        await withTimeout(
          client.connect(transport, { timeout: timeoutMs }),
          timeoutMs,
          `MCP connect (${config.id})`
        )
        const tools = await this.listAllTools(client, config, timeoutMs)
        return {
          connection: {
            config,
            client,
            transport,
            unregisterPid: getUnregister(),
          },
          tools,
        }
      } catch (error) {
        await closeClientAndTransport(client, transport, getUnregister(), this.logger)
        throw error
      }
    }

    if (config.transport === 'stdio') {
      const command = config.command?.trim()
      if (!command) throw new Error('Command is required for stdio MCP server.')
      // 必须先清洗父进程敏感环境变量，再叠加用户显式配置的服务器环境变量
      const sanitizedBase = toStringEnv(this.envSanitizer({ ...process.env }))
      const mergedEnv: Record<string, string> = {
        ...sanitizedBase,
        ...(config.env ?? {}),
      }
      const transport = new StdioClientTransport({
        command,
        args: config.args ?? [],
        cwd: config.cwd?.trim() || this.defaultCwd,
        env: mergedEnv,
        stderr: 'pipe',
      })

      let unregisterPid: (() => void) | null = null
      const releasePid = () => {
        const fn = unregisterPid
        unregisterPid = null
        try {
          fn?.()
        } catch {
          // ignore
        }
      }

      if (transport.stderr) {
        transport.stderr.on('data', (chunk: Buffer | string) => {
          const line = String(chunk).trim()
          if (line) {
            this.logger.debug(`[MCP:${config.id}] stderr:`, this.redactText(line.slice(0, 1000)))
          }
        })
      }

      const originalStart = transport.start.bind(transport)
      transport.start = async () => {
        await originalStart()
        const pid = transport.pid
        if (registerChildPid && typeof pid === 'number' && pid > 0 && this.onChildPid) {
          unregisterPid = this.onChildPid(pid, () => {
            void transport.close().catch(() => {})
          })
        }
      }

      const originalOnClose = transport.onclose
      transport.onclose = () => {
        releasePid()
        originalOnClose?.()
      }

      return connectTransport(transport, () => {
        const fn = unregisterPid
        unregisterPid = null
        return fn
      })
    }

    const rawUrl = config.url?.trim()
    if (!rawUrl) throw new Error('URL is required for remote MCP server.')
    const endpoint = new URL(rawUrl)
    const requestInit: RequestInit | undefined =
      config.headers && Object.keys(config.headers).length > 0
        ? { headers: { ...config.headers } }
        : undefined

    if (config.transport === 'sse') {
      const transport = new SSEClientTransport(endpoint, requestInit ? { requestInit } : undefined)
      return connectTransport(transport, () => null)
    }

    // transport === 'http'：优先 Streamable HTTP，遇 404/405 等旧端点响应时回落至 SSE
    const httpTransport = new StreamableHTTPClientTransport(
      endpoint,
      requestInit ? { requestInit } : undefined
    )
    try {
      return await connectTransport(httpTransport, () => null)
    } catch (httpError) {
      if (!shouldFallbackToSse(httpError)) throw httpError
      this.logger.info(
        `[MCP Host] Streamable HTTP failed for ${config.id} (${errorMessageOf(httpError)}); falling back to SSE`
      )
      const sseTransport = new SSEClientTransport(
        endpoint,
        requestInit ? { requestInit } : undefined
      )
      try {
        return await connectTransport(sseTransport, () => null)
      } catch (sseError) {
        throw new Error(
          `${errorMessageOf(httpError)} (SSE fallback failed: ${errorMessageOf(sseError)})`
        )
      }
    }
  }

  private async closeAllActiveConnections(): Promise<void> {
    const active = [...this.connections.values()]
    this.connections.clear()
    this.toolLookup.clear()
    if (active.length === 0) return
    await Promise.allSettled(
      active.map((conn) =>
        closeClientAndTransport(conn.client, conn.transport, conn.unregisterPid, this.logger)
      )
    )
  }

  /**
   * 同步并并发连接全部已启用的 MCP 服务器。
   * 单台失败仅记录 `state: 'error'`，绝不抛错或阻断其余服务器连接。
   */
  async syncServers(servers: readonly McpServerConfig[]): Promise<McpServerStatus[]> {
    this.disposed = false
    const syncGen = ++this.generation
    await this.closeAllActiveConnections()

    this.statuses.clear()
    this.statusOrder = servers.map((server) => server.id)

    for (const server of servers) {
      this.statuses.set(
        server.id,
        this.buildBaseStatus(server, server.enabled ? 'connecting' : 'disabled', {
          checkedAt: server.enabled ? undefined : Date.now(),
        })
      )
    }

    const enabledServers = servers.filter((server) => server.enabled)
    await Promise.all(
      enabledServers.map(async (server) => {
        try {
          const { connection, tools } = await this.openConnection(server, true)
          // 并发重新同步或 dispose 已发生：立即释放过期连接，避免子进程/句柄泄漏
          if (this.disposed || this.generation !== syncGen) {
            await closeClientAndTransport(
              connection.client,
              connection.transport,
              connection.unregisterPid,
              this.logger
            )
            return
          }
          this.connections.set(server.id, connection)
          const timeoutMs = server.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
          for (const info of tools) {
            this.toolLookup.set(info.qualifiedName, {
              serverId: server.id,
              toolName: info.name,
              info,
              timeoutMs,
            })
          }
          this.statuses.set(
            server.id,
            this.buildBaseStatus(server, 'connected', {
              tools,
              checkedAt: Date.now(),
            })
          )
          this.logger.info(
            `[MCP Host] Connected server "${server.id}" (${server.transport}) with ${tools.length} tool(s)`
          )
        } catch (error) {
          if (this.disposed || this.generation !== syncGen) return
          const message = this.redactText(errorMessageOf(error))
          this.logger.warn(`[MCP Host] Failed to connect server "${server.id}": ${message}`)
          this.statuses.set(
            server.id,
            this.buildBaseStatus(server, 'error', {
              error: message,
              tools: [],
              checkedAt: Date.now(),
            })
          )
        }
      })
    )

    return this.getStatuses()
  }

  /**
   * 一次性隔离连通性测试：连接、拉取工具列表并在 finally 必定关闭，不影响当前宿主状态。
   */
  async testServer(config: McpServerConfig): Promise<McpTestResult> {
    const startedAt = Date.now()
    let opened: ActiveConnection | null = null
    try {
      const { connection, tools } = await this.openConnection(config, false)
      opened = connection
      return {
        ok: true,
        tools,
        latencyMs: Math.max(0, Date.now() - startedAt),
      }
    } catch (error) {
      return {
        ok: false,
        tools: [],
        latencyMs: Math.max(0, Date.now() - startedAt),
        error: this.redactText(errorMessageOf(error)),
      }
    } finally {
      if (opened) {
        await closeClientAndTransport(
          opened.client,
          opened.transport,
          opened.unregisterPid,
          this.logger
        )
      }
    }
  }

  /**
   * 调用已发现的 MCP 工具；内置超时、AbortSignal 响应、128 KB 截断、输出脱敏与错误兜底，
   * 绝不向外抛未捕获异常导致会话崩溃。
   */
  async callTool(
    qualifiedName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<McpCallToolResult> {
    const entry = this.toolLookup.get(qualifiedName)
    if (!entry) {
      return {
        content: [{ type: 'text', text: `MCP tool "${qualifiedName}" is not available.` }],
        isError: true,
        details: { qualifiedName, error: 'not_found' },
      }
    }

    const connection = this.connections.get(entry.serverId)
    if (!connection) {
      return {
        content: [
          {
            type: 'text',
            text: `MCP server "${entry.serverId}" is not connected.`,
          },
        ],
        isError: true,
        details: {
          serverId: entry.serverId,
          serverName: entry.info.serverName,
          toolName: entry.toolName,
          error: 'not_connected',
        },
      }
    }

    if (signal?.aborted) {
      return {
        content: [{ type: 'text', text: 'MCP tool call was aborted.' }],
        isError: true,
        details: {
          serverId: entry.serverId,
          serverName: entry.info.serverName,
          toolName: entry.toolName,
          aborted: true,
        },
      }
    }

    const timeoutMs = entry.timeoutMs
    try {
      const rawResult = await raceWithAbort(
        withTimeout(
          connection.client.callTool(
            { name: entry.toolName, arguments: args ?? {} },
            undefined,
            { timeout: timeoutMs, signal }
          ),
          timeoutMs,
          `MCP tool "${qualifiedName}"`
        ),
        signal
      )

      return this.formatCallToolResult(entry, rawResult)
    } catch (error) {
      const message = this.redactText(errorMessageOf(error))
      this.logger.warn(`[MCP Host] Tool call "${qualifiedName}" failed:`, message)
      return {
        content: [
          {
            type: 'text',
            text: `MCP tool "${entry.toolName}" on server "${entry.info.serverName}" failed: ${message}`,
          },
        ],
        isError: true,
        details: {
          serverId: entry.serverId,
          serverName: entry.info.serverName,
          toolName: entry.toolName,
          error: message,
        },
      }
    }
  }

  private formatCallToolResult(
    entry: ToolLookupEntry,
    rawResult: Awaited<ReturnType<Client['callTool']>>
  ): McpCallToolResult {
    const parts: McpToolContentPart[] = []
    let remainingBytes = MCP_MAX_TOOL_TEXT_BYTES
    let truncated = false

    const pushText = (rawText: string) => {
      const redacted = this.redactText(rawText)
      if (remainingBytes <= 0) {
        truncated = true
        return
      }
      const clipped = truncateUtf8Bytes(redacted, remainingBytes)
      if (clipped.truncated) {
        truncated = true
        remainingBytes = 0
        if (clipped.text) parts.push({ type: 'text', text: clipped.text })
      } else {
        remainingBytes -= Buffer.byteLength(clipped.text, 'utf-8')
        parts.push({ type: 'text', text: clipped.text })
      }
    }

    if ('content' in rawResult && Array.isArray(rawResult.content)) {
      for (const item of rawResult.content) {
        if (!item || typeof item !== 'object') continue
        if (item.type === 'text' && typeof item.text === 'string') {
          pushText(item.text)
        } else if (
          item.type === 'image' &&
          typeof item.data === 'string' &&
          typeof item.mimeType === 'string'
        ) {
          parts.push({ type: 'image', data: item.data, mimeType: item.mimeType })
        } else if (item.type === 'audio' && typeof item.mimeType === 'string') {
          pushText(`[MCP audio content: ${item.mimeType}]`)
        } else if (item.type === 'resource' && item.resource && typeof item.resource === 'object') {
          const res = item.resource as { uri?: string; text?: string; mimeType?: string }
          const uri = res.uri ?? '(unknown resource)'
          if (typeof res.text === 'string') {
            pushText(`[Resource: ${uri}]\n${res.text}`)
          } else {
            pushText(`[Binary resource: ${uri}${res.mimeType ? ` (${res.mimeType})` : ''}]`)
          }
        } else if (item.type === 'resource_link') {
          const link = item as { uri?: string; name?: string; description?: string }
          const label = link.name || link.uri || 'resource'
          const desc = link.description ? ` — ${link.description}` : ''
          pushText(`[Resource link: ${label} (${link.uri ?? ''})${desc}]`)
        }
      }
    } else if ('toolResult' in rawResult && rawResult.toolResult !== undefined) {
      pushText(
        typeof rawResult.toolResult === 'string'
          ? rawResult.toolResult
          : JSON.stringify(rawResult.toolResult, null, 2)
      )
    }

    if (
      parts.length === 0 &&
      'structuredContent' in rawResult &&
      rawResult.structuredContent !== undefined
    ) {
      pushText(JSON.stringify(rawResult.structuredContent, null, 2))
    }

    if (truncated) {
      parts.push({ type: 'text', text: TRUNCATION_NOTICE })
    }

    if (parts.length === 0) {
      parts.push({ type: 'text', text: '(MCP tool returned no content)' })
    }

    const isError = 'isError' in rawResult && rawResult.isError === true
    return {
      content: parts,
      ...(isError ? { isError: true } : {}),
      details: {
        serverId: entry.serverId,
        serverName: entry.info.serverName,
        toolName: entry.toolName,
        ...(truncated ? { truncated: true } : {}),
      },
    }
  }

  getTools(): McpToolInfo[] {
    return [...this.toolLookup.values()].map((entry) => ({
      ...entry.info,
      inputSchema: { ...entry.info.inputSchema },
    }))
  }

  isReadOnlyTool(qualifiedName: string): boolean {
    return this.toolLookup.get(qualifiedName)?.info.readOnly === true
  }

  getStatuses(): McpServerStatus[] {
    const ordered: McpServerStatus[] = []
    for (const id of this.statusOrder) {
      const status = this.statuses.get(id)
      if (!status) continue
      ordered.push({
        ...status,
        ...(status.args ? { args: [...status.args] } : {}),
        ...(status.envMasked ? { envMasked: { ...status.envMasked } } : {}),
        ...(status.headersMasked ? { headersMasked: { ...status.headersMasked } } : {}),
        tools: status.tools.map((tool) => ({
          ...tool,
          inputSchema: { ...tool.inputSchema },
        })),
      })
    }
    return ordered
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.generation += 1
    await this.closeAllActiveConnections()
    this.statuses.clear()
    this.statusOrder = []
  }
}
