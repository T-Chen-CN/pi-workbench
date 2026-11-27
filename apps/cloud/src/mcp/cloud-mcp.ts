/**
 * 云端 MCP 服务器配置的加解密、掩码合并、脱敏与隔离探测辅助模块（Phase F · Step F3）。
 *
 * 约束：
 * - 数据库中仅存放 AES-256-GCM 密文（`config_cipher`），永不明文落盘 `env`/`headers`/`command`/`url`；
 * - 返回给控制面 API 的视图一律经 `maskMcpSecretRecord` 脱敏，绝不回传明文密钥；
 * - 云端支持远程 `http`/`sse` 与自托管 VPS 本地 `stdio` 两种形态，均由 `McpClientHost` 承载。
 */

import {
  McpClientHost,
  type AgentLogger,
  type McpServerConfig,
  type McpServerInput,
  type McpServerStatus,
  type McpTestResult,
  type McpTransportType,
} from 'pi-bridge'
import {
  maskMcpSecretRecord,
  mcpServerConfigSchema,
  mcpServerIdSchema,
  mcpServerInputSchema,
  mergeMaskedSecretRecord,
} from 'pi-bridge/mcp'
import { decryptSecret } from '../secure/config-crypto.js'
import type { CloudMcpServerRecord, CloudStore } from '../store/store.js'

const SECRET_OUTPUT_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi,
]

export function redactCloudMcpOutput(text: string): string {
  if (!text) return text
  let redacted = text
  for (const pattern of SECRET_OUTPUT_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix?: string) =>
      typeof prefix === 'string' && prefix.length > 0 ? `${prefix}[REDACTED]` : '[REDACTED]'
    )
  }
  return redacted
}

function formatZodIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const first = error.issues[0]
  if (!first) return 'Invalid MCP server configuration.'
  const loc = first.path.length > 0 ? `${first.path.map(String).join('.')}: ` : ''
  return `${loc}${first.message}`
}

function normalizeTransportOf(raw: string): McpTransportType {
  if (raw === 'http' || raw === 'sse' || raw === 'stdio') return raw
  return 'http'
}

function normalizeServerConfig(config: McpServerConfig): McpServerConfig {
  const timeoutMs =
    typeof config.timeoutMs === 'number' && Number.isInteger(config.timeoutMs)
      ? config.timeoutMs
      : undefined
  if (config.transport === 'stdio') {
    const command = config.command?.trim() ?? ''
    const args = Array.isArray(config.args) ? [...config.args] : undefined
    const cwd = config.cwd?.trim() || undefined
    return {
      id: config.id,
      name: config.name.trim(),
      enabled: config.enabled,
      transport: 'stdio',
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(config.env && Object.keys(config.env).length > 0 ? { env: { ...config.env } } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      source: 'cloud',
    }
  }
  const url = config.url?.trim() ?? ''
  return {
    id: config.id,
    name: config.name.trim(),
    enabled: config.enabled,
    transport: config.transport,
    url,
    ...(config.headers && Object.keys(config.headers).length > 0
      ? { headers: { ...config.headers } }
      : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    source: 'cloud',
  }
}

export function decryptCloudMcpRecord(
  record: CloudMcpServerRecord,
  encryptionKey: Buffer,
  logger?: Pick<AgentLogger, 'warn'>
): McpServerConfig | null {
  try {
    const raw = JSON.parse(decryptSecret(record.configCipher, encryptionKey)) as unknown
    const parsed = mcpServerConfigSchema.safeParse(raw)
    if (!parsed.success) {
      logger?.warn(
        `[cloud] skipping invalid stored MCP server "${record.id}": ${formatZodIssue(parsed.error)}`
      )
      return null
    }
    return normalizeServerConfig({
      ...parsed.data,
      id: record.id,
      enabled: record.enabled,
      source: 'cloud',
    })
  } catch (error) {
    logger?.warn(
      `[cloud] skipping unreadable stored MCP server "${record.id}":`,
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}

/**
 * 读取并解密所有持久化在 `cloud.db` 的云端 MCP 服务器；单条损坏或密钥变更时跳过并记录告警，绝不阻塞启动。
 */
export function loadCloudMcpServers(
  store: CloudStore,
  encryptionKey: Buffer,
  logger?: Pick<AgentLogger, 'warn'>
): McpServerConfig[] {
  const servers: McpServerConfig[] = []
  for (const record of store.listMcpServerRecords()) {
    const decrypted = decryptCloudMcpRecord(record, encryptionKey, logger)
    if (decrypted) servers.push(decrypted)
  }
  return servers
}

export function buildMaskedCloudMcpStatus(
  config: McpServerConfig,
  live?: McpServerStatus
): McpServerStatus {
  const envMasked = maskMcpSecretRecord(config.env)
  const headersMasked = maskMcpSecretRecord(config.headers)
  const base: McpServerStatus = {
    id: config.id,
    name: config.name,
    transport: config.transport,
    enabled: config.enabled,
    source: 'cloud',
    ...(config.command !== undefined ? { command: config.command } : {}),
    ...(config.args !== undefined ? { args: [...config.args] } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(config.url !== undefined ? { url: config.url } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(envMasked ? { envMasked } : {}),
    ...(headersMasked ? { headersMasked } : {}),
    state: 'disabled',
    tools: [],
  }
  if (!config.enabled || !live) return base
  return {
    ...base,
    state: live.state,
    tools: live.tools.map((tool) => ({
      ...tool,
      inputSchema: { ...tool.inputSchema },
    })),
    ...(live.error !== undefined ? { error: live.error } : {}),
    ...(live.checkedAt !== undefined ? { checkedAt: live.checkedAt } : {}),
  }
}

/**
 * 合并持久化的云端 MCP 记录与运行期实时状态，输出脱敏后的管理界面列表。
 */
export function listCloudMcpStatuses(
  store: CloudStore,
  encryptionKey: Buffer,
  liveStatuses: readonly McpServerStatus[],
  logger?: Pick<AgentLogger, 'warn'>
): McpServerStatus[] {
  const liveById = new Map<string, McpServerStatus>()
  for (const status of liveStatuses) {
    liveById.set(status.id, status)
  }
  const result: McpServerStatus[] = []
  for (const record of store.listMcpServerRecords()) {
    const decrypted = decryptCloudMcpRecord(record, encryptionKey, logger)
    if (!decrypted) {
      result.push({
        id: record.id,
        name: record.name,
        transport: normalizeTransportOf(record.transport),
        enabled: record.enabled,
        source: 'cloud',
        state: 'error',
        error: 'Stored MCP configuration cannot be decrypted; re-save or delete it.',
        tools: [],
      })
      continue
    }
    result.push(buildMaskedCloudMcpStatus(decrypted, liveById.get(decrypted.id)))
  }
  return result
}

export function normalizeCloudMcpSaveInput(
  rawId: string,
  rawBody: unknown,
  existing: McpServerConfig | null
): { ok: true; config: McpServerConfig } | { ok: false; error: string } {
  const idCheck = mcpServerIdSchema.safeParse(rawId)
  if (!idCheck.success) {
    return { ok: false, error: formatZodIssue(idCheck.error) }
  }
  const parsed = mcpServerInputSchema.safeParse(rawBody)
  if (!parsed.success) {
    return { ok: false, error: formatZodIssue(parsed.error) }
  }
  const data = parsed.data
  if (data.id && data.id !== idCheck.data) {
    return { ok: false, error: 'Server id in body must match URL parameter.' }
  }

  const base: McpServerConfig =
    data.transport === 'stdio'
      ? {
          id: idCheck.data,
          name: data.name.trim(),
          enabled: data.enabled,
          transport: 'stdio',
          command: data.command?.trim(),
          args: data.args,
          cwd: data.cwd?.trim() || undefined,
          env: mergeMaskedSecretRecord(data.env, existing?.env),
          timeoutMs: data.timeoutMs,
          source: 'cloud',
        }
      : {
          id: idCheck.data,
          name: data.name.trim(),
          enabled: data.enabled,
          transport: data.transport,
          url: data.url?.trim(),
          headers: mergeMaskedSecretRecord(data.headers, existing?.headers),
          timeoutMs: data.timeoutMs,
          source: 'cloud',
        }

  const checked = mcpServerConfigSchema.safeParse(base)
  if (!checked.success) {
    return { ok: false, error: formatZodIssue(checked.error) }
  }
  return { ok: true, config: normalizeServerConfig(checked.data) }
}

export function resolveCloudMcpTestTarget(
  body: { id?: unknown; config?: unknown },
  store: CloudStore,
  encryptionKey: Buffer,
  logger?: Pick<AgentLogger, 'warn'>
):
  | { ok: true; config: McpServerConfig }
  | { ok: false; error: string; status: number } {
  if (body.config !== undefined) {
    const parsed = mcpServerInputSchema.safeParse(body.config as McpServerInput)
    if (!parsed.success) {
      return { ok: false, error: formatZodIssue(parsed.error), status: 400 }
    }
    const data = parsed.data
    const lookupId = data.id ?? (typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined)
    let existing: McpServerConfig | null = null
    if (lookupId) {
      const stored = store.getMcpServerRecord(lookupId)
      if (stored) {
        existing = decryptCloudMcpRecord(stored, encryptionKey, logger)
      }
    }
    const targetId = lookupId && mcpServerIdSchema.safeParse(lookupId).success ? lookupId : 'mcp-test-draft'
    const normalized = normalizeCloudMcpSaveInput(targetId, { ...data, id: targetId }, existing)
    if (!normalized.ok) {
      return { ok: false, error: normalized.error, status: 400 }
    }
    return { ok: true, config: { ...normalized.config, enabled: true } }
  }

  const idCheck = mcpServerIdSchema.safeParse(body.id)
  if (!idCheck.success) {
    return { ok: false, error: formatZodIssue(idCheck.error), status: 400 }
  }
  const stored = store.getMcpServerRecord(idCheck.data)
  if (!stored) {
    return { ok: false, error: 'MCP server not found', status: 404 }
  }
  const decrypted = decryptCloudMcpRecord(stored, encryptionKey, logger)
  if (!decrypted) {
    return {
      ok: false,
      error: 'Stored MCP configuration cannot be decrypted; re-save it first.',
      status: 400,
    }
  }
  return { ok: true, config: { ...decrypted, enabled: true } }
}

export async function testCloudMcpServer(
  config: McpServerConfig,
  options: { defaultCwd: string; logger?: AgentLogger }
): Promise<McpTestResult> {
  const host = new McpClientHost({
    logger: options.logger,
    defaultCwd: options.defaultCwd,
    outputRedactor: redactCloudMcpOutput,
  })
  try {
    return await host.testServer(config)
  } finally {
    await host.dispose().catch(() => undefined)
  }
}
