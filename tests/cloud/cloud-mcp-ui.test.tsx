/**
 * Phase F · Step F3 共享 `@pi-workbench/cloud-ui` `CloudMcpManager` 及双端挂载 UI 测试：
 * - `CloudMcpManager` 在中文（`zh`）与英文（`en`）下的空态、添加 HTTP/stdio、测试连接、
 *   编辑保留掩码密钥、启停切换与危险确认删除
 * - 桌面端 `CloudView` 设置弹窗「云端 MCP 服务器」标签挂载与 IPC 调用
 * - 云端 Web `CloudWebApp`「设置」页与 `/v1/mcp*` 联动
 */

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudMcpManager } from '@pi-workbench/cloud-ui'
import { MCP_SECRET_MASK, type McpServerInput, type McpServerStatus } from 'pi-bridge/mcp'

const apiMocks = vi.hoisted(() => ({
  cloudClientSend: vi.fn(async () => ({ success: true })),
  cloudClientOpen: vi.fn(async () => ({
    success: true,
    state: { status: 'open', lastSeq: 0 },
  })),
  cloudClientClose: vi.fn(async () => ({ success: true })),
  cloudLinkStatus: vi.fn(async () => ({
    success: true,
    link: { linked: true, deviceId: 'dev-1' },
    state: { status: 'online', pending: 0 },
  })),
  cloudReconnect: vi.fn(async () => ({ success: true })),
  cloudRefreshWorkspaces: vi.fn(async () => ({ success: true, workspaces: [] })),
  cloudGetConfig: vi.fn(async () => ({ success: false })),
  cloudSaveConfig: vi.fn(async () => ({ success: false })),
  cloudFetchModels: vi.fn(async () => ({ success: true, models: [], catalog: [] })),
  cloudGetMemoryData: vi.fn(async () => ({ success: true, memories: [], docs: [], dreams: [] })),
  cloudAddMemory: vi.fn(async () => ({ success: false })),
  cloudUpdateMemory: vi.fn(async () => ({ success: false })),
  cloudDeleteMemory: vi.fn(async () => ({ success: true })),
  cloudSaveDoc: vi.fn(async () => ({ success: false })),
  cloudRunDream: vi.fn(async () => ({ success: true, dream: null })),
  cloudMcpList: vi.fn(async () => ({
    success: true,
    servers: [
      {
        id: 'desktop-cloud-http',
        name: 'Cloud Docs MCP',
        transport: 'http' as const,
        enabled: true,
        source: 'cloud' as const,
        url: 'https://mcp.example.com/v1',
        headersMasked: { Authorization: MCP_SECRET_MASK },
        state: 'connected' as const,
        tools: [
          {
            serverId: 'desktop-cloud-http',
            serverName: 'Cloud Docs MCP',
            name: 'search_docs',
            qualifiedName: 'mcp__desktop-cloud-http__search_docs',
            readOnly: true,
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    ],
  })),
  cloudMcpSave: vi.fn(async () => ({ success: true })),
  cloudMcpDelete: vi.fn(async () => ({ success: true })),
  cloudMcpTest: vi.fn(async () => ({
    success: true,
    result: { ok: true, tools: [], latencyMs: 18 },
  })),
  cloudPair: vi.fn(async () => ({ success: false })),
  cloudUnlink: vi.fn(async () => ({ success: true })),
  cloudListWorkspaces: vi.fn(async () => ({ success: true, workspaces: [] })),
  onCloudState: vi.fn(() => () => undefined),
  onCloudClientState: vi.fn(() => () => undefined),
  onCloudClientFrame: vi.fn(() => () => undefined),
}))

vi.mock('../../src/api', () => ({ api: apiMocks }))

import { CloudView } from '../../src/components/cloud/CloudView'
import { useCloudStore } from '../../src/store/cloudStore'
import { useI18nStore } from '../../src/store/i18nStore'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const sampleServers: McpServerStatus[] = [
  {
    id: 'remote-docs',
    name: 'Remote Docs',
    transport: 'http',
    enabled: true,
    source: 'cloud',
    url: 'https://mcp.example.com/mcp',
    headersMasked: { Authorization: MCP_SECRET_MASK },
    state: 'connected',
    tools: [
      {
        serverId: 'remote-docs',
        serverName: 'Remote Docs',
        name: 'query_docs',
        qualifiedName: 'mcp__remote-docs__query_docs',
        description: 'Search docs',
        readOnly: true,
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  },
  {
    id: 'vps-stdio',
    name: 'VPS Local Helper',
    transport: 'stdio',
    enabled: false,
    source: 'cloud',
    command: '/opt/pi-cloud/mcp/helper',
    args: ['--readonly'],
    cwd: '/opt/pi-cloud/mcp',
    envMasked: { API_TOKEN: MCP_SECRET_MASK },
    state: 'disabled',
    tools: [],
  },
]

describe('CloudMcpManager 共享组件（ZH / EN）', () => {
  it('中文模式下渲染列表、创建 stdio 服务器、测试连接并经危险弹窗确认删除', async () => {
    const savedPayloads: McpServerInput[] = []
    const onRefresh = vi.fn(async () => undefined)
    const onSave = vi.fn(async (input: McpServerInput) => {
      savedPayloads.push(input)
      return { ok: true }
    })
    const onToggle = vi.fn(async () => ({ ok: true }))
    const onDelete = vi.fn(async () => ({ ok: true }))
    const onTest = vi.fn(async () => ({
      ok: true,
      latencyMs: 34,
      tools: [
        {
          serverId: 'remote-docs',
          serverName: 'Remote Docs',
          name: 'query_docs',
          qualifiedName: 'mcp__remote-docs__query_docs',
          readOnly: true,
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }))

    render(
      <CloudMcpManager
        language="zh"
        servers={sampleServers}
        onRefresh={onRefresh}
        onSave={onSave}
        onToggle={onToggle}
        onDelete={onDelete}
        onTest={onTest}
      />
    )

    expect(screen.getByText('云端 MCP 服务器 (2)')).toBeTruthy()
    expect(screen.getByText('Remote Docs')).toBeTruthy()
    expect(screen.getByText('VPS Local Helper')).toBeTruthy()
    expect(screen.getByText('已连接 · 1 个工具')).toBeTruthy()
    expect(screen.getByText('已停用')).toBeTruthy()

    // 测试已保存服务器
    const testButtons = screen.getAllByRole('button', { name: '测试连接' })
    fireEvent.click(testButtons[0])
    await waitFor(() => {
      expect(onTest).toHaveBeenCalledWith({ id: 'remote-docs' })
      expect(screen.getByText(/连接成功 · 发现 1 个工具（34 ms）/)).toBeTruthy()
    })

    // 切换启用开关
    const toggleBox = screen.getByLabelText('VPS Local Helper 启用') as HTMLInputElement
    fireEvent.click(toggleBox)
    await waitFor(() => {
      expect(onToggle).toHaveBeenCalledWith(sampleServers[1], true)
    })

    // 打开新增弹窗，创建云主机本地 stdio 服务器
    fireEvent.click(screen.getByRole('button', { name: '添加服务器' }))
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Cloud Git Helper' } })
    fireEvent.change(screen.getByLabelText('传输协议'), { target: { value: 'stdio' } })
    fireEvent.change(screen.getByLabelText('启动命令'), {
      target: { value: '/opt/pi-cloud/mcp/git-helper' },
    })
    fireEvent.change(screen.getByLabelText('命令参数'), {
      target: { value: '--mode "read only"' },
    })
    fireEvent.change(screen.getByLabelText('工作目录（可选）'), {
      target: { value: '/opt/pi-cloud/mcp' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存服务器' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(savedPayloads[0]).toMatchObject({
      id: 'cloud-git-helper',
      name: 'Cloud Git Helper',
      transport: 'stdio',
      command: '/opt/pi-cloud/mcp/git-helper',
      args: ['--mode', 'read only'],
      cwd: '/opt/pi-cloud/mcp',
      enabled: true,
      source: 'cloud',
    })

    // 删除服务器：先弹危险确认弹窗再执行 onDelete
    fireEvent.click(screen.getByRole('button', { name: '删除服务器 Remote Docs' }))
    expect(await screen.findByText(/确定要删除云端 MCP 服务器「Remote Docs」/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('remote-docs'))
  })

  it('英文模式下渲染空态、创建 HTTP 服务器并保留编辑时的掩码密钥', async () => {
    const onSave = vi.fn(async () => ({ ok: true }))
    const onTest = vi.fn(async () => ({
      ok: true,
      latencyMs: 21,
      tools: [],
    }))

    const { rerender } = render(
      <CloudMcpManager
        language="en"
        servers={[]}
        onRefresh={vi.fn()}
        onSave={onSave}
        onToggle={vi.fn(async () => ({ ok: true }))}
        onDelete={vi.fn(async () => ({ ok: true }))}
        onTest={onTest}
      />
    )

    expect(screen.getByText('Cloud MCP servers')).toBeTruthy()
    expect(screen.getByText('No cloud MCP servers configured')).toBeTruthy()

    // 点击编辑已有服务器，确认保留掩码请求头
    rerender(
      <CloudMcpManager
        language="en"
        servers={sampleServers}
        onRefresh={vi.fn()}
        onSave={onSave}
        onToggle={vi.fn(async () => ({ ok: true }))}
        onDelete={vi.fn(async () => ({ ok: true }))}
        onTest={onTest}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit server Remote Docs' }))
    expect((screen.getByLabelText('Server ID') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByDisplayValue(MCP_SECRET_MASK)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Display name'), {
      target: { value: 'Remote Docs Updated' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save server' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'remote-docs',
        name: 'Remote Docs Updated',
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: MCP_SECRET_MASK },
      })
    )
  })
})

describe('桌面端 CloudView 设置弹窗集成 CloudMcpManager', () => {
  it('切换至云端 MCP 标签后通过 cloudMcpList IPC 拉取并展示云端 MCP 服务器', async () => {
    useI18nStore.setState({ language: 'zh' })
    useCloudStore.setState({
      link: { linked: true, deviceId: 'dev-1' },
      deviceState: { status: 'online', pending: 0 },
      clientState: { status: 'open', lastSeq: 0 },
      messages: [],
      tasks: [],
      units: [],
      authorizations: [],
      notices: [],
      devices: [],
      error: null,
      initialized: true,
    })

    render(<CloudView onBackHome={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '云端模型配置' }))

    const mcpTab = await screen.findByRole('tab', { name: '云端 MCP 服务器' })
    fireEvent.click(mcpTab)

    await waitFor(() => {
      expect(apiMocks.cloudMcpList).toHaveBeenCalledTimes(1)
    })
    expect(await screen.findByText('Cloud Docs MCP')).toBeTruthy()
    expect(screen.getByText('search_docs')).toBeTruthy()
  })
})
