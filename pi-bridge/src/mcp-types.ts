/**
 * MCP（Model Context Protocol）共享类型、Zod 校验、工具命名与脱敏纯函数。
 *
 * 严格零 `node:*`、零 `@modelcontextprotocol/sdk` 与零 `@earendil-works/pi-*` 依赖，
 * 可通过 `pi-bridge/mcp` 子路径安全引入渲染进程与云端 Web。
 */

import { z } from 'zod'

export type McpTransportType = 'stdio' | 'http' | 'sse'

export type McpServerSource = 'global' | 'project' | 'cloud'

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: McpTransportType
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  timeoutMs?: number
  source?: McpServerSource
}

export interface McpToolInfo {
  serverId: string
  serverName: string
  name: string
  qualifiedName: string
  description?: string
  readOnly: boolean
  inputSchema: Record<string, unknown>
}

export type McpServerState = 'disabled' | 'connecting' | 'connected' | 'error'

export interface McpServerStatus {
  id: string
  name: string
  transport: McpTransportType
  enabled: boolean
  source: McpServerSource
  trusted?: boolean
  trustChanged?: boolean
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  timeoutMs?: number
  /** 脱敏后的键名与掩码值（永不暴露明文给 UI） */
  envMasked?: Record<string, string>
  headersMasked?: Record<string, string>
  state: McpServerState
  error?: string
  tools: McpToolInfo[]
  checkedAt?: number
}

export interface McpTestResult {
  ok: boolean
  tools: McpToolInfo[]
  latencyMs: number
  error?: string
}

export const MCP_SECRET_MASK = '••••••••'
export const MCP_TOOL_PREFIX = 'mcp__'
export const MCP_TOOL_NAME_MAX_LENGTH = 64

export const MCP_DEFAULT_TIMEOUT_MS = 20_000
export const MCP_MIN_TIMEOUT_MS = 1_000
export const MCP_MAX_TIMEOUT_MS = 120_000
export const MCP_MAX_ARGS = 64
export const MCP_MAX_RECORD_ENTRIES = 64
export const MCP_MAX_KEY_LENGTH = 128
export const MCP_MAX_VALUE_LENGTH = 4_096

const FORBIDDEN_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * 将敏感键值映射脱敏为掩码占位，永不向渲染进程或日志返回明文值。
 */
export function maskMcpSecretRecord(
  rec?: Record<string, string>
): Record<string, string> | undefined {
  if (!rec) return undefined
  const entries = Object.entries(rec)
  if (entries.length === 0) return undefined
  const masked: Record<string, string> = {}
  for (const [key] of entries) {
    if (!key || FORBIDDEN_RECORD_KEYS.has(key)) continue
    masked[key] = MCP_SECRET_MASK
  }
  return Object.keys(masked).length > 0 ? masked : undefined
}

/**
 * 合并 UI 提交的脱敏键值映射与磁盘上已有明文映射：
 * - 值等于 `MCP_SECRET_MASK` 且原键存在时保留旧明文（用户未改该密钥）
 * - 值等于 `MCP_SECRET_MASK` 但原键不存在时丢弃（防止把掩码字面量存成密钥）
 * - 未出现在 `incoming` 中的旧键视为用户已删除
 */
export function mergeMaskedSecretRecord(
  incoming?: Record<string, string>,
  existing?: Record<string, string>
): Record<string, string> | undefined {
  if (!incoming) return undefined
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (!key || FORBIDDEN_RECORD_KEYS.has(key)) continue
    if (value === MCP_SECRET_MASK) {
      if (existing && Object.prototype.hasOwnProperty.call(existing, key)) {
        merged[key] = existing[key]
      }
      continue
    }
    merged[key] = value
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

export function isMcpToolName(name: string): boolean {
  return typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX) && name.length > MCP_TOOL_PREFIX.length
}

function sanitizeToolSegment(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || fallback
}

/** 纯 JS FNV-1a 32-bit 哈希，用于超长工具名截断后的确定性防碰撞后缀（零 node:crypto 依赖） */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 生成符合主流 LLM 工具名约束（仅 `[a-zA-Z0-9_-]`、长度 ≤ 64）的确定性限定工具名：
 * `mcp__<serverSlug>__<toolSlug>`；超长时保留可辨识前缀并附 8 位确定性哈希后缀。
 */
export function mcpQualifiedToolName(serverId: string, toolName: string): string {
  const serverSlug = sanitizeToolSegment(serverId, 'server')
  const toolSlug = sanitizeToolSegment(toolName, 'tool')
  const candidate = `${MCP_TOOL_PREFIX}${serverSlug}__${toolSlug}`
  if (candidate.length <= MCP_TOOL_NAME_MAX_LENGTH) return candidate

  const suffix = fnv1aHex(`${serverId}\0${toolName}`)
  // 固定开销：mcp__ (5) + __ (2) + _ (1) + suffix (8) = 16，剩余 48 字符分配给 server 与 tool
  const available = MCP_TOOL_NAME_MAX_LENGTH - MCP_TOOL_PREFIX.length - 2 - 1 - suffix.length
  const maxServer = Math.min(serverSlug.length, Math.max(12, available - Math.min(toolSlug.length, 28)))
  const maxTool = Math.max(1, available - maxServer)
  const serverPart = serverSlug.slice(0, maxServer).replace(/_+$/g, '') || 's'
  const toolPart = toolSlug.slice(0, maxTool).replace(/_+$/g, '') || 't'
  return `${MCP_TOOL_PREFIX}${serverPart}__${toolPart}_${suffix}`
}

function sortedRecord(rec?: Record<string, string>): Record<string, string> {
  if (!rec) return {}
  const keys = Object.keys(rec)
    .filter((key) => !FORBIDDEN_RECORD_KEYS.has(key))
    .sort()
  const out: Record<string, string> = {}
  for (const key of keys) {
    out[key] = rec[key]
  }
  return out
}

export type McpFingerprintTarget = Pick<
  McpServerConfig,
  'id' | 'transport' | 'command' | 'args' | 'cwd' | 'env' | 'url' | 'headers'
>

/**
 * 将 MCP 服务器配置序列化为键序确定的规范 JSON 字符串，供仓库级项目配置信任指纹（SHA-256）计算。
 */
export function canonicalMcpFingerprintInput(config: McpFingerprintTarget): string {
  return JSON.stringify({
    id: config.id,
    transport: config.transport,
    command: config.command ?? '',
    args: config.args ? [...config.args] : [],
    cwd: config.cwd ?? '',
    env: sortedRecord(config.env),
    url: config.url ?? '',
    headers: sortedRecord(config.headers),
  })
}

export const canonicalizeMcpServerForHash = canonicalMcpFingerprintInput

// ---------------------------------------------------------------------------
// Zod 校验 Schema（桌面 IPC / 云端 API / 配置文件共用）
// ---------------------------------------------------------------------------

export const mcpTransportSchema = z.enum(['stdio', 'http', 'sse'])

export const mcpServerSourceSchema = z.enum(['global', 'project', 'cloud'])

export const mcpServerIdSchema = z
  .string()
  .trim()
  .min(1, 'Server id is required.')
  .max(64, 'Server id must be at most 64 characters.')
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    'Server id must start with a letter or number and contain only letters, numbers, ".", "_", or "-".'
  )

const mcpRecordKeySchema = z
  .string()
  .min(1, 'Key must not be empty.')
  .max(MCP_MAX_KEY_LENGTH, `Key must be at most ${MCP_MAX_KEY_LENGTH} characters.`)
  .refine((key) => !FORBIDDEN_RECORD_KEYS.has(key), {
    message: 'Reserved key name is not allowed.',
  })

const mcpSecretRecordSchema = z
  .record(
    mcpRecordKeySchema,
    z.string().max(MCP_MAX_VALUE_LENGTH, `Value must be at most ${MCP_MAX_VALUE_LENGTH} characters.`)
  )
  .refine((rec) => Object.keys(rec).length <= MCP_MAX_RECORD_ENTRIES, {
    message: `At most ${MCP_MAX_RECORD_ENTRIES} entries are allowed.`,
  })

function isValidHttpOrHttpsUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function refineMcpTransportFields(
  data: {
    transport: McpTransportType
    command?: string
    url?: string
  },
  ctx: z.RefinementCtx
): void {
  if (data.transport === 'stdio') {
    if (!data.command || !data.command.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'Command is required for stdio transport.',
      })
    }
    return
  }
  if (!data.url || !isValidHttpOrHttpsUrl(data.url)) {
    ctx.addIssue({
      code: 'custom',
      path: ['url'],
      message: 'A valid http:// or https:// URL is required for http/sse transport.',
    })
  }
}

const mcpServerFields = {
  name: z.string().trim().min(1, 'Server name is required.').max(120),
  transport: mcpTransportSchema,
  command: z.string().trim().max(1_024).optional(),
  args: z.array(z.string().max(2_048)).max(MCP_MAX_ARGS).optional(),
  cwd: z.string().trim().max(1_024).optional(),
  env: mcpSecretRecordSchema.optional(),
  url: z.string().trim().max(2_048).optional(),
  headers: mcpSecretRecordSchema.optional(),
  timeoutMs: z.number().int().min(MCP_MIN_TIMEOUT_MS).max(MCP_MAX_TIMEOUT_MS).optional(),
  source: mcpServerSourceSchema.optional(),
}

export const mcpServerConfigSchema = z
  .object({
    id: mcpServerIdSchema,
    enabled: z.boolean(),
    ...mcpServerFields,
  })
  .superRefine(refineMcpTransportFields)

export const mcpServerInputSchema = z
  .object({
    id: mcpServerIdSchema.optional(),
    enabled: z.boolean().optional().default(true),
    ...mcpServerFields,
  })
  .superRefine(refineMcpTransportFields)

export type McpServerInput = z.input<typeof mcpServerInputSchema>
export type McpServerInputParsed = z.output<typeof mcpServerInputSchema>
