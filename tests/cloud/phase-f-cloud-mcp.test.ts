/**
 * Phase F · Step F3 云端 MCP 端到端测试：
 * 1. SQLite v2 → v3 迁移幂等性与 `mcp_servers` AES-256-GCM 静态加密存储（数据库零明文密钥）
 * 2. REST API（`GET /v1/mcp`、`PUT /v1/mcp/:id`、`DELETE /v1/mcp/:id`、`POST /v1/mcp/test`）——
 *    覆盖 Cookie CSRF 同源校验、设备 token 拒绝与桌面 `clientToken` 放行、掩码返回与更新保留原密钥、
 *    以及针对真实本地 `stdio` MCP 服务器与真实本地 Streamable HTTP MCP 服务器的隔离连通测试
 * 3. 云端 Agent 运行时集成：验证 `AgentManager.initialize` 装载启用的云端 MCP（`stdio` + HTTP）、
 *    `allowMcpTools: true` / 无审批直放行、实时状态融合、忙时不中断轮次且在下一轮边界重载，以及 `close()` 完整释放
 */

// @vitest-environment node

import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { AgentConfig, McpServerConfig, McpServerStatus } from '../../pi-bridge/src/index'
import { MCP_SECRET_MASK } from '../../pi-bridge/src/mcp'

const requireFromHere = createRequire(import.meta.url)
const repoRoot = path.resolve(__dirname, '../..')

const runtimeState = {
  busy: false,
  initializeCalls: 0,
  disposeCalls: 0,
  lastInitConfig: null as AgentConfig | null,
  lastConnectedHost: null as import('../../pi-bridge/src/index').McpClientHost | null,
}

let realMcpClientHostCtor: typeof import('../../pi-bridge/src/index').McpClientHost

class CloudMcpFakeAgentManager {
  private host: import('../../pi-bridge/src/index').McpClientHost | null = null

  async initialize(config: AgentConfig) {
    runtimeState.initializeCalls += 1
    runtimeState.lastInitConfig = config
    if (this.host) {
      await this.host.dispose()
      this.host = null
    }
    const servers = config.mcpServers ?? []
    if (servers.length > 0) {
      this.host = new realMcpClientHostCtor({
        logger: config.logger,
        defaultCwd: config.mcpCwd ?? config.workspaceDir,
        outputRedactor: config.mcpOutputRedactor,
      })
      await this.host.syncServers(servers)
    }
    runtimeState.lastConnectedHost = this.host
    return { success: true }
  }

  getMcpStatuses(): McpServerStatus[] {
    return this.host?.getStatuses() ?? []
  }

  async refreshMcpServers(servers: McpServerConfig[]): Promise<McpServerStatus[]> {
    if (!this.host) {
      this.host = new realMcpClientHostCtor()
    }
    return this.host.syncServers(servers)
  }

  async openSession() {
    return {
      success: true,
      session: { id: 'cloud-mcp-session', dispose: () => undefined, abort: async () => undefined },
      history: [],
    }
  }

  async subscribeTrace() {
    return { success: true }
  }

  isSessionBusy() {
    return runtimeState.busy
  }

  async chat() {
    return { success: true, response: 'ok' }
  }

  async steer() {
    return { success: true }
  }

  async abort() {
    return { success: true }
  }

  async sendCustomMessage() {
    return { success: true }
  }

  async dispose() {
    runtimeState.disposeCalls += 1
    if (this.host) {
      await this.host.dispose()
      this.host = null
    }
    runtimeState.lastConnectedHost = null
  }
}

vi.mock('pi-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pi-bridge/src/index')>()
  realMcpClientHostCtor = actual.McpClientHost
  return {
    ...actual,
    AgentManager: CloudMcpFakeAgentManager,
  }
})

const { CLOUD_DB_SCHEMA_VERSION, CloudStore } = await import('../../apps/cloud/src/store/store')
const { createCloudServer, loadCloudMcpServers } = await import('../../apps/cloud/src/main')
const { encryptSecret } = await import('../../apps/cloud/src/secure/config-crypto')

function sdkEsmFileUrl(subpath: string): string {
  return pathToFileURL(
    path.join(repoRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', subpath)
  ).href
}

async function writeRealStdioMcpServer(dir: string): Promise<string> {
  const serverUrl = sdkEsmFileUrl('server/index.js')
  const stdioUrl = sdkEsmFileUrl('server/stdio.js')
  const typesUrl = sdkEsmFileUrl('types.js')

  const script = `
import { Server } from ${JSON.stringify(serverUrl)};
import { StdioServerTransport } from ${JSON.stringify(stdioUrl)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(typesUrl)};

const server = new Server(
  { name: 'cloud-local-stdio-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo_env',
      description: 'Read configured cloud stdio MCP secret env',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { tag: { type: 'string' } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'echo_env') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            tag: request.params.arguments?.tag ?? null,
            secret: process.env.CLOUD_MCP_STDIO_SECRET ?? null,
          }),
        },
      ],
    };
  }
  throw new Error('Unknown tool: ' + request.params.name);
});

const transport = new StdioServerTransport();
await server.connect(transport);
`
  const filePath = path.join(dir, 'cloud-stdio-mcp.mjs')
  await fs.writeFile(filePath, script, 'utf-8')
  return filePath
}

async function startRealHttpMcpServer(): Promise<{
  url: string
  receivedTokens: Array<string | undefined>
  close: () => Promise<void>
}> {
  const receivedTokens: Array<string | undefined> = []

  const buildServer = () => {
    const server = new Server(
      { name: 'cloud-remote-http-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'ping_remote',
          description: 'Ping remote HTTP MCP endpoint',
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: 'object',
            properties: { note: { type: 'string' } },
          },
        },
      ],
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'ping_remote') {
        const note = String((request.params.arguments as Record<string, unknown> | undefined)?.note ?? '')
        return { content: [{ type: 'text', text: `remote-pong:${note}` }] }
      }
      throw new Error(`Unknown tool: ${request.params.name}`)
    })
    return server
  }

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      try {
        receivedTokens.push(
          typeof req.headers['x-cloud-token'] === 'string'
            ? req.headers['x-cloud-token']
            : undefined
        )
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        const raw = Buffer.concat(chunks).toString('utf-8')
        const parsedBody = raw ? (JSON.parse(raw) as unknown) : undefined
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        const mcpServer = buildServer()
        await mcpServer.connect(transport)
        await transport.handleRequest(req, res, parsedBody)
        await mcpServer.close().catch(() => undefined)
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500
          res.end(String(error))
        }
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => resolve())
  })
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    receivedTokens,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      }),
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for condition')
}

describe('Phase F · Step F3 · Cloud SQLite v3 & Encrypted MCP Store', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('migrates v2 SQLite DB to v3 idempotently and stores mcp_servers encrypted at rest without plaintext secrets', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-mcp-v3-'))
    tempDirs.push(dir)
    const dbPath = path.join(dir, 'cloud.db')

    const { DatabaseSync } = requireFromHere('node:sqlite') as typeof import('node:sqlite')
    const legacyV2 = new DatabaseSync(dbPath)
    legacyV2.exec(`
      CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE devices (id TEXT PRIMARY KEY, data_json TEXT NOT NULL, revoked_at INTEGER, last_seen_at INTEGER NOT NULL, token_kid TEXT, client_token_kid TEXT);
      CREATE TABLE pairing_codes (hash TEXT PRIMARY KEY, data_json TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE authorizations (id TEXT PRIMARY KEY, data_json TEXT NOT NULL, confirmed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE task_diffs (task_id TEXT PRIMARY KEY, diff_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE units (unit_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, closed_at INTEGER, created_at INTEGER NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE memories (id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL, source TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE dreams (id TEXT PRIMARY KEY, at INTEGER NOT NULL, trigger TEXT NOT NULL, summary TEXT NOT NULL, added INTEGER NOT NULL, merged INTEGER NOT NULL, removed INTEGER NOT NULL);
      INSERT INTO kv_state (key, value_json, updated_at) VALUES ('legacy_json_migrated', '{"migratedAt":1}', 1);
      PRAGMA user_version = 2;
    `)
    legacyV2.close()

    const encKey = Buffer.alloc(32, 0x2a)
    const store = await CloudStore.open(dir)
    expect(CLOUD_DB_SCHEMA_VERSION).toBe(3)
    expect(store.getSchemaVersion()).toBe(3)

    const plainSecret = 'super-secret-env-token-XYZ-9988'
    const fullConfig: McpServerConfig = {
      id: 'vps-helper',
      name: 'VPS Helper',
      enabled: true,
      transport: 'stdio',
      command: '/opt/pi-cloud/mcp/helper',
      args: ['--serve'],
      cwd: '/opt/pi-cloud/mcp',
      env: { SECRET_KEY: plainSecret },
      source: 'cloud',
    }
    store.upsertMcpServerRecord({
      id: fullConfig.id,
      name: fullConfig.name,
      transport: fullConfig.transport,
      enabled: true,
      configCipher: encryptSecret(JSON.stringify(fullConfig), encKey),
      updatedAt: 1000,
    })

    // 写入一条损坏密文记录，验证 loadCloudMcpServers 安全跳过并告警
    store.upsertMcpServerRecord({
      id: 'corrupt-row',
      name: 'Corrupt',
      transport: 'http',
      enabled: true,
      configCipher: 'v1.bad.cipher.payload',
      updatedAt: 900,
    })

    const records = store.listMcpServerRecords()
    expect(records).toHaveLength(2)
    expect(store.getMcpServerRecord('vps-helper')?.enabled).toBe(true)

    const warn = vi.fn()
    const loaded = loadCloudMcpServers(store, encKey, { warn })
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({
      id: 'vps-helper',
      source: 'cloud',
      env: { SECRET_KEY: plainSecret },
    })
    expect(warn).toHaveBeenCalledTimes(1)

    // 校验底层 SQLite 原始行中绝对不含明文密钥或明文命令
    const rawDb = new DatabaseSync(dbPath)
    const rawRow = rawDb
      .prepare('SELECT id, config_cipher FROM mcp_servers WHERE id = ?')
      .get('vps-helper') as { id: string; config_cipher: string }
    expect(rawRow.config_cipher.startsWith('v1.')).toBe(true)
    expect(rawRow.config_cipher).not.toContain(plainSecret)
    expect(rawRow.config_cipher).not.toContain('/opt/pi-cloud/mcp/helper')
    rawDb.close()

    expect(store.deleteMcpServerRecord('corrupt-row')).toBe(true)
    expect(store.deleteMcpServerRecord('non-existent')).toBe(false)
    store.close()

    // 再次打开 v3 数据库应完全幂等且数据完好
    const reopened = await CloudStore.open(dir)
    expect(reopened.getSchemaVersion()).toBe(3)
    expect(reopened.getMcpServerRecord('vps-helper')?.name).toBe('VPS Helper')
    reopened.close()
  })
})

describe('Phase F · Step F3 · Cloud MCP REST API & Runtime Reload', () => {
  let tmpRoot = ''
  let stdioScriptPath = ''
  let httpMcp: Awaited<ReturnType<typeof startRealHttpMcpServer>>
  let server: Awaited<ReturnType<typeof createCloudServer>>
  let baseUrl = ''
  let cookie = ''
  let clientToken = ''
  let deviceToken = ''
  const encryptionKey = Buffer.alloc(32, 7)

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-mcp-api-'))
    stdioScriptPath = await writeRealStdioMcpServer(tmpRoot)
    httpMcp = await startRealHttpMcpServer()

    server = await createCloudServer(
      {
        dataDir: path.join(tmpRoot, 'data'),
        workspaceDir: path.join(tmpRoot, 'workspace'),
        agentDir: path.join(tmpRoot, 'agent'),
        port: 0,
        encryptionKey,
        cookieSecret: 'cloud-mcp-cookie-secret',
        secureCookies: false,
        version: '0.11.2-test',
      },
      {
        probeConfig: async () => ({ ok: true }),
      }
    )
    const port = await server.listen()
    baseUrl = `http://127.0.0.1:${port}`

    await fetch(`${baseUrl}/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'admin-password-123' }),
    })
    const login = await fetch(`${baseUrl}/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'admin-password-123' }),
    })
    cookie = (login.headers.getSetCookie?.() ?? [])[0].split(';')[0]

    const codeRes = await fetch(`${baseUrl}/v1/pair/code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: baseUrl,
      },
      body: JSON.stringify({}),
    })
    const { code } = (await codeRes.json()) as { code: string }
    const pairRes = await fetch(`${baseUrl}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'Desktop Test', platform: 'win32', workspaces: [] }),
    })
    const paired = (await pairRes.json()) as { token: string; clientToken: string }
    deviceToken = paired.token
    clientToken = paired.clientToken
  })

  afterAll(async () => {
    await server?.close()
    await httpMcp?.close()
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
  })

  beforeEach(() => {
    runtimeState.busy = false
    httpMcp.receivedTokens.length = 0
  })

  const cookieHeaders = () => ({
    'content-type': 'application/json',
    cookie,
    origin: baseUrl,
  })

  it('enforces auth (rejects anonymous/device token, rejects cross-origin cookie CSRF, allows admin cookie & clientToken)', async () => {
    const anon = await fetch(`${baseUrl}/v1/mcp`)
    expect(anon.status).toBe(401)

    const withDeviceToken = await fetch(`${baseUrl}/v1/mcp`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    })
    expect(withDeviceToken.status).toBe(401)

    const withClientToken = await fetch(`${baseUrl}/v1/mcp`, {
      headers: { authorization: `Bearer ${clientToken}` },
    })
    expect(withClientToken.status).toBe(200)
    expect(await withClientToken.json()).toEqual({ servers: [] })

    // 跨站 Cookie 写操作必须被 CSRF 拦截返回 403
    const crossOriginPut = await fetch(`${baseUrl}/v1/mcp/evil-csrf`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'https://evil.example',
      },
      body: JSON.stringify({
        name: 'Evil',
        transport: 'http',
        url: httpMcp.url,
        enabled: true,
      }),
    })
    expect(crossOriginPut.status).toBe(403)
  })

  it('supports CRUD, masked secret preservation, and real stdio + Streamable HTTP test probes', async () => {
    // 1) 创建云端本地 stdio 服务器（带敏感 env）
    const putStdio = await fetch(`${baseUrl}/v1/mcp/local-stdio`, {
      method: 'PUT',
      headers: cookieHeaders(),
      body: JSON.stringify({
        name: 'Local Stdio MCP',
        transport: 'stdio',
        command: process.execPath,
        args: [stdioScriptPath],
        env: { CLOUD_MCP_STDIO_SECRET: 'stdio-secret-42' },
        enabled: true,
      }),
    })
    expect(putStdio.status).toBe(200)
    const stdioPayload = (await putStdio.json()) as { ok: boolean; server: McpServerStatus }
    expect(stdioPayload.ok).toBe(true)
    expect(stdioPayload.server.envMasked).toEqual({ CLOUD_MCP_STDIO_SECRET: MCP_SECRET_MASK })
    expect(JSON.stringify(stdioPayload)).not.toContain('stdio-secret-42')

    // 2) 创建远程 Streamable HTTP 服务器（通过桌面端 clientToken 代理链路，带敏感 headers）
    const putHttp = await fetch(`${baseUrl}/v1/mcp/remote-http`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${clientToken}`,
      },
      body: JSON.stringify({
        name: 'Remote HTTP MCP',
        transport: 'http',
        url: httpMcp.url,
        headers: { 'x-cloud-token': 'http-secret-77' },
        enabled: true,
      }),
    })
    expect(putHttp.status).toBe(200)
    const httpPayload = (await putHttp.json()) as { ok: boolean; server: McpServerStatus }
    expect(httpPayload.server.headersMasked).toEqual({ 'x-cloud-token': MCP_SECRET_MASK })
    expect(JSON.stringify(httpPayload)).not.toContain('http-secret-77')

    // 3) GET /v1/mcp 严格返回脱敏掩码
    const listRes = await fetch(`${baseUrl}/v1/mcp`, { headers: { cookie } })
    expect(listRes.status).toBe(200)
    const listed = (await listRes.json()) as { servers: McpServerStatus[] }
    expect(listed.servers.map((s) => s.id).sort()).toEqual(['local-stdio', 'remote-http'])
    expect(JSON.stringify(listed)).not.toContain('stdio-secret-42')
    expect(JSON.stringify(listed)).not.toContain('http-secret-77')

    // 4) 更新 remote-http 时提交掩码占位，原 header 密钥必须完整保留
    const updateHttp = await fetch(`${baseUrl}/v1/mcp/remote-http`, {
      method: 'PUT',
      headers: cookieHeaders(),
      body: JSON.stringify({
        name: 'Remote HTTP MCP v2',
        transport: 'http',
        url: httpMcp.url,
        headers: { 'x-cloud-token': MCP_SECRET_MASK },
        enabled: true,
      }),
    })
    expect(updateHttp.status).toBe(200)

    // 5) POST /v1/mcp/test 实测已保存的真实 stdio 服务器
    const testStdioRes = await fetch(`${baseUrl}/v1/mcp/test`, {
      method: 'POST',
      headers: cookieHeaders(),
      body: JSON.stringify({ id: 'local-stdio' }),
    })
    expect(testStdioRes.status).toBe(200)
    const testStdio = (await testStdioRes.json()) as {
      ok: boolean
      tools: Array<{ name: string; readOnly: boolean }>
      latencyMs: number
    }
    expect(testStdio.ok).toBe(true)
    expect(testStdio.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'echo_env', readOnly: true })])
    )
    expect(testStdio.latencyMs).toBeGreaterThanOrEqual(0)

    // 6) POST /v1/mcp/test 实测已保存的真实 HTTP 服务器，并确认保留的明文 header 确实送达远端
    httpMcp.receivedTokens.length = 0
    const testHttpRes = await fetch(`${baseUrl}/v1/mcp/test`, {
      method: 'POST',
      headers: cookieHeaders(),
      body: JSON.stringify({ id: 'remote-http' }),
    })
    expect(testHttpRes.status).toBe(200)
    const testHttp = (await testHttpRes.json()) as {
      ok: boolean
      tools: Array<{ name: string }>
      latencyMs: number
    }
    expect(testHttp.ok).toBe(true)
    expect(testHttp.tools.map((tool) => tool.name)).toContain('ping_remote')
    expect(httpMcp.receivedTokens).toContain('http-secret-77')

    // 7) POST /v1/mcp/test 支持未保存草稿（带已保存 id 时同样自动合并掩码密钥）
    httpMcp.receivedTokens.length = 0
    const testDraftRes = await fetch(`${baseUrl}/v1/mcp/test`, {
      method: 'POST',
      headers: cookieHeaders(),
      body: JSON.stringify({
        config: {
          id: 'remote-http',
          name: 'Draft Probe',
          transport: 'http',
          url: httpMcp.url,
          headers: { 'x-cloud-token': MCP_SECRET_MASK },
          enabled: true,
        },
      }),
    })
    expect(testDraftRes.status).toBe(200)
    const testDraft = (await testDraftRes.json()) as { ok: boolean }
    expect(testDraft.ok).toBe(true)
    expect(httpMcp.receivedTokens).toContain('http-secret-77')
  })

  it('loads enabled cloud MCP servers into Cloud AgentManager with allowMcpTools=true and defers reload when busy until turn boundary', async () => {
    // 先写入一个禁用服务器，确认不会传给 AgentManager
    await fetch(`${baseUrl}/v1/mcp/disabled-one`, {
      method: 'PUT',
      headers: cookieHeaders(),
      body: JSON.stringify({
        name: 'Disabled MCP',
        transport: 'http',
        url: httpMcp.url,
        enabled: false,
      }),
    })

    // 推送云端模型配置并触发首次初始化
    await server.store.saveCloudConfig({
      providerId: 'deepseek',
      model: 'deepseek-chat',
      credentialCipher: encryptSecret(
        JSON.stringify({ type: 'api_key', key: 'sk-test-cloud-mcp' }),
        encryptionKey
      ),
      updatedAt: Date.now(),
    })

    const snap = await server.snapshot()
    expect(snap.protocol).toBe(1)

    expect(runtimeState.lastInitConfig).not.toBeNull()
    expect(runtimeState.lastInitConfig?.allowMcpTools).toBe(true)
    expect(runtimeState.lastInitConfig?.builtinExtensions).toEqual({
      approval: false,
      plan: false,
      worktree: false,
    })
    expect(runtimeState.lastInitConfig?.getDefaultPermissionLevel?.()).toBe('auto')
    expect((runtimeState.lastInitConfig?.mcpServers ?? []).map((s) => s.id).sort()).toEqual([
      'local-stdio',
      'remote-http',
    ])

    // 验证真实连接的 stdio MCP 工具能直接读到解密后的 env，HTTP MCP 工具也能直接调用
    expect(runtimeState.lastConnectedHost).not.toBeNull()
    const stdioCall = await runtimeState.lastConnectedHost!.callTool('mcp__local-stdio__echo_env', {
      tag: 'runtime',
    })
    expect(stdioCall.isError).toBeUndefined()
    expect(stdioCall.content[0]).toMatchObject({ type: 'text' })
    const stdioBody = JSON.parse(
      (stdioCall.content[0] as { type: 'text'; text: string }).text
    ) as { tag: string; secret: string }
    expect(stdioBody).toEqual({ tag: 'runtime', secret: 'stdio-secret-42' })

    const httpCall = await runtimeState.lastConnectedHost!.callTool(
      'mcp__remote-http__ping_remote',
      { note: 'hello' }
    )
    expect(httpCall.isError).toBeUndefined()
    expect((httpCall.content[0] as { type: 'text'; text: string }).text).toBe('remote-pong:hello')

    // GET /v1/mcp 合并实时运行期 connected 状态与已发现工具
    const liveListRes = await fetch(`${baseUrl}/v1/mcp`, { headers: { cookie } })
    const liveList = (await liveListRes.json()) as { servers: McpServerStatus[] }
    const liveStdio = liveList.servers.find((s) => s.id === 'local-stdio')
    const liveDisabled = liveList.servers.find((s) => s.id === 'disabled-one')
    expect(liveStdio?.state).toBe('connected')
    expect(liveStdio?.tools.map((t) => t.name)).toContain('echo_env')
    expect(liveDisabled?.state).toBe('disabled')

    // 模拟会话正忙：此时修改 / 删除 MCP 服务器绝不可打断当前轮次
    runtimeState.busy = true
    const initCountBeforeBusyEdit = runtimeState.initializeCalls
    const disposeCountBeforeBusyEdit = runtimeState.disposeCalls

    const delRes = await fetch(`${baseUrl}/v1/mcp/disabled-one`, {
      method: 'DELETE',
      headers: cookieHeaders(),
    })
    expect(delRes.status).toBe(200)
    const delMissing = await fetch(`${baseUrl}/v1/mcp/disabled-one`, {
      method: 'DELETE',
      headers: cookieHeaders(),
    })
    expect(delMissing.status).toBe(404)

    // 停用 remote-http（仍在忙）
    const disableRes = await fetch(`${baseUrl}/v1/mcp/remote-http`, {
      method: 'PUT',
      headers: cookieHeaders(),
      body: JSON.stringify({
        name: 'Remote HTTP MCP v2',
        transport: 'http',
        url: httpMcp.url,
        headers: { 'x-cloud-token': MCP_SECRET_MASK },
        enabled: false,
      }),
    })
    expect(disableRes.status).toBe(200)

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(runtimeState.disposeCalls).toBe(disposeCountBeforeBusyEdit)
    expect(runtimeState.initializeCalls).toBe(initCountBeforeBusyEdit)

    // 轮次结束进入下一轮边界（session.say 调用 ready -> ensureAgent）：此时重载生效
    runtimeState.busy = false
    const sayRes = await server.session.say('检查当前云端 MCP', 'msg-turn-boundary')
    expect(sayRes.success).toBe(true)
    expect(runtimeState.disposeCalls).toBe(disposeCountBeforeBusyEdit + 1)
    expect(runtimeState.initializeCalls).toBe(initCountBeforeBusyEdit + 1)
    expect((runtimeState.lastInitConfig?.mcpServers ?? []).map((s) => s.id)).toEqual(['local-stdio'])

    // 空闲态修改 MCP 服务器应立即触发平滑重载
    const initCountBeforeIdleEdit = runtimeState.initializeCalls
    const reEnableRes = await fetch(`${baseUrl}/v1/mcp/remote-http`, {
      method: 'PUT',
      headers: cookieHeaders(),
      body: JSON.stringify({
        name: 'Remote HTTP MCP v2',
        transport: 'http',
        url: httpMcp.url,
        headers: { 'x-cloud-token': MCP_SECRET_MASK },
        enabled: true,
      }),
    })
    expect(reEnableRes.status).toBe(200)
    await waitUntil(() => runtimeState.initializeCalls > initCountBeforeIdleEdit)
    expect((runtimeState.lastInitConfig?.mcpServers ?? []).map((s) => s.id).sort()).toEqual([
      'local-stdio',
      'remote-http',
    ])
  })
})
