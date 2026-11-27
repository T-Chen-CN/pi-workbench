// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MCP_SECRET_MASK } from 'pi-bridge/mcp'
import { McpSettings } from '../../src/components/settings/McpSettings'
import { api } from '../../src/api'
import { translations } from '../../src/i18n/translations'
import { useI18nStore } from '../../src/store/i18nStore'
import { useWorkspaceStore } from '../../src/store/workspaceStore'
import type { McpServerStatus } from '../../src/types/electron'

vi.mock('../../src/api', () => ({
  api: {
    mcpList: vi.fn(),
    mcpSaveGlobal: vi.fn(),
    mcpDeleteGlobal: vi.fn(),
    mcpSetGlobalEnabled: vi.fn(),
    mcpSetProjectTrust: vi.fn(),
    mcpTest: vi.fn(),
  },
}))

const sampleGlobal: McpServerStatus = {
  id: 'fs-global',
  name: 'Filesystem Global',
  transport: 'stdio',
  enabled: true,
  source: 'global',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
  envMasked: { API_TOKEN: MCP_SECRET_MASK },
  state: 'connected',
  tools: [
    {
      serverId: 'fs-global',
      serverName: 'Filesystem Global',
      name: 'read_file',
      qualifiedName: 'mcp__fs-global__read_file',
      description: 'Read a file',
      readOnly: true,
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}

const sampleProjectUntrusted: McpServerStatus = {
  id: 'repo-db',
  name: 'Repo DB Helper',
  transport: 'stdio',
  enabled: false,
  source: 'project',
  trusted: false,
  trustChanged: false,
  command: 'node',
  args: ['./scripts/db-mcp.js'],
  state: 'disabled',
  tools: [],
}

const sampleProjectChanged: McpServerStatus = {
  id: 'repo-changed',
  name: 'Mutated Tool',
  transport: 'http',
  enabled: false,
  source: 'project',
  trusted: false,
  trustChanged: true,
  url: 'https://changed.example.com/mcp',
  state: 'disabled',
  tools: [],
}

beforeEach(() => {
  useI18nStore.setState({ language: 'zh' })
  useWorkspaceStore.setState({ workspacePath: '/workspace/demo', openWorkspaces: ['/workspace/demo'] })
  vi.mocked(api.mcpList).mockResolvedValue({
    success: true,
    global: [sampleGlobal],
    project: [sampleProjectUntrusted, sampleProjectChanged],
  })
  vi.mocked(api.mcpSaveGlobal).mockResolvedValue({
    success: true,
    server: {
      id: 'my-remote',
      name: 'My Remote',
      transport: 'http',
      enabled: true,
      source: 'global',
      url: 'https://mcp.demo.test/mcp',
      state: 'disabled',
      tools: [],
    },
  })
  vi.mocked(api.mcpDeleteGlobal).mockResolvedValue({ success: true })
  vi.mocked(api.mcpSetGlobalEnabled).mockResolvedValue({
    success: true,
    server: { ...sampleGlobal, enabled: false },
  })
  vi.mocked(api.mcpSetProjectTrust).mockResolvedValue({
    success: true,
    server: { ...sampleProjectUntrusted, enabled: true, trusted: true },
  })
  vi.mocked(api.mcpTest).mockResolvedValue({
    success: true,
    result: {
      ok: true,
      latencyMs: 42,
      tools: [
        {
          serverId: 'fs-global',
          serverName: 'Filesystem Global',
          name: 'list_dir',
          qualifiedName: 'mcp__fs-global__list_dir',
          description: 'List directory contents',
          readOnly: true,
          inputSchema: { type: 'object', properties: {} },
        },
        {
          serverId: 'fs-global',
          serverName: 'Filesystem Global',
          name: 'write_note',
          qualifiedName: 'mcp__fs-global__write_note',
          description: 'Write a note',
          readOnly: false,
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    },
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('McpSettings UI', () => {
  it('renders global and project MCP servers with trust status badges', async () => {
    render(<McpSettings />)

    expect(await screen.findByText('Filesystem Global')).toBeTruthy()
    expect(screen.getByText('Repo DB Helper')).toBeTruthy()
    expect(screen.getByText('Mutated Tool')).toBeTruthy()
    expect(screen.getByText(translations.zh.mcpTrustUntrusted)).toBeTruthy()
    expect(screen.getByText(translations.zh.mcpTrustChanged)).toBeTruthy()
    expect(api.mcpList).toHaveBeenCalledWith('/workspace/demo')
  })

  it('adds a new global HTTP MCP server through the modal form', async () => {
    render(<McpSettings />)

    await screen.findByText('Filesystem Global')
    fireEvent.click(screen.getByRole('button', { name: translations.zh.mcpAddServer }))

    fireEvent.change(screen.getByLabelText(translations.zh.mcpFieldName), {
      target: { value: 'My Remote' },
    })
    fireEvent.change(screen.getByLabelText(translations.zh.mcpFieldId), {
      target: { value: 'my-remote' },
    })
    fireEvent.change(screen.getByLabelText(translations.zh.mcpFieldTransport), {
      target: { value: 'http' },
    })
    fireEvent.change(screen.getByLabelText(translations.zh.mcpFieldUrl), {
      target: { value: 'https://mcp.demo.test/mcp' },
    })

    fireEvent.click(screen.getByRole('button', { name: translations.zh.mcpSaveServer }))

    await waitFor(() => expect(api.mcpSaveGlobal).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.mcpSaveGlobal).mock.calls[0][0]).toMatchObject({
      id: 'my-remote',
      name: 'My Remote',
      transport: 'http',
      url: 'https://mcp.demo.test/mcp',
      enabled: true,
    })
  })

  it('approves an untrusted project MCP server and triggers mcpSetProjectTrust', async () => {
    render(<McpSettings />)

    await screen.findByText('Repo DB Helper')
    const approveButtons = screen.getAllByRole('button', {
      name: translations.zh.mcpApproveEnable,
    })
    fireEvent.click(approveButtons[0])

    await waitFor(() =>
      expect(api.mcpSetProjectTrust).toHaveBeenCalledWith('/workspace/demo', 'repo-db', true)
    )
  })

  it('runs Test Connection and displays discovered tools, read-only badge, and latency', async () => {
    render(<McpSettings />)

    await screen.findByText('Filesystem Global')
    const testButtons = screen.getAllByRole('button', {
      name: translations.zh.mcpTestConnection,
    })
    fireEvent.click(testButtons[0])

    await waitFor(() =>
      expect(api.mcpTest).toHaveBeenCalledWith({ scope: 'global', id: 'fs-global' })
    )
    expect(await screen.findByText(/42 ms/)).toBeTruthy()
    expect(screen.getByText('list_dir')).toBeTruthy()
    expect(screen.getByText('write_note')).toBeTruthy()
    expect(screen.getAllByText(translations.zh.mcpToolReadOnly).length).toBeGreaterThan(0)
  })
})
