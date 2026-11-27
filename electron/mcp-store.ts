/**
 * 桌面端 MCP 服务器配置与项目级信任存储（Phase F · Step F2）。
 *
 * 严格安全边界：
 * - 全局配置落盘于 `{appDir}/config/mcp.json`（原子写 + `.bak`），所有非空 `env` / `headers` 值均经
 *   `safeStorage`（`enc:` 前缀）静置加密，绝不以明文写入磁盘；
 * - 项目级配置只读发现自 `{workspaceDir}/.pi-workbench/mcp.json` 与 `{workspaceDir}/.mcp.json`
 *   （前者同名优先），绝不信任仓库文件内的 `enabled` 字段；
 * - 项目级启用状态与 SHA-256 指纹严格钉死在应用私有目录 `{appDir}/config/mcp-trust.json`，
 *   任何未批准或指纹漂移（仓库配置被改动）的项目服务器一律 fail-closed 关闭；
 * - 面向渲染层的快照仅返回脱敏掩码（`envMasked` / `headersMasked`），永不暴露明文密钥。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  MCP_DEFAULT_TIMEOUT_MS,
  computeMcpServerFingerprint,
  maskMcpSecretRecord,
  mcpServerConfigSchema,
  mcpServerIdSchema,
  mcpServerInputSchema,
  mergeMaskedSecretRecord,
  type McpServerConfig,
  type McpServerInput,
  type McpServerStatus,
  type McpTransportType,
} from 'pi-bridge'
import { getAppDir } from './app-paths.js'
import { readJsonWithBackup, writeJsonAtomic } from './atomic-json.js'
import { canonicalizePath, isPathInsideRoot, normalizeForComparison } from './path-safety.js'
import { decryptSecret, encryptSecret } from './secret-crypto.js'

export interface SecretCodec {
  encrypt: (plain: string) => string
  decrypt: (stored: string) => string
}

export interface McpStoreOptions {
  appDir?: string
  codec?: SecretCodec
}

export interface ResolveEffectiveMcpOptions extends McpStoreOptions {
  /** 覆盖项目 MCP 服务器的相对 cwd 与默认 cwd（如云端工单独立 git worktree 路径） */
  cwdOverride?: string
}

export interface McpUiListSnapshot {
  global: McpServerStatus[]
  project: McpServerStatus[]
}

interface StoredMcpServerRecord {
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
  updatedAt?: number
}

interface StoredGlobalMcpFile {
  version: 1
  servers: StoredMcpServerRecord[]
}

interface ProjectServerTrustEntry {
  enabled: boolean
  fingerprint: string
  updatedAt: number
}

interface StoredMcpTrustFile {
  version: 1
  workspaces: Record<string, Record<string, ProjectServerTrustEntry>>
}

const GLOBAL_MCP_FILE = 'mcp.json'
const PROJECT_TRUST_FILE = 'mcp-trust.json'
const MAX_PROJECT_CONFIG_BYTES = 512 * 1024
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const defaultCodec: SecretCodec = {
  encrypt: encryptSecret,
  decrypt: decryptSecret,
}

let mcpConfigVersion = 0

/** 当前 MCP 配置版本号（全局配置或项目信任变更时单调递增） */
export function currentMcpConfigVersion(): number {
  return mcpConfigVersion
}

/** 递增 MCP 配置版本号，供运行时判断是否需要刷新 MCP 宿主 */
export function bumpMcpConfigVersion(): number {
  mcpConfigVersion += 1
  return mcpConfigVersion
}

export function globalMcpConfigPath(appDir: string = getAppDir()): string {
  return path.join(appDir, 'config', GLOBAL_MCP_FILE)
}

export function projectMcpTrustPath(appDir: string = getAppDir()): string {
  return path.join(appDir, 'config', PROJECT_TRUST_FILE)
}

function resolveCodec(options?: McpStoreOptions): SecretCodec {
  return options?.codec ?? defaultCodec
}

function resolveAppDir(options?: McpStoreOptions): string {
  return options?.appDir ?? getAppDir()
}

function workspaceTrustKey(workspaceDir: string): string {
  const canonical = canonicalizePath(workspaceDir) ?? path.resolve(workspaceDir)
  return normalizeForComparison(canonical)
}

function encryptSecretRecord(
  rec: Record<string, string> | undefined,
  codec: SecretCodec
): Record<string, string> | undefined {
  if (!rec) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(rec)) {
    if (!key || FORBIDDEN_KEYS.has(key)) continue
    out[key] = value.length > 0 ? codec.encrypt(value) : ''
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function decryptSecretRecord(
  rec: unknown,
  codec: SecretCodec
): Record<string, string> | undefined {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(rec as Record<string, unknown>)) {
    if (!key || FORBIDDEN_KEYS.has(key) || typeof value !== 'string') continue
    out[key] = value.length > 0 ? codec.decrypt(value) : ''
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizePlainStringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || FORBIDDEN_KEYS.has(key) || typeof value !== 'string') continue
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeServerByTransport(
  base: McpServerConfig
): McpServerConfig {
  const timeoutMs =
    typeof base.timeoutMs === 'number' && Number.isInteger(base.timeoutMs)
      ? base.timeoutMs
      : undefined
  if (base.transport === 'stdio') {
    const command = base.command?.trim() ?? ''
    const args = Array.isArray(base.args) ? [...base.args] : undefined
    const cwd = base.cwd?.trim() || undefined
    return {
      id: base.id,
      name: base.name.trim(),
      enabled: base.enabled,
      transport: 'stdio',
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(cwd ? { cwd } : {}),
      ...(base.env && Object.keys(base.env).length > 0 ? { env: { ...base.env } } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(base.source ? { source: base.source } : {}),
    }
  }
  const url = base.url?.trim() ?? ''
  return {
    id: base.id,
    name: base.name.trim(),
    enabled: base.enabled,
    transport: base.transport,
    url,
    ...(base.headers && Object.keys(base.headers).length > 0
      ? { headers: { ...base.headers } }
      : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(base.source ? { source: base.source } : {}),
  }
}

function toUiStatus(
  config: McpServerConfig,
  extra?: { trusted?: boolean; trustChanged?: boolean }
): McpServerStatus {
  const status: McpServerStatus = {
    id: config.id,
    name: config.name,
    transport: config.transport,
    enabled: config.enabled,
    source: config.source ?? 'global',
    state: 'disabled',
    tools: [],
  }
  if (extra?.trusted !== undefined) status.trusted = extra.trusted
  if (extra?.trustChanged !== undefined) status.trustChanged = extra.trustChanged
  if (config.command !== undefined) status.command = config.command
  if (config.args !== undefined) status.args = [...config.args]
  if (config.cwd !== undefined) status.cwd = config.cwd
  if (config.url !== undefined) status.url = config.url
  if (config.timeoutMs !== undefined) status.timeoutMs = config.timeoutMs
  const envMasked = maskMcpSecretRecord(config.env)
  if (envMasked) status.envMasked = envMasked
  const headersMasked = maskMcpSecretRecord(config.headers)
  if (headersMasked) status.headersMasked = headersMasked
  return status
}

function deriveUniqueServerId(name: string, existingIds: ReadonlySet<string>): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/g, '')
    .slice(0, 56)
  const base = slug && mcpServerIdSchema.safeParse(slug).success ? slug : 'mcp-server'
  if (!existingIds.has(base)) return base
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base.slice(0, 58)}-${suffix}`
    if (!existingIds.has(candidate) && mcpServerIdSchema.safeParse(candidate).success) {
      return candidate
    }
  }
  return `mcp-${Date.now().toString(36)}`
}

function formatZodIssue(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const first = error.issues[0]
  if (!first) return 'Invalid MCP server configuration.'
  const loc = first.path.length > 0 ? `${first.path.map(String).join('.')}: ` : ''
  return `${loc}${first.message}`
}

// ---------------------------------------------------------------------------
// 全局配置（{appDir}/config/mcp.json）
// ---------------------------------------------------------------------------

function readStoredGlobalRecords(appDir: string): StoredMcpServerRecord[] {
  const res = readJsonWithBackup<StoredGlobalMcpFile>(globalMcpConfigPath(appDir))
  if (!res.data || typeof res.data !== 'object' || !Array.isArray(res.data.servers)) {
    return []
  }
  return res.data.servers.filter(
    (entry): entry is StoredMcpServerRecord =>
      Boolean(entry && typeof entry === 'object' && typeof entry.id === 'string')
  )
}

/** 读取并解密全局 MCP 服务器列表（仅限主进程与受控 host RPC 使用，绝不直接返给渲染层） */
export function loadGlobalMcpServers(options?: McpStoreOptions): McpServerConfig[] {
  const appDir = resolveAppDir(options)
  const codec = resolveCodec(options)
  const records = readStoredGlobalRecords(appDir)
  const result: McpServerConfig[] = []
  const seen = new Set<string>()

  for (const record of records) {
    const candidate = {
      id: record.id,
      name: record.name,
      enabled: Boolean(record.enabled),
      transport: record.transport,
      command: record.command,
      args: record.args,
      cwd: record.cwd,
      env: decryptSecretRecord(record.env, codec),
      url: record.url,
      headers: decryptSecretRecord(record.headers, codec),
      timeoutMs: record.timeoutMs,
      source: 'global' as const,
    }
    const parsed = mcpServerConfigSchema.safeParse(candidate)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    result.push(normalizeServerByTransport({ ...parsed.data, source: 'global' }))
  }
  return result
}

export function getGlobalMcpServerConfig(
  id: string,
  options?: McpStoreOptions
): McpServerConfig | null {
  const idCheck = mcpServerIdSchema.safeParse(id)
  if (!idCheck.success) return null
  return loadGlobalMcpServers(options).find((server) => server.id === idCheck.data) ?? null
}

function serializeGlobalRecord(
  config: McpServerConfig,
  codec: SecretCodec
): StoredMcpServerRecord {
  const normalized = normalizeServerByTransport(config)
  const stored: StoredMcpServerRecord = {
    id: normalized.id,
    name: normalized.name,
    enabled: normalized.enabled,
    transport: normalized.transport,
    updatedAt: Date.now(),
  }
  if (normalized.command !== undefined) stored.command = normalized.command
  if (normalized.args !== undefined) stored.args = [...normalized.args]
  if (normalized.cwd !== undefined) stored.cwd = normalized.cwd
  const encryptedEnv = encryptSecretRecord(normalized.env, codec)
  if (encryptedEnv) stored.env = encryptedEnv
  if (normalized.url !== undefined) stored.url = normalized.url
  const encryptedHeaders = encryptSecretRecord(normalized.headers, codec)
  if (encryptedHeaders) stored.headers = encryptedHeaders
  if (normalized.timeoutMs !== undefined) stored.timeoutMs = normalized.timeoutMs
  return stored
}

async function writeGlobalMcpServers(
  servers: McpServerConfig[],
  options?: McpStoreOptions
): Promise<void> {
  const appDir = resolveAppDir(options)
  const codec = resolveCodec(options)
  const payload: StoredGlobalMcpFile = {
    version: 1,
    servers: servers.map((server) => serializeGlobalRecord(server, codec)),
  }
  await writeJsonAtomic(globalMcpConfigPath(appDir), payload)
}

/**
 * 新增或更新全局 MCP 服务器。
 * - 使用 `mcpServerInputSchema` 严格校验入参；
 * - 更新既有服务器时通过 `mergeMaskedSecretRecord` 保留未改动的掩码密钥；
 * - 所有非空 `env`/`headers` 均经 `safeStorage` 加密后原子写入。
 */
export async function saveGlobalMcpServer(
  input: McpServerInput,
  options?: McpStoreOptions
): Promise<McpServerStatus> {
  const parsed = mcpServerInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(formatZodIssue(parsed.error))
  }

  const existingList = loadGlobalMcpServers(options)
  const existingIds = new Set(existingList.map((item) => item.id))
  const id = parsed.data.id ?? deriveUniqueServerId(parsed.data.name, existingIds)
  const existingIndex = existingList.findIndex((item) => item.id === id)
  const existing = existingIndex >= 0 ? existingList[existingIndex] : undefined

  const mergedEnv =
    parsed.data.transport === 'stdio'
      ? mergeMaskedSecretRecord(parsed.data.env, existing?.env)
      : undefined
  const mergedHeaders =
    parsed.data.transport !== 'stdio'
      ? mergeMaskedSecretRecord(parsed.data.headers, existing?.headers)
      : undefined

  const nextConfig = normalizeServerByTransport({
    id,
    name: parsed.data.name,
    enabled: parsed.data.enabled,
    transport: parsed.data.transport,
    command: parsed.data.command,
    args: parsed.data.args,
    cwd: parsed.data.cwd,
    env: mergedEnv,
    url: parsed.data.url,
    headers: mergedHeaders,
    timeoutMs: parsed.data.timeoutMs,
    source: 'global',
  })

  const nextList = [...existingList]
  if (existingIndex >= 0) {
    nextList[existingIndex] = nextConfig
  } else {
    nextList.push(nextConfig)
  }

  await writeGlobalMcpServers(nextList, options)
  bumpMcpConfigVersion()
  return toUiStatus(nextConfig)
}

export async function deleteGlobalMcpServer(
  id: string,
  options?: McpStoreOptions
): Promise<boolean> {
  const idCheck = mcpServerIdSchema.safeParse(id)
  if (!idCheck.success) return false
  const existingList = loadGlobalMcpServers(options)
  const filtered = existingList.filter((item) => item.id !== idCheck.data)
  if (filtered.length === existingList.length) return false
  await writeGlobalMcpServers(filtered, options)
  bumpMcpConfigVersion()
  return true
}

export async function setGlobalMcpServerEnabled(
  id: string,
  enabled: boolean,
  options?: McpStoreOptions
): Promise<McpServerStatus | null> {
  const idCheck = mcpServerIdSchema.safeParse(id)
  if (!idCheck.success) return null
  const existingList = loadGlobalMcpServers(options)
  const index = existingList.findIndex((item) => item.id === idCheck.data)
  if (index < 0) return null
  const updated: McpServerConfig = {
    ...existingList[index],
    enabled: Boolean(enabled),
    source: 'global',
  }
  const nextList = [...existingList]
  nextList[index] = updated
  await writeGlobalMcpServers(nextList, options)
  bumpMcpConfigVersion()
  return toUiStatus(updated)
}

// ---------------------------------------------------------------------------
// 项目级只读发现（.pi-workbench/mcp.json & .mcp.json）与 Fail-Closed 信任钉住
// ---------------------------------------------------------------------------

function inferTransport(raw: Record<string, unknown>): McpTransportType | null {
  const explicit = raw.transport ?? raw.type
  if (explicit === 'stdio' || explicit === 'http' || explicit === 'sse') {
    return explicit
  }
  if (explicit === 'streamable-http' || explicit === 'streamableHttp') {
    return 'http'
  }
  if (typeof raw.command === 'string' && raw.command.trim().length > 0) {
    return 'stdio'
  }
  if (typeof raw.url === 'string' && raw.url.trim().length > 0) {
    return 'http'
  }
  return null
}

function parseDiscoveredServerEntry(
  rawId: string,
  rawObj: unknown
): McpServerConfig | null {
  if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) return null
  const record = rawObj as Record<string, unknown>
  const transport = inferTransport(record)
  if (!transport) return null

  const id = rawId.trim()
  const name =
    typeof record.name === 'string' && record.name.trim().length > 0
      ? record.name.trim()
      : id
  const args = Array.isArray(record.args)
    ? record.args.filter((item): item is string => typeof item === 'string')
    : undefined
  const cwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd.trim() : undefined
  const command =
    typeof record.command === 'string' && record.command.trim()
      ? record.command.trim()
      : undefined
  const url = typeof record.url === 'string' && record.url.trim() ? record.url.trim() : undefined
  const env = sanitizePlainStringRecord(record.env)
  const headers = sanitizePlainStringRecord(record.headers)
  const timeoutMs =
    typeof record.timeoutMs === 'number' && Number.isInteger(record.timeoutMs)
      ? record.timeoutMs
      : undefined

  // 严禁读取仓库文件里的 enabled 字段：所有项目配置一律默认关闭，仅由私有 mcp-trust.json 决定启用
  const candidate = {
    id,
    name,
    enabled: false,
    transport,
    command,
    args,
    cwd,
    env,
    url,
    headers,
    timeoutMs,
    source: 'project' as const,
  }
  const parsed = mcpServerConfigSchema.safeParse(candidate)
  if (!parsed.success) return null
  return normalizeServerByTransport({ ...parsed.data, enabled: false, source: 'project' })
}

function readProjectConfigFile(workspaceRoot: string, filePath: string): McpServerConfig[] {
  try {
    if (!fs.existsSync(filePath)) return []
    const canonicalFile = canonicalizePath(filePath)
    if (!canonicalFile || !isPathInsideRoot(workspaceRoot, canonicalFile)) return []
    const stat = fs.statSync(canonicalFile)
    if (!stat.isFile() || stat.size > MAX_PROJECT_CONFIG_BYTES) return []

    const raw = fs.readFileSync(canonicalFile, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []

    const doc = parsed as Record<string, unknown>
    const discovered: McpServerConfig[] = []

    if (doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers)) {
      for (const [id, entry] of Object.entries(doc.mcpServers as Record<string, unknown>)) {
        if (!id || FORBIDDEN_KEYS.has(id)) continue
        const server = parseDiscoveredServerEntry(id, entry)
        if (server) discovered.push(server)
      }
    }

    if (Array.isArray(doc.servers)) {
      for (const entry of doc.servers) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        const id = (entry as Record<string, unknown>).id
        if (typeof id !== 'string' || !id.trim() || FORBIDDEN_KEYS.has(id.trim())) continue
        const server = parseDiscoveredServerEntry(id, entry)
        if (server) discovered.push(server)
      }
    }

    return discovered
  } catch {
    return []
  }
}

/**
 * 只读发现工作区中的项目级 MCP 配置（保留原始 `cwd` 字段以便指纹稳定计算）。
 * `.pi-workbench/mcp.json` 在同名 ID 冲突时优先于 `.mcp.json`。
 */
export function discoverProjectMcpServers(workspaceDir: string): McpServerConfig[] {
  const canonicalWs = canonicalizePath(workspaceDir)
  if (!canonicalWs) return []

  const candidates = [
    path.join(canonicalWs, '.pi-workbench', 'mcp.json'),
    path.join(canonicalWs, '.mcp.json'),
  ]
  const seen = new Set<string>()
  const result: McpServerConfig[] = []

  for (const filePath of candidates) {
    for (const server of readProjectConfigFile(canonicalWs, filePath)) {
      if (seen.has(server.id)) continue
      seen.add(server.id)
      result.push(server)
    }
  }
  return result
}

function readTrustStore(appDir: string): StoredMcpTrustFile {
  const res = readJsonWithBackup<StoredMcpTrustFile>(projectMcpTrustPath(appDir))
  if (
    !res.data ||
    typeof res.data !== 'object' ||
    !res.data.workspaces ||
    typeof res.data.workspaces !== 'object' ||
    Array.isArray(res.data.workspaces)
  ) {
    return { version: 1, workspaces: {} }
  }
  return {
    version: 1,
    workspaces: { ...res.data.workspaces },
  }
}

function evaluateProjectServerTrust(
  server: McpServerConfig,
  trustMap: Record<string, ProjectServerTrustEntry> | undefined
): { enabled: boolean; trusted: boolean; trustChanged: boolean; fingerprint: string } {
  const fingerprint = computeMcpServerFingerprint(server)
  const pinned = trustMap?.[server.id]
  if (pinned && pinned.enabled === true && pinned.fingerprint === fingerprint) {
    return { enabled: true, trusted: true, trustChanged: false, fingerprint }
  }
  const trustChanged = Boolean(
    pinned && pinned.enabled === true && pinned.fingerprint !== fingerprint
  )
  return { enabled: false, trusted: false, trustChanged, fingerprint }
}

/**
 * 更新项目级 MCP 服务器的信任授权状态（落盘于 `{appDir}/config/mcp-trust.json`）：
 * - `enabled === true`：计算当前配置的 SHA-256 指纹并钉住；
 * - `enabled === false`：删除该服务器的信任记录。
 */
export async function setProjectServerTrust(
  workspaceDir: string,
  serverId: string,
  enabled: boolean,
  options?: McpStoreOptions
): Promise<McpServerStatus | null> {
  const idCheck = mcpServerIdSchema.safeParse(serverId)
  if (!idCheck.success) {
    throw new Error(formatZodIssue(idCheck.error))
  }
  const cleanId = idCheck.data
  const appDir = resolveAppDir(options)
  const wsKey = workspaceTrustKey(workspaceDir)
  const discovered = discoverProjectMcpServers(workspaceDir)
  const target = discovered.find((server) => server.id === cleanId)

  const store = readTrustStore(appDir)
  const wsMap: Record<string, ProjectServerTrustEntry> = { ...(store.workspaces[wsKey] ?? {}) }

  if (enabled) {
    if (!target) {
      throw new Error(`Project MCP server "${cleanId}" was not found in this workspace.`)
    }
    const fingerprint = computeMcpServerFingerprint(target)
    wsMap[cleanId] = {
      enabled: true,
      fingerprint,
      updatedAt: Date.now(),
    }
    store.workspaces[wsKey] = wsMap
  } else {
    delete wsMap[cleanId]
    if (Object.keys(wsMap).length > 0) {
      store.workspaces[wsKey] = wsMap
    } else {
      delete store.workspaces[wsKey]
    }
  }

  await writeJsonAtomic(projectMcpTrustPath(appDir), store)
  bumpMcpConfigVersion()

  if (!target) return null
  const trust = evaluateProjectServerTrust(target, store.workspaces[wsKey])
  return toUiStatus(
    { ...target, enabled: trust.enabled, source: 'project' },
    { trusted: trust.trusted, trustChanged: trust.trustChanged }
  )
}

function bindProjectServerCwd(server: McpServerConfig, activeRoot: string): McpServerConfig {
  if (server.transport !== 'stdio') {
    return { ...server }
  }
  const rawCwd = server.cwd?.trim()
  const resolvedCwd = rawCwd
    ? path.isAbsolute(rawCwd)
      ? rawCwd
      : path.resolve(activeRoot, rawCwd)
    : activeRoot
  return {
    ...server,
    cwd: resolvedCwd,
  }
}

/**
 * 解析面向运行时的最终生效 MCP 服务器列表（解密后的真实配置）：
 * - 全部已启用的全局 MCP 服务器；
 * - 加上当前工作区中已批准且 SHA-256 指纹未漂移的项目 MCP 服务器（`cwd` 绑定到 `cwdOverride ?? workspaceDir`）；
 * - 若已验证的项目服务器与全局服务器同 ID，项目服务器优先覆盖全局项。
 */
export function resolveEffectiveMcpServers(
  workspaceDir: string,
  options?: ResolveEffectiveMcpOptions
): McpServerConfig[] {
  const appDir = resolveAppDir(options)
  const activeRoot = path.resolve(options?.cwdOverride ?? workspaceDir)

  const globalEnabled = loadGlobalMcpServers(options).filter((server) => server.enabled)
  const trustStore = readTrustStore(appDir)
  const wsTrust = trustStore.workspaces[workspaceTrustKey(workspaceDir)]

  const trustedProject: McpServerConfig[] = []
  for (const rawServer of discoverProjectMcpServers(workspaceDir)) {
    const trust = evaluateProjectServerTrust(rawServer, wsTrust)
    if (!trust.enabled || !trust.trusted) continue
    trustedProject.push({
      ...bindProjectServerCwd(rawServer, activeRoot),
      enabled: true,
      source: 'project',
    })
  }

  // 同 ID 时已验证的项目服务器优先覆盖全局配置，同时保持稳定顺序
  const projectById = new Map(trustedProject.map((server) => [server.id, server]))
  const merged: McpServerConfig[] = []
  const emittedIds = new Set<string>()

  for (const globalServer of globalEnabled) {
    const override = projectById.get(globalServer.id)
    if (override) {
      merged.push(override)
      emittedIds.add(override.id)
    } else {
      merged.push(globalServer)
      emittedIds.add(globalServer.id)
    }
  }

  for (const projectServer of trustedProject) {
    if (emittedIds.has(projectServer.id)) continue
    merged.push(projectServer)
    emittedIds.add(projectServer.id)
  }

  return merged
}

/** 获取单台项目级 MCP 服务器的完整配置（供用户显式点击「测试连接」时隔离探活使用） */
export function getProjectMcpServerConfig(
  workspaceDir: string,
  serverId: string,
  options?: ResolveEffectiveMcpOptions
): McpServerConfig | null {
  const idCheck = mcpServerIdSchema.safeParse(serverId)
  if (!idCheck.success) return null
  const activeRoot = path.resolve(options?.cwdOverride ?? workspaceDir)
  const found = discoverProjectMcpServers(workspaceDir).find(
    (server) => server.id === idCheck.data
  )
  if (!found) return null
  return {
    ...bindProjectServerCwd(found, activeRoot),
    enabled: true,
    source: 'project',
  }
}

/** 为表单内联连通性测试构造可执行配置（若命中已有全局服务器 ID，保留未改动的掩码密钥） */
export function resolveInlineMcpServerForTest(
  input: McpServerInput,
  options?: ResolveEffectiveMcpOptions
): McpServerConfig {
  const parsed = mcpServerInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(formatZodIssue(parsed.error))
  }
  const existing = parsed.data.id ? getGlobalMcpServerConfig(parsed.data.id, options) : null
  const env =
    parsed.data.transport === 'stdio'
      ? mergeMaskedSecretRecord(parsed.data.env, existing?.env)
      : undefined
  const headers =
    parsed.data.transport !== 'stdio'
      ? mergeMaskedSecretRecord(parsed.data.headers, existing?.headers)
      : undefined

  const base = normalizeServerByTransport({
    id: parsed.data.id ?? 'inline-test',
    name: parsed.data.name,
    enabled: true,
    transport: parsed.data.transport,
    command: parsed.data.command,
    args: parsed.data.args,
    cwd: parsed.data.cwd,
    env,
    url: parsed.data.url,
    headers,
    timeoutMs: parsed.data.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
    source: 'global',
  })

  if (options?.cwdOverride && base.transport === 'stdio' && base.cwd && !path.isAbsolute(base.cwd)) {
    return { ...base, cwd: path.resolve(options.cwdOverride, base.cwd) }
  }
  return base
}

/**
 * 返回面向设置页 UI 的脱敏快照（全局 + 当前工作区项目级）：
 * 所有 `env` / `headers` 值全部替换为 `MCP_SECRET_MASK`，永不向渲染进程暴露明文。
 */
export function listMcpServersForUi(
  workspaceDir?: string,
  options?: McpStoreOptions
): McpUiListSnapshot {
  const appDir = resolveAppDir(options)
  const globalStatuses = loadGlobalMcpServers(options).map((server) => toUiStatus(server))

  if (!workspaceDir) {
    return { global: globalStatuses, project: [] }
  }

  const trustStore = readTrustStore(appDir)
  const wsTrust = trustStore.workspaces[workspaceTrustKey(workspaceDir)]
  const projectStatuses = discoverProjectMcpServers(workspaceDir).map((rawServer) => {
    const trust = evaluateProjectServerTrust(rawServer, wsTrust)
    return toUiStatus(
      { ...rawServer, enabled: trust.enabled, source: 'project' },
      { trusted: trust.trusted, trustChanged: trust.trustChanged }
    )
  })

  return {
    global: globalStatuses,
    project: projectStatuses,
  }
}
