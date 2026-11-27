// @vitest-environment node

import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MCP_SECRET_MASK,
  computeMcpServerFingerprint,
  createFileCredentialStore,
  createFileModelsStore,
  type AgentConfig,
  type CloudTaskSpec,
  type McpServerConfig,
  type McpServerStatus,
} from 'pi-bridge'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => os.tmpdir(),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`mock:${value}`, 'utf-8'),
    decryptString: (buf: Buffer) => Buffer.from(buf).toString('utf-8').replace(/^mock:/, ''),
  },
}))

const {
  currentMcpConfigVersion,
  deleteGlobalMcpServer,
  discoverProjectMcpServers,
  globalMcpConfigPath,
  listMcpServersForUi,
  loadGlobalMcpServers,
  projectMcpTrustPath,
  resolveEffectiveMcpServers,
  saveGlobalMcpServer,
  setGlobalMcpServerEnabled,
  setProjectServerTrust,
} = await import('../../electron/mcp-store')
const { CloudTaskRunner } = await import('../../electron/cloud/task-runner')
const { ChildRegistry } = await import('../../electron/child-registry')
const { AgentHostClient } = await import('../../electron/agent-host-client')
const { attachAgentHostWorker } = await import('../../electron/agent-host-worker')

import type {
  AgentHostCallbacks,
  UtilityProcessLike,
} from '../../electron/agent-host-client'
import type {
  MessagePortLike,
  ParentPortLike,
  ParentPortMessageEvent,
} from '../../electron/agent-host-protocol'
import type { AgentRuntimeInstance } from '../../electron/agent-host-worker'

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

const testCodec = {
  encrypt: (plain: string) => `enc:${Buffer.from(`sealed:${plain}`, 'utf-8').toString('base64')}`,
  decrypt: (stored: string) => {
    if (!stored.startsWith('enc:')) return stored
    const raw = Buffer.from(stored.slice(4), 'base64').toString('utf-8')
    return raw.startsWith('sealed:') ? raw.slice('sealed:'.length) : ''
  },
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('Phase F · Step F2: Desktop MCP Store, Project Trust & Runtime Wiring', () => {
  it('encrypts global MCP env/headers at rest, masks UI output, and preserves secrets across masked edits', async () => {
    const appDir = await makeTempDir('pi-mcp-global-')
    const opts = { appDir, codec: testCodec }
    const v0 = currentMcpConfigVersion()

    const savedStdio = await saveGlobalMcpServer(
      {
        id: 'github-mcp',
        name: 'GitHub Tools',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: {
          GITHUB_TOKEN: 'ghp_secretValue12345678901234567890123456',
          TEAM_KEY: 'team-alpha-secret',
        },
      },
      opts
    )
    const savedHttp = await saveGlobalMcpServer(
      {
        id: 'remote-docs',
        name: 'Remote Docs',
        enabled: true,
        transport: 'http',
        url: 'https://mcp.example.com/v1',
        headers: {
          Authorization: 'Bearer super-secret-http-bearer-token-99999',
        },
      },
      opts
    )

    expect(currentMcpConfigVersion()).toBeGreaterThan(v0)
    expect(savedStdio.envMasked).toEqual({
      GITHUB_TOKEN: MCP_SECRET_MASK,
      TEAM_KEY: MCP_SECRET_MASK,
    })
    expect(savedHttp.headersMasked).toEqual({
      Authorization: MCP_SECRET_MASK,
    })

    // 磁盘 mcp.json 严禁出现任何明文密钥，必须全部以 enc: 加密落盘
    const rawDisk = await fs.readFile(globalMcpConfigPath(appDir), 'utf-8')
    expect(rawDisk).not.toContain('ghp_secretValue12345678901234567890123456')
    expect(rawDisk).not.toContain('team-alpha-secret')
    expect(rawDisk).not.toContain('super-secret-http-bearer-token-99999')
    expect(rawDisk).toContain('enc:')

    // UI 快照绝不泄漏明文，只回掩码
    const uiList = listMcpServersForUi(undefined, opts)
    expect(uiList.global).toHaveLength(2)
    expect(JSON.stringify(uiList)).not.toContain('ghp_secretValue')
    expect(JSON.stringify(uiList)).not.toContain('super-secret-http-bearer')
    expect(uiList.global[0].envMasked).toEqual({
      GITHUB_TOKEN: MCP_SECRET_MASK,
      TEAM_KEY: MCP_SECRET_MASK,
    })

    // 编辑既有服务器：掩码项保留原密钥，新增项写入新值，未传入的旧键删除
    await saveGlobalMcpServer(
      {
        id: 'github-mcp',
        name: 'GitHub Tools v2',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: {
          GITHUB_TOKEN: MCP_SECRET_MASK,
          EXTRA_VAR: 'new-value-xyz',
        },
      },
      opts
    )

    const loaded = loadGlobalMcpServers(opts)
    const github = loaded.find((s) => s.id === 'github-mcp')
    expect(github?.name).toBe('GitHub Tools v2')
    expect(github?.env).toEqual({
      GITHUB_TOKEN: 'ghp_secretValue12345678901234567890123456',
      EXTRA_VAR: 'new-value-xyz',
    })

    // 停用与删除切换
    const toggled = await setGlobalMcpServerEnabled('remote-docs', false, opts)
    expect(toggled?.enabled).toBe(false)
    expect(loadGlobalMcpServers(opts).find((s) => s.id === 'remote-docs')?.enabled).toBe(false)

    expect(await deleteGlobalMcpServer('remote-docs', opts)).toBe(true)
    expect(await deleteGlobalMcpServer('nonexistent', opts)).toBe(false)
    expect(loadGlobalMcpServers(opts).map((s) => s.id)).toEqual(['github-mcp'])
  })

  it('discovers project MCP configs fail-closed by default, pins SHA-256 fingerprint on approval, and revokes trust on mutation', async () => {
    const appDir = await makeTempDir('pi-mcp-trust-app-')
    const wsDir = await makeTempDir('pi-mcp-trust-ws-')
    const opts = { appDir, codec: testCodec }

    // 同时写入 .mcp.json（mcpServers 映射格式）与 .pi-workbench/mcp.json（servers 数组格式 + 同名覆盖）
    await fs.writeFile(
      path.join(wsDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          shared: {
            command: 'node',
            args: ['from-dot-mcp.js'],
            enabled: true, // 仓库里的 enabled 必须被严格忽略！
          },
          onlyDotMcp: {
            command: 'node',
            args: ['helper.js'],
            cwd: './scripts',
            env: { PROJECT_SECRET: 'repo-secret-123' },
            enabled: true,
          },
        },
      }),
      'utf-8'
    )
    await fs.mkdir(path.join(wsDir, '.pi-workbench'), { recursive: true })
    await fs.writeFile(
      path.join(wsDir, '.pi-workbench', 'mcp.json'),
      JSON.stringify({
        servers: [
          {
            id: 'shared',
            name: 'Preferred Project Server',
            transport: 'stdio',
            command: 'node',
            args: ['from-pi-workbench.js'],
            enabled: true,
          },
        ],
      }),
      'utf-8'
    )

    const discovered = discoverProjectMcpServers(wsDir)
    expect(discovered.map((s) => s.id)).toEqual(['shared', 'onlyDotMcp'])
    expect(discovered[0].args).toEqual(['from-pi-workbench.js'])

    // 默认全部未信任且关闭（即使仓库配置写了 enabled: true）
    const beforeTrust = listMcpServersForUi(wsDir, opts)
    expect(beforeTrust.project).toHaveLength(2)
    for (const item of beforeTrust.project) {
      expect(item.enabled).toBe(false)
      expect(item.trusted).toBe(false)
      expect(item.trustChanged).toBe(false)
    }
    expect(JSON.stringify(beforeTrust)).not.toContain('repo-secret-123')
    expect(resolveEffectiveMcpServers(wsDir, opts)).toEqual([])

    // 显式信任批准 onlyDotMcp -> SHA-256 指纹写入 {appDir}/config/mcp-trust.json
    const approved = await setProjectServerTrust(wsDir, 'onlyDotMcp', true, opts)
    expect(approved).toMatchObject({
      id: 'onlyDotMcp',
      enabled: true,
      trusted: true,
      trustChanged: false,
    })

    const trustDisk = JSON.parse(await fs.readFile(projectMcpTrustPath(appDir), 'utf-8')) as {
      version: number
      workspaces: Record<string, Record<string, { enabled: boolean; fingerprint: string }>>
    }
    const wsEntries = Object.values(trustDisk.workspaces)[0]
    expect(wsEntries.onlyDotMcp.enabled).toBe(true)
    expect(wsEntries.onlyDotMcp.fingerprint).toBe(computeMcpServerFingerprint(discovered[1]))

    // 篡改仓库中的 .mcp.json（新增恶意参数）-> 自动撤销信任并标记 trustChanged = true
    await fs.writeFile(
      path.join(wsDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          onlyDotMcp: {
            command: 'node',
            args: ['evil-mutated.js'],
            cwd: './scripts',
            env: { PROJECT_SECRET: 'repo-secret-123' },
          },
        },
      }),
      'utf-8'
    )

    const afterMutate = listMcpServersForUi(wsDir, opts)
    const mutatedItem = afterMutate.project.find((s) => s.id === 'onlyDotMcp')
    expect(mutatedItem).toMatchObject({
      enabled: false,
      trusted: false,
      trustChanged: true,
    })
    expect(resolveEffectiveMcpServers(wsDir, opts)).toEqual([])

    // 显式取消信任后，trustChanged 复位为 false
    const revoked = await setProjectServerTrust(wsDir, 'onlyDotMcp', false, opts)
    expect(revoked).toMatchObject({ enabled: false, trusted: false, trustChanged: false })
  })

  it('resolves enabled global + approved project MCP servers with cwdOverride bound to worktree and excludes untrusted/tampered servers', async () => {
    const appDir = await makeTempDir('pi-mcp-eff-app-')
    const wsDir = await makeTempDir('pi-mcp-eff-ws-')
    const wtDir = await makeTempDir('pi-mcp-eff-wt-')
    const opts = { appDir, codec: testCodec }

    await saveGlobalMcpServer(
      {
        id: 'global-on',
        name: 'Global On',
        enabled: true,
        transport: 'http',
        url: 'https://global.example.com/mcp',
        headers: { 'X-Api-Key': 'global-secret-key' },
      },
      opts
    )
    await saveGlobalMcpServer(
      {
        id: 'global-off',
        name: 'Global Off',
        enabled: false,
        transport: 'stdio',
        command: 'node',
        args: ['off.js'],
      },
      opts
    )
    await saveGlobalMcpServer(
      {
        id: 'override-id',
        name: 'Global Version',
        enabled: true,
        transport: 'stdio',
        command: 'node',
        args: ['global-version.js'],
      },
      opts
    )

    await fs.writeFile(
      path.join(wsDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'project-approved-rel': {
            command: 'node',
            args: ['tool.js'],
            cwd: './tools',
          },
          'project-approved-default': {
            command: 'node',
            args: ['default-cwd.js'],
          },
          'project-untrusted': {
            command: 'node',
            args: ['untrusted.js'],
          },
          'override-id': {
            command: 'node',
            args: ['project-override.js'],
          },
        },
      }),
      'utf-8'
    )

    await setProjectServerTrust(wsDir, 'project-approved-rel', true, opts)
    await setProjectServerTrust(wsDir, 'project-approved-default', true, opts)
    await setProjectServerTrust(wsDir, 'override-id', true, opts)

    const effective = resolveEffectiveMcpServers(wsDir, { ...opts, cwdOverride: wtDir })
    expect(effective.map((s) => s.id)).toEqual([
      'global-on',
      'override-id',
      'project-approved-rel',
      'project-approved-default',
    ])

    // 全局启用项带解密密钥
    expect(effective[0]).toMatchObject({
      id: 'global-on',
      source: 'global',
      headers: { 'X-Api-Key': 'global-secret-key' },
    })
    // 已信任项目项覆盖同名全局项，且 cwd 绑定到 worktree
    expect(effective[1]).toMatchObject({
      id: 'override-id',
      source: 'project',
      args: ['project-override.js'],
      cwd: wtDir,
    })
    // 相对 cwd 相对 worktree 解析
    expect(effective[2]).toMatchObject({
      id: 'project-approved-rel',
      source: 'project',
      cwd: path.resolve(wtDir, './tools'),
    })
    // 未指定 cwd 的项目 stdio 服务器默认绑定 worktree
    expect(effective[3]).toMatchObject({
      id: 'project-approved-default',
      source: 'project',
      cwd: wtDir,
    })
    // 停用全局项与未信任项目项均被排除
    expect(effective.find((s) => s.id === 'global-off')).toBeUndefined()
    expect(effective.find((s) => s.id === 'project-untrusted')).toBeUndefined()
  })

  it('wires CloudTaskRunner to pass global + approved project MCP servers, allowMcpTools=true, and mcpOutputRedactor', async () => {
    const appDir = await makeTempDir('pi-mcp-cloud-app-')
    const repoDir = await makeTempDir('pi-mcp-cloud-repo-')
    const wtDir = await makeTempDir('pi-mcp-cloud-wt-')
    const dataDir = await makeTempDir('pi-mcp-cloud-data-')
    const opts = { appDir, codec: testCodec }

    await saveGlobalMcpServer(
      {
        id: 'global-mcp',
        name: 'Global MCP',
        enabled: true,
        transport: 'http',
        url: 'https://mcp.global.test/rpc',
        headers: { Authorization: 'Bearer tok-global-cloud-task' },
      },
      opts
    )
    await fs.writeFile(
      path.join(repoDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'trusted-repo-mcp': { command: 'node', args: ['ok.js'], cwd: './sub' },
          'untrusted-repo-mcp': { command: 'node', args: ['blocked.js'] },
        },
      }),
      'utf-8'
    )
    await setProjectServerTrust(repoDir, 'trusted-repo-mcp', true, opts)

    let capturedInit: Record<string, unknown> | null = null
    const runner = new CloudTaskRunner({
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      dataDir,
      getApiConfig: async () => ({
        providerId: 'openai',
        modelId: 'gpt-4o',
        fingerprint: 'fp-1',
      }),
      installPrePushHook: async () => ({ ok: true }),
      getCoordinator: async () => ({
        bind: async () => ({ success: true, worktree: { path: wtDir, branch: 'pi/task-mcp' } }),
        getSessionBinding: () => ({ key: 'cloud:u1', path: wtDir, branch: 'pi/task-mcp' }),
        hasBinding: () => true,
        release: async () => ({ success: true, removed: true, dirty: false, worktreePath: wtDir }),
      }),
      getMcpServers: (workspacePath, worktreePath) =>
        resolveEffectiveMcpServers(workspacePath, { ...opts, cwdOverride: worktreePath }),
      createAgentManager: () => ({
        initialize: async (options) => {
          capturedInit = options
          return { success: true }
        },
        createSession: async () => ({ success: true, session: { id: 'sess-cloud-mcp' } }),
        subscribeTrace: () => () => undefined,
        chat: async () => ({ success: true, response: 'done' }),
        closeSession: async () => undefined,
        abort: async () => undefined,
        dispose: async () => undefined,
      }),
      onStatus: () => undefined,
      onWorktree: () => undefined,
      onMilestone: () => undefined,
      onQuestion: () => undefined,
      onResult: () => undefined,
      onFailed: () => undefined,
      onInterrupted: () => undefined,
      onUnitClosed: () => undefined,
      onUnitState: () => undefined,
    })

    const spec: CloudTaskSpec = {
      workUnitId: 'u-mcp-1',
      deviceId: 'dev-1',
      repo: { workspacePath: repoDir, baseBranch: 'main' },
      title: 'Run task with MCP',
      background: 'bg',
      goal: 'goal',
      acceptance: 'acc',
      output: { summary: true, changeList: true, testResult: false },
      commit: false,
      authorizationId: 'auth-1',
    }

    await runner.start('T-mcp-1', spec)
    await runner.dispose()

    expect(capturedInit).not.toBeNull()
    expect(capturedInit!.allowMcpTools).toBe(true)
    expect(capturedInit!.mcpCwd).toBe(wtDir)

    const passedServers = capturedInit!.mcpServers as McpServerConfig[]
    expect(passedServers.map((s) => s.id)).toEqual(['global-mcp', 'trusted-repo-mcp'])
    expect(passedServers[1].cwd).toBe(path.resolve(wtDir, './sub'))

    // 验证 mcpOutputRedactor 对常见密钥执行脱敏
    const redactor = capturedInit!.mcpOutputRedactor as (text: string) => string
    expect(typeof redactor).toBe('function')
    const leaked = 'token=ghp_1234567890abcdef1234567890abcdef1234'
    const redacted = redactor(leaked)
    expect(redacted).not.toContain('ghp_1234567890abcdef1234567890abcdef1234')
    expect(redacted).toContain('[REDACTED:')
  })

  it('fetches MCP servers over host RPC in AgentHostClient <-> agent-host-worker without leaking secrets in init payload', async () => {
    const tmpDir = await makeTempDir('pi-mcp-worker-')
    const childReg = new ChildRegistry()
    const secretHeader = 'Bearer worker-rpc-secret-987654321'

    let observedInitServers: McpServerConfig[] = []
    let refreshedServers: McpServerConfig[] = []
    let unregisterMcpChild: (() => void) | null = null
    const parentOutbound: unknown[] = []

    const fakeRuntime: AgentRuntimeInstance = {
      async initialize(config: AgentConfig) {
        expect(config.allowMcpTools).toBe(true)
        expect(typeof config.getMcpServers).toBe('function')
        observedInitServers = (await config.getMcpServers?.()) ?? []
        unregisterMcpChild = config.onMcpChildPid?.(55123, () => undefined) ?? null
        return { success: true }
      },
      async chat() {
        return { success: true, response: 'ok' }
      },
      async abort() {},
      async steer() {
        return { success: true }
      },
      async dispose() {
        unregisterMcpChild?.()
      },
      async requestSessionRoot() {
        return { success: true }
      },
      async listSessions() {
        return []
      },
      async openSession() {
        return { success: true }
      },
      async createSession() {
        return { success: true }
      },
      async closeSession() {},
      async renameSession() {
        return { success: true }
      },
      async deleteSession() {
        return { success: true }
      },
      async getContextUsage() {
        return { success: true }
      },
      async compactContext() {
        return { success: true }
      },
      async rewindToLastUser() {
        return { success: true }
      },
      async listBranches() {
        return { success: true }
      },
      async switchBranch() {
        return { success: true }
      },
      async getToolResultMeta() {
        return { success: true }
      },
      async readToolResultChunk() {
        return { success: true }
      },
      async getToolResultImage() {
        return { success: true }
      },
      async getToolResultText() {
        return { success: true }
      },
      async exportSessionMarkdown() {
        return { success: true }
      },
      async exportSessionHtml() {
        return { success: true }
      },
      async getSessionJsonlPath() {
        return { success: true }
      },
      async getModelCapabilities() {
        return { success: true }
      },
      async listPromptResources() {
        return { success: true }
      },
      async getPlan() {
        return { success: true }
      },
      async approvePlan() {
        return { success: true }
      },
      async rejectPlan() {
        return { success: true }
      },
      async getSessionSettings() {
        return { success: true }
      },
      async setSessionModel() {
        return { success: true }
      },
      async setSessionThinking() {
        return { success: true }
      },
      async setSessionPermission() {
        return { success: true }
      },
      async getSessionStats() {
        return { success: true }
      },
      getSessionMessages() {
        return []
      },
      getMessageHistory() {
        return []
      },
      getCurrentSessionId() {
        return 's1'
      },
      hasRunningSessions() {
        return []
      },
      getMcpStatuses(): McpServerStatus[] {
        return [
          {
            id: 'rpc-mcp',
            name: 'RPC MCP',
            transport: 'http',
            enabled: true,
            source: 'global',
            state: 'connected',
            tools: [],
          },
        ]
      },
      async refreshMcpServers(servers: McpServerConfig[]): Promise<McpServerStatus[]> {
        refreshedServers = servers
        return this.getMcpStatuses!()
      },
    }

    const childEmitter = new EventEmitter()
    const workerEmitter = new EventEmitter()
    const workerPort: ParentPortLike = {
      on: (ev, listener) => workerEmitter.on(ev, listener),
      postMessage: (msg) => {
        queueMicrotask(() => childEmitter.emit('message', msg))
      },
    }
    const child: UtilityProcessLike = {
      pid: 44001,
      stdout: null,
      stderr: null,
      postMessage: (msg, transfer) => {
        parentOutbound.push(msg)
        const event: ParentPortMessageEvent = {
          data: msg,
          ports: (transfer as MessagePortLike[] | undefined) ?? [],
        }
        queueMicrotask(() => workerEmitter.emit('message', event))
      },
      kill: () => {
        queueMicrotask(() => childEmitter.emit('exit', 0))
        return true
      },
      on: (ev: string, listener: (...args: any[]) => void) => {
        childEmitter.on(ev, listener)
        return child
      },
    }

    const activeServers: McpServerConfig[] = [
      {
        id: 'rpc-mcp',
        name: 'RPC MCP',
        enabled: true,
        transport: 'http',
        url: 'https://mcp.rpc.test/mcp',
        headers: { Authorization: secretHeader },
        source: 'global',
      },
    ]

    const callbacks: AgentHostCallbacks = {
      credentials: createFileCredentialStore({
        path: path.join(tmpDir, 'creds.json'),
        cipher: testCodec,
      }),
      modelsStore: createFileModelsStore({ path: path.join(tmpDir, 'models.json') }),
      readDocument: async () => null,
      requestApproval: async () => ({ action: 'allow-once' }),
      getWorktreeContext: () => '',
      onWorktreeSwitch: async () => ({ success: true, root: tmpDir }),
      resolveSessionRoot: () => tmpDir,
      isSessionOfWorkspace: () => true,
      getSyncState: () => ({
        defaultPermissionLevel: 'ask',
        language: 'zh',
        webAccessConfigVersion: '',
        sessionRoots: {},
      }),
      onSessionTitle: () => {},
      onSessionRootChanged: () => {},
      resolveMcpServers: () => activeServers,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }

    const client = new AgentHostClient({
      workspaceDir: tmpDir,
      hostCallbacks: callbacks,
      workerModulePath: '/virtual/agent-host-worker.js',
      forkUtilityProcess: () => {
        attachAgentHostWorker(workerPort, { createAgent: () => fakeRuntime })
        return child
      },
      childRegistry: childReg,
    })

    await client.initialize({
      workspaceDir: tmpDir,
      agentDir: path.join(tmpDir, 'agent'),
      apiConfig: { providerId: 'openai', modelId: 'gpt-4o' },
      allowModelNetwork: false,
      webAccessExtensionPaths: [],
    })

    // init RPC 帧绝不能包含 MCP 密钥，密钥必须由 mcp:resolveServers host RPC 按需拉取
    const initReq = parentOutbound.find(
      (msg) => Boolean(msg && typeof msg === 'object' && (msg as { method?: unknown }).method === 'initialize')
    )
    expect(JSON.stringify(initReq)).not.toContain(secretHeader)
    expect(observedInitServers).toEqual(activeServers)
    // MCP 子进程 PID 已登记进主进程 ChildRegistry
    expect(childReg.list().some((entry) => entry.pid === 55123 && entry.group === 'utility')).toBe(
      true
    )

    // getMcpStatuses 与 refreshMcpServers RPC 往返
    const statuses = await client.getMcpStatuses()
    expect(statuses).toHaveLength(1)
    expect(statuses[0].id).toBe('rpc-mcp')

    await client.refreshMcpServers()
    expect(refreshedServers).toEqual(activeServers)

    await client.dispose()
    expect(childReg.list().some((entry) => entry.pid === 55123)).toBe(false)
  })
})
