/**
 * Phase F · Step F1 测试：
 * 1. `pi-bridge/mcp` 浏览器安全子路径（零 node:* / MCP SDK / Pi SDK 导入）、工具命名、密钥掩码与 Zod 校验
 * 2. 真实本地 stdio MCP 服务器端到端测试（连接、工具发现、只读注解、环境清洗、脱敏、128 KB 截断、Pi 扩展注册与资源回收）
 * 3. 真实本地 Streamable HTTP MCP 服务器测试（`testServer()` 隔离探测 + 自定义请求头 + `syncServers` 调用）
 * 4. 单台失败隔离与禁用服务器状态
 * 5. 权限与工具策略集成（`resolveModeTools`、`categorizeTool`、`buildApprovalDetails`、`createApprovalExtension`）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  MCP_MAX_TOOL_TEXT_BYTES,
  McpClientHost,
  buildSessionExtensionFactories,
  computeMcpServerFingerprint,
  createMcpExtension,
  type AgentLogger,
  type McpServerConfig,
} from '../../pi-bridge/src/index'
import {
  MCP_SECRET_MASK,
  canonicalMcpFingerprintInput,
  canonicalizeMcpServerForHash,
  isMcpToolName,
  maskMcpSecretRecord,
  mcpQualifiedToolName,
  mcpServerConfigSchema,
  mcpServerIdSchema,
  mcpServerInputSchema,
  mergeMaskedSecretRecord,
} from '../../pi-bridge/src/mcp'
import {
  buildApprovalDetails,
  categorizeTool,
  type ApprovalRequestPayload,
  type SessionPermission,
} from '../../pi-bridge/src/approval-policy'
import { createApprovalExtension } from '../../pi-bridge/src/approval-extension'
import { resolveModeTools } from '../../pi-bridge/src/tool-policy'

const repoRoot = path.resolve(__dirname, '../..')

const silentLogger: AgentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

function sdkEsmFileUrl(subpath: string): string {
  return pathToFileURL(
    path.join(repoRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', subpath)
  ).href
}

/** 生成一个使用真实 MCP SDK（Server + StdioServerTransport）的本地 stdio MCP 服务器脚本 */
async function writeTestStdioMcpServer(dir: string): Promise<string> {
  const serverUrl = sdkEsmFileUrl('server/index.js')
  const stdioUrl = sdkEsmFileUrl('server/stdio.js')
  const typesUrl = sdkEsmFileUrl('types.js')

  const script = `
import { Server } from ${JSON.stringify(serverUrl)};
import { StdioServerTransport } from ${JSON.stringify(stdioUrl)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(typesUrl)};

const server = new Server(
  { name: 'test-stdio-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read_item',
      description: 'Read an item and inspect sanitized environment',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
    {
      name: 'mutate_item',
      description: 'Mutate an item (writes state)',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
    {
      name: 'huge_output',
      description: 'Return an oversized payload to test truncation',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'failing_tool',
      description: 'Always returns an error result',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name === 'read_item') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id: args.id,
            hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
            explicitToken: process.env.MCP_TEST_TOKEN ?? null,
          }),
        },
      ],
    };
  }
  if (name === 'mutate_item') {
    return {
      content: [
        {
          type: 'text',
          text: 'mutated:' + String(args.name ?? '') + ':SECRET_VALUE_999',
        },
      ],
    };
  }
  if (name === 'huge_output') {
    return {
      content: [{ type: 'text', text: 'A'.repeat(160 * 1024) }],
    };
  }
  if (name === 'failing_tool') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'boom:SECRET_VALUE_999' }],
    };
  }
  throw new Error('Unknown tool: ' + name);
});

const transport = new StdioServerTransport();
await server.connect(transport);
`

  const filePath = path.join(dir, 'stdio-mcp-server.mjs')
  await fs.writeFile(filePath, script, 'utf-8')
  return filePath
}

async function startLocalHttpMcpServer(): Promise<{
  url: string
  receivedHeaders: Array<string | undefined>
  close: () => Promise<void>
}> {
  const receivedHeaders: Array<string | undefined> = []

  const createServerInstance = () => {
    const server = new Server(
      { name: 'test-http-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'ping_http',
          description: 'Ping over Streamable HTTP',
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: 'object',
            properties: { msg: { type: 'string' } },
          },
        },
      ],
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'ping_http') {
        const msg = String((request.params.arguments as Record<string, unknown> | undefined)?.msg ?? '')
        return { content: [{ type: 'text', text: `pong:${msg}` }] }
      }
      throw new Error(`Unknown tool: ${request.params.name}`)
    })
    return server
  }

  const httpServer = http.createServer((req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end('Not Found')
      return
    }
    if (req.method === 'GET') {
      res.writeHead(405).end('Method Not Allowed')
      return
    }
    receivedHeaders.push(
      typeof req.headers['x-mcp-test-header'] === 'string'
        ? req.headers['x-mcp-test-header']
        : undefined
    )
    const server = createServerInstance()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    })
    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500).end(String(error))
        }
      })
  })

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve())
  })
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind local HTTP MCP server')
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    receivedHeaders,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve())
      }),
  }
}

describe('pi-bridge/mcp browser-safe subpath & pure helpers', () => {
  it('resolves pi-bridge/mcp and guarantees zero node:*, MCP SDK, or Pi SDK imports', async () => {
    const mcpMod = await import('pi-bridge/mcp')
    expect(mcpMod.MCP_TOOL_PREFIX).toBe('mcp__')
    expect(mcpMod.MCP_SECRET_MASK).toBe('••••••••')
    expect(mcpMod.isMcpToolName('mcp__demo__list')).toBe(true)
    expect(mcpMod.isMcpToolName('read')).toBe(false)

    const forbiddenImport =
      /\bfrom\s+['"](?:node:|fs(?:\/promises)?|path|os|crypto|child_process|http|https|net|tls|url|stream|worker_threads|@modelcontextprotocol\/sdk|@earendil-works\/pi-)/

    const files = [
      path.join(repoRoot, 'pi-bridge/src/mcp.ts'),
      path.join(repoRoot, 'pi-bridge/src/mcp-types.ts'),
      path.join(repoRoot, 'pi-bridge/dist/mcp.js'),
      path.join(repoRoot, 'pi-bridge/dist/mcp-types.js'),
    ]
    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8')
      expect(content, `${path.relative(repoRoot, file)} must stay browser-safe`).not.toMatch(
        forbiddenImport
      )
    }
  })

  it('produces valid, deterministic qualified tool names <= 64 chars', () => {
    expect(isMcpToolName('mcp__github__list_issues')).toBe(true)
    expect(isMcpToolName('mcp__')).toBe(false)
    expect(isMcpToolName('read')).toBe(false)
    expect(mcpQualifiedToolName('github', 'list_issues')).toBe('mcp__github__list_issues')
    expect(mcpQualifiedToolName('my.server 1', 'get/user:info')).toBe(
      'mcp__my_server_1__get_user_info'
    )

    const longA = mcpQualifiedToolName(
      'very-long-enterprise-mcp-server-identifier',
      'execute_really_long_operation_name_variant_alpha'
    )
    const longB = mcpQualifiedToolName(
      'very-long-enterprise-mcp-server-identifier',
      'execute_really_long_operation_name_variant_beta'
    )
    expect(longA.length).toBeLessThanOrEqual(64)
    expect(longB.length).toBeLessThanOrEqual(64)
    expect(longA).toMatch(/^mcp__[a-zA-Z0-9_-]+$/)
    expect(longB).toMatch(/^mcp__[a-zA-Z0-9_-]+$/)
    expect(longA).not.toBe(longB)
    expect(longA).toBe(
      mcpQualifiedToolName(
        'very-long-enterprise-mcp-server-identifier',
        'execute_really_long_operation_name_variant_alpha'
      )
    )
  })

  it('masks and merges secret records without leaking plaintext or saving literal masks', () => {
    const existing = { API_KEY: 'secret-1', KEEP_ME: 'secret-2', DELETE_ME: 'secret-3' }
    expect(maskMcpSecretRecord(existing)).toEqual({
      API_KEY: MCP_SECRET_MASK,
      KEEP_ME: MCP_SECRET_MASK,
      DELETE_ME: MCP_SECRET_MASK,
    })
    expect(maskMcpSecretRecord({})).toBeUndefined()
    expect(maskMcpSecretRecord(undefined)).toBeUndefined()

    const merged = mergeMaskedSecretRecord(
      {
        API_KEY: 'rotated-secret',
        KEEP_ME: MCP_SECRET_MASK,
        PHANTOM_MASK: MCP_SECRET_MASK,
        ADDED: 'new-val',
      },
      existing
    )
    expect(merged).toEqual({
      API_KEY: 'rotated-secret',
      KEEP_ME: 'secret-2',
      ADDED: 'new-val',
    })
  })

  it('produces deterministic canonical hash input and SHA-256 fingerprint', () => {
    const cfgA: McpServerConfig = {
      id: 'srv',
      name: 'Display A',
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: ['a.js'],
      env: { B: '2', A: '1' },
    }
    const cfgB: McpServerConfig = {
      id: 'srv',
      name: 'Display B (name does not change fingerprint)',
      enabled: false,
      transport: 'stdio',
      command: 'node',
      args: ['a.js'],
      env: { A: '1', B: '2' },
    }
    expect(canonicalizeMcpServerForHash(cfgA)).toBe(canonicalMcpFingerprintInput(cfgB))
    expect(computeMcpServerFingerprint(cfgA)).toBe(computeMcpServerFingerprint(cfgB))
    expect(computeMcpServerFingerprint(cfgA)).toMatch(/^[0-9a-f]{64}$/)

    const mutated = { ...cfgA, args: ['b.js'] }
    expect(computeMcpServerFingerprint(mutated)).not.toBe(computeMcpServerFingerprint(cfgA))
  })

  it('validates MCP server configs with Zod schemas', () => {
    expect(mcpServerIdSchema.safeParse('github_1').success).toBe(true)
    expect(mcpServerIdSchema.safeParse('../escape').success).toBe(false)

    // stdio requires non-empty command and <= 64 args
    expect(
      mcpServerConfigSchema.safeParse({
        id: 'local',
        name: 'Local',
        enabled: true,
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        timeoutMs: 10_000,
      }).success
    ).toBe(true)

    expect(
      mcpServerConfigSchema.safeParse({
        id: 'local',
        name: 'Local',
        enabled: true,
        transport: 'stdio',
        command: '   ',
      }).success
    ).toBe(false)

    expect(
      mcpServerConfigSchema.safeParse({
        id: 'local',
        name: 'Local',
        enabled: true,
        transport: 'stdio',
        command: 'node',
        args: Array.from({ length: 65 }, (_, i) => String(i)),
      }).success
    ).toBe(false)

    // http / sse require valid http(s) URL
    expect(
      mcpServerInputSchema.safeParse({
        name: 'Remote',
        transport: 'http',
        url: 'https://mcp.example.com/v1',
      }).success
    ).toBe(true)

    expect(
      mcpServerConfigSchema.safeParse({
        id: 'remote',
        name: 'Remote',
        enabled: true,
        transport: 'sse',
        url: 'file:///etc/passwd',
      }).success
    ).toBe(false)

    // timeoutMs bounds 1_000..120_000
    expect(
      mcpServerConfigSchema.safeParse({
        id: 'local',
        name: 'Local',
        enabled: true,
        transport: 'stdio',
        command: 'node',
        timeoutMs: 500,
      }).success
    ).toBe(false)

    expect(
      mcpServerConfigSchema.safeParse({
        id: 'local',
        name: 'Local',
        enabled: true,
        transport: 'stdio',
        command: 'node',
        timeoutMs: 120_001,
      }).success
    ).toBe(false)

    // env max 64 keys
    const tooManyEnv: Record<string, string> = {}
    for (let i = 0; i < 65; i += 1) tooManyEnv[`K_${i}`] = 'v'
    expect(
      mcpServerConfigSchema.safeParse({
        id: 'local',
        name: 'Local',
        enabled: true,
        transport: 'stdio',
        command: 'node',
        env: tooManyEnv,
      }).success
    ).toBe(false)
  })
})

describe('McpClientHost real stdio & HTTP MCP servers', () => {
  let tmpDir = ''
  let serverScript = ''
  let host: McpClientHost | null = null
  const prevOpenAiKey = process.env.OPENAI_API_KEY

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-mcp-test-'))
    serverScript = await writeTestStdioMcpServer(tmpDir)
  })

  afterEach(async () => {
    if (host) {
      await host.dispose()
      host = null
    }
    if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevOpenAiKey

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }
  })

  it('connects a real stdio MCP server, discovers tools, calls with redaction/truncation, registers Pi extension, and disposes cleanly', async () => {
    process.env.OPENAI_API_KEY = 'sk-should-not-leak-to-mcp'

    const registeredPids: number[] = []
    const unregistered = vi.fn()
    host = new McpClientHost({
      logger: silentLogger,
      defaultCwd: tmpDir,
      onChildPid: (pid) => {
        registeredPids.push(pid)
        return unregistered
      },
      outputRedactor: (text) => text.replaceAll('SECRET_VALUE_999', '[REDACTED]'),
    })

    const statuses = await host.syncServers([
      {
        id: 'local-demo',
        name: 'Local Demo',
        enabled: true,
        transport: 'stdio',
        command: process.execPath,
        args: [serverScript],
        env: { MCP_TEST_TOKEN: 'explicit-secret' },
        source: 'global',
      },
    ])

    expect(statuses).toHaveLength(1)
    expect(statuses[0].state).toBe('connected')
    expect(statuses[0].envMasked).toEqual({ MCP_TEST_TOKEN: MCP_SECRET_MASK })
    expect(statuses[0].tools.map((t) => t.name)).toEqual([
      'read_item',
      'mutate_item',
      'huge_output',
      'failing_tool',
    ])
    expect(registeredPids).toHaveLength(1)
    expect(registeredPids[0]).toBeGreaterThan(0)

    const readTool = mcpQualifiedToolName('local-demo', 'read_item')
    const mutateTool = mcpQualifiedToolName('local-demo', 'mutate_item')
    const hugeTool = mcpQualifiedToolName('local-demo', 'huge_output')
    const failingTool = mcpQualifiedToolName('local-demo', 'failing_tool')

    expect(host.isReadOnlyTool(readTool)).toBe(true)
    expect(host.isReadOnlyTool(mutateTool)).toBe(false)
    expect(host.isReadOnlyTool(failingTool)).toBe(false)

    // Verify sanitized base env + explicit config env overlay
    const readRes = await host.callTool(readTool, { id: 'item-42' })
    expect(readRes.isError).toBeUndefined()
    expect(readRes.content[0]).toMatchObject({ type: 'text' })
    const parsedRead = JSON.parse((readRes.content[0] as { type: 'text'; text: string }).text)
    expect(parsedRead).toEqual({
      id: 'item-42',
      hasOpenAiKey: false,
      explicitToken: 'explicit-secret',
    })

    // Verify redaction on mutating tool output
    const mutateRes = await host.callTool(mutateTool, { name: 'alpha' })
    expect(mutateRes.isError).toBeUndefined()
    expect((mutateRes.content[0] as { type: 'text'; text: string }).text).toBe(
      'mutated:alpha:[REDACTED]'
    )

    // Verify 128 KB truncation cap + notice
    const hugeRes = await host.callTool(hugeTool, {})
    const joinedHuge = hugeRes.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('')
    expect(hugeRes.details?.truncated).toBe(true)
    expect(joinedHuge).toContain('[Output truncated at 128 KB]')
    expect(Buffer.byteLength((hugeRes.content[0] as { text: string }).text, 'utf-8')).toBeLessThanOrEqual(
      MCP_MAX_TOOL_TEXT_BYTES
    )

    // Verify server-reported isError is preserved and redacted without throwing
    const failRes = await host.callTool(failingTool, {})
    expect(failRes.isError).toBe(true)
    expect((failRes.content[0] as { text: string }).text).toBe('boom:[REDACTED]')

    // Verify Pi extension registers all tools and executes through McpClientHost
    const registeredTools: any[] = []
    const factory = createMcpExtension(host)
    await factory({
      registerTool: (def: any) => registeredTools.push(def),
    } as any)
    expect(registeredTools).toHaveLength(4)
    const extRead = registeredTools.find((t) => t.name === readTool)
    expect(extRead.description).toContain('[MCP: Local Demo]')
    expect(extRead.annotations?.readOnlyHint).toBe(true)
    const extExec = await extRead.execute('tc-1', { id: 'via-ext' }, undefined, undefined, {} as any)
    expect(JSON.parse(extExec.content[0].text).id).toBe('via-ext')

    // Verify buildSessionExtensionFactories wires MCP extension & read-only approval check
    const factories = buildSessionExtensionFactories({
      id: 'sess-mcp',
      config: {
        workspaceDir: tmpDir,
        apiConfig: { providerId: 'openai', modelId: 'gpt-5' },
        builtinExtensions: { plan: false, worktree: false },
      },
      logger: silentLogger,
      sessionManager: { getCwd: () => tmpDir } as any,
      planContext: { runtime: null },
      controllerRef: { current: null },
      fallbackPermission: { mode: 'readonly', grants: [] },
      mcpHost: host,
      onWorktreeSwitch: async () => ({ success: false }),
    })
    const wiredTools: string[] = []
    let wiredToolCall: ((event: any, ctx?: any) => Promise<any>) | null = null
    for (const extFactory of factories) {
      await extFactory({
        registerTool: (def: any) => wiredTools.push(def.name),
        on: (event: string, handler: any) => {
          if (event === 'tool_call') wiredToolCall = handler
        },
      } as any)
    }
    expect(wiredTools).toContain(readTool)
    expect(wiredTools).toContain(mutateTool)
    expect(await wiredToolCall!({ toolCallId: 'w1', toolName: readTool, input: {} })).toBeUndefined()
    expect(await wiredToolCall!({ toolCallId: 'w2', toolName: mutateTool, input: {} })).toMatchObject({
      block: true,
    })

    // Dispose cleanly unregisters child PID
    await host.dispose()
    host = null
    expect(unregistered).toHaveBeenCalledTimes(1)
  })

  it('isolates per-server connection failures and keeps sibling servers connected', async () => {
    host = new McpClientHost({ logger: silentLogger, defaultCwd: tmpDir })

    const statuses = await host.syncServers([
      {
        id: 'disabled-srv',
        name: 'Disabled Server',
        enabled: false,
        transport: 'stdio',
        command: 'does-not-matter',
      },
      {
        id: 'broken-srv',
        name: 'Broken Server',
        enabled: true,
        transport: 'stdio',
        command: '__nonexistent_mcp_binary_phase_f__',
        timeoutMs: 3_000,
      },
      {
        id: 'healthy-srv',
        name: 'Healthy Server',
        enabled: true,
        transport: 'stdio',
        command: process.execPath,
        args: [serverScript],
      },
    ])

    expect(statuses.map((s) => [s.id, s.state])).toEqual([
      ['disabled-srv', 'disabled'],
      ['broken-srv', 'error'],
      ['healthy-srv', 'connected'],
    ])
    expect(statuses[1].error).toBeTruthy()
    expect(statuses[2].tools).toHaveLength(4)

    const res = await host.callTool(mcpQualifiedToolName('healthy-srv', 'read_item'), { id: 'ok' })
    expect(res.isError).toBeUndefined()
    expect(JSON.parse((res.content[0] as { text: string }).text).id).toBe('ok')
  })

  it('tests and connects a real local Streamable HTTP MCP server', async () => {
    const httpSrv = await startLocalHttpMcpServer()
    try {
      host = new McpClientHost({ logger: silentLogger })

      const testResult = await host.testServer({
        id: 'http-demo',
        name: 'HTTP Demo',
        enabled: true,
        transport: 'http',
        url: httpSrv.url,
        headers: { 'x-mcp-test-header': 'secret-header-val' },
        timeoutMs: 10_000,
      })

      expect(testResult.ok).toBe(true)
      expect(testResult.latencyMs).toBeGreaterThanOrEqual(0)
      expect(testResult.tools).toHaveLength(1)
      expect(testResult.tools[0]).toMatchObject({
        serverId: 'http-demo',
        name: 'ping_http',
        qualifiedName: 'mcp__http-demo__ping_http',
        readOnly: true,
      })
      expect(httpSrv.receivedHeaders).toContain('secret-header-val')
      // testServer must stay isolated and never mutate host statuses
      expect(host.getStatuses()).toEqual([])

      // Full sync + callTool over Streamable HTTP
      const statuses = await host.syncServers([
        {
          id: 'http-demo',
          name: 'HTTP Demo',
          enabled: true,
          transport: 'http',
          url: httpSrv.url,
          headers: { 'x-mcp-test-header': 'sync-header' },
        },
      ])
      expect(statuses[0].state).toBe('connected')
      expect(statuses[0].headersMasked).toEqual({ 'x-mcp-test-header': MCP_SECRET_MASK })

      const callRes = await host.callTool('mcp__http-demo__ping_http', { msg: 'hello' })
      expect(callRes.isError).toBeUndefined()
      expect((callRes.content[0] as { text: string }).text).toBe('pong:hello')
    } finally {
      await host?.dispose()
      host = null
      await httpSrv.close()
    }
  })
})

describe('MCP permission & tool policy integration', () => {
  const registered = [
    'read',
    'grep',
    'write',
    'bash',
    'submit_plan',
    'mcp__docs__search',
    'mcp__docs__publish',
  ]
  const isReadOnlyTool = (name: string) => name === 'mcp__docs__search'

  it('allows read-only MCP tools in readonly/plan modes while blocking mutating MCP tools', () => {
    expect(resolveModeTools('readonly', registered, 'linux', undefined, { isReadOnlyTool })).toEqual(
      ['read', 'grep', 'mcp__docs__search']
    )
    expect(resolveModeTools('plan', registered, 'linux', undefined, { isReadOnlyTool })).toEqual([
      'read',
      'grep',
      'submit_plan',
      'mcp__docs__search',
    ])

    const askTools = resolveModeTools('ask', registered, 'linux', undefined, { isReadOnlyTool })
    expect(askTools).toContain('mcp__docs__search')
    expect(askTools).toContain('mcp__docs__publish')
    expect(askTools).not.toContain('submit_plan')
  })

  it('activates MCP tools alongside restricted allowlist when allowMcpTools is true', () => {
    const strictBuiltins = ['read', 'bash']

    // In auto mode with allowMcpTools=true, built-in allowlist is respected AND MCP tools activate
    expect(
      resolveModeTools('auto', registered, 'linux', strictBuiltins, {
        isReadOnlyTool,
        allowMcpTools: true,
      })
    ).toEqual(['read', 'bash', 'mcp__docs__search', 'mcp__docs__publish'])

    // In readonly mode with allowMcpTools=true, mutating MCP tools remain blocked
    expect(
      resolveModeTools('readonly', registered, 'linux', strictBuiltins, {
        isReadOnlyTool,
        allowMcpTools: true,
      })
    ).toEqual(['read', 'mcp__docs__search'])

    // With allowMcpTools=false, MCP tools are filtered out by allowlist
    expect(
      resolveModeTools('auto', registered, 'linux', strictBuiltins, {
        isReadOnlyTool,
        allowMcpTools: false,
      })
    ).toEqual(['read', 'bash'])
  })

  it('categorizes read-only vs mutating MCP tools and builds sanitized approval previews', () => {
    expect(categorizeTool('mcp__docs__search', { isReadOnlyTool })).toBe('read')
    expect(categorizeTool('mcp__docs__publish', { isReadOnlyTool })).toBe('other')
    expect(categorizeTool('mcp__docs__search')).toBe('other')

    const details = buildApprovalDetails('mcp__docs__publish', {
      title: 'Release\u001b[31m v1\u001b[0m',
      draft: false,
    })
    expect(details.preview).toContain('Release v1')
    expect(details.preview).not.toContain('\u001b')
  })

  it('enforces MCP read-only vs mutating rules inside createApprovalExtension', async () => {
    let permission: SessionPermission = { mode: 'readonly', grants: [] }
    const approvalRequests: ApprovalRequestPayload[] = []
    let nextDecision: 'allow-once' | 'deny' = 'allow-once'

    const factory = createApprovalExtension(
      {
        workspaceDir: '/ws',
        logger: silentLogger,
        isReadOnlyTool,
        requestApproval: async (req) => {
          approvalRequests.push(req)
          return nextDecision === 'allow-once'
            ? { action: 'allow-once' }
            : { action: 'deny', reason: 'nope' }
        },
      },
      'sess-1',
      () => permission,
      vi.fn()
    )

    let toolCallHandler: ((event: any, ctx?: any) => Promise<any>) | null = null
    await factory({
      on: (event: string, handler: any) => {
        if (event === 'tool_call') toolCallHandler = handler
      },
    } as any)
    expect(toolCallHandler).toBeTruthy()

    // readonly: read-only MCP tool allowed without prompt; mutating MCP tool denied immediately
    expect(
      await toolCallHandler!({ toolCallId: 'c1', toolName: 'mcp__docs__search', input: { q: 'hi' } })
    ).toBeUndefined()
    expect(
      await toolCallHandler!({ toolCallId: 'c2', toolName: 'mcp__docs__publish', input: { id: 1 } })
    ).toMatchObject({ block: true })
    expect(approvalRequests).toHaveLength(0)

    // plan: same read-only guarantee
    permission = { mode: 'plan', grants: [] }
    expect(
      await toolCallHandler!({ toolCallId: 'c3', toolName: 'mcp__docs__search', input: {} })
    ).toBeUndefined()
    expect(
      await toolCallHandler!({ toolCallId: 'c4', toolName: 'mcp__docs__publish', input: {} })
    ).toMatchObject({ block: true })
    expect(approvalRequests).toHaveLength(0)

    // ask: read-only MCP allowed directly; mutating MCP triggers approval prompt
    permission = { mode: 'ask', grants: [] }
    expect(
      await toolCallHandler!({ toolCallId: 'c5', toolName: 'mcp__docs__search', input: {} })
    ).toBeUndefined()
    expect(approvalRequests).toHaveLength(0)

    nextDecision = 'allow-once'
    expect(
      await toolCallHandler!({
        toolCallId: 'c6',
        toolName: 'mcp__docs__publish',
        input: { page: 'home' },
      })
    ).toBeUndefined()
    expect(approvalRequests).toHaveLength(1)
    expect(approvalRequests[0]).toMatchObject({
      toolName: 'mcp__docs__publish',
      category: 'other',
    })

    nextDecision = 'deny'
    expect(
      await toolCallHandler!({
        toolCallId: 'c7',
        toolName: 'mcp__docs__publish',
        input: { page: 'home' },
      })
    ).toMatchObject({ block: true, reason: expect.stringContaining('nope') })

    // auto: mutating MCP allowed without prompt
    permission = { mode: 'auto', grants: [] }
    const countBeforeAuto = approvalRequests.length
    expect(
      await toolCallHandler!({ toolCallId: 'c8', toolName: 'mcp__docs__publish', input: {} })
    ).toBeUndefined()
    expect(approvalRequests).toHaveLength(countBeforeAuto)
  })
})
