/**
 * 桌面端「确认方案并授权」入口（F-16 / F-17 / F-18 / D-11）。
 *
 * 事故：`cloudStore.confirmPlan` 写了但没有调用方 —— 桌面端只显示授权列表，
 * 授权只能从 Web 做，于是「桌面端与 Web 都是完整客户端」不成立，只用桌面端派不出活。
 * 这里钉住两条：入口存在并且发出 `confirm_plan`；被解绑时有明确提示。
 */

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sent: Array<Record<string, unknown>> = []

vi.mock('../src/api', () => ({
  api: {
    cloudClientSend: vi.fn(async (frame: Record<string, unknown>) => {
      sent.push(frame)
      return { success: true }
    }),
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
    cloudFetchModels: vi.fn(async () => ({ success: false, models: [], catalog: [] })),
    cloudGetMemoryData: vi.fn(async () => ({ success: true, memories: [], docs: [], dreams: [] })),
    cloudAddMemory: vi.fn(async () => ({ success: false })),
    cloudUpdateMemory: vi.fn(async () => ({ success: false })),
    cloudDeleteMemory: vi.fn(async () => ({ success: true })),
    cloudSaveDoc: vi.fn(async () => ({ success: false })),
    cloudRunDream: vi.fn(async () => ({ success: true, dream: null })),
    cloudPair: vi.fn(async () => ({ success: false })),
    cloudUnlink: vi.fn(async () => ({ success: true })),
    cloudListWorkspaces: vi.fn(async () => ({ success: true, workspaces: [] })),
    onCloudState: vi.fn(() => () => undefined),
    onCloudClientState: vi.fn(() => () => undefined),
    onCloudClientFrame: vi.fn(() => () => undefined),
  },
}))

import { api } from '../src/api'
import { CloudView } from '../src/components/CloudView'
import { useCloudStore } from '../src/store/cloudStore'
import { useI18nStore } from '../src/store/i18nStore'

const repo = { path: 'E:/repo', name: 'repo', isGit: true }

beforeEach(() => {
  sent.length = 0
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
    devices: [
      { id: 'dev-1', name: '工作站', platform: 'win32', online: true, workspaces: [repo] },
    ],
    error: null,
    initialized: true,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('确认方案并授权', () => {
  it('填好范围后发出 confirm_plan（桌面端不再是只读的授权列表）', async () => {
    render(<CloudView onBackHome={() => undefined} />)

    fireEvent.click(screen.getByText('确认方案并授权'))
    const planText = await screen.findByLabelText('方案原文')
    fireEvent.change(planText, { target: { value: '在 repo 里加一个脚本，跑通即完成' } })

    // 设备与仓库由默认值填好：用户只填方案原文就能授权
    await waitFor(() => {
      const repoSelect = screen.getByLabelText('仓库（仅 git 可派活）') as HTMLSelectElement
      expect(repoSelect.value).toBe('E:/repo')
    })

    fireEvent.click(screen.getByText('确认并授权'))
    await waitFor(() => expect(sent.length).toBeGreaterThan(0))
    expect(sent[0]).toMatchObject({
      type: 'confirm_plan',
      planText: '在 repo 里加一个脚本，跑通即完成',
      items: [{ deviceId: 'dev-1', workspacePath: 'E:/repo' }],
      quota: 5,
    })
  })

  it('没有可派活的 git 仓库时给出原因，不让人对着空下拉发呆', async () => {
    useCloudStore.setState({
      devices: [
        {
          id: 'dev-1',
          name: '工作站',
          platform: 'win32',
          online: true,
          workspaces: [{ path: 'E:/plain', name: 'plain', isGit: false }],
        },
      ],
    })
    render(<CloudView onBackHome={() => undefined} />)
    fireEvent.click(screen.getByText('确认方案并授权'))
    expect(await screen.findByText('这台设备上没有可派活的 git 仓库')).toBeTruthy()
  })
})

describe('解绑提示', () => {
  it('已被云端移除时明确提示并停止“连接中”的错觉（F-08 / A-15）', async () => {
    useCloudStore.setState({
      deviceState: { status: 'error', pending: 0, revoked: true },
      clientState: { status: 'error', error: 'removed', revoked: true },
    })
    render(<CloudView onBackHome={() => undefined} />)
    expect(
      await screen.findByText(/此设备已被云端移除，已停止重连/)
    ).toBeTruthy()
    // 还得能自救：解绑回到配对页（否则桌面端只能重装才能重新配对）
    expect(screen.getByText('解除配对')).toBeTruthy()
  })
})

describe('致命拒绝提示（F-47 / A-27）', () => {
  it('服务端以 fatal 拒绝时给常驻提示与重连入口（有历史消息也要看得见）', async () => {
    useCloudStore.setState({
      clientState: { status: 'error', fatal: true, error: 'Client must be updated' },
      messages: [{ id: 'm-1', role: 'assistant', text: '历史消息', at: Date.now(), traces: [] }],
    })
    render(<CloudView onBackHome={() => undefined} />)
    // 提示不能只活在「对话为空」的空状态里
    expect(await screen.findByText(/Client must be updated/)).toBeTruthy()
    expect(screen.getByText('重新连接')).toBeTruthy()
  })
})

describe('云端页交互与配置升级（F-01 / U-01 / U-02 / U-03 / U-04）', () => {
  it('顶栏弹窗配置云端模型：传 providerId 拉目录并回显保存（F-01 / U-04）', async () => {
    vi.mocked(api.cloudGetConfig).mockResolvedValueOnce({
      success: true,
      config: {
        configured: true,
        providerId: 'openai',
        model: 'gpt-5',
        apiKeyMasked: 'sk-****9999',
      },
    })
    vi.mocked(api.cloudFetchModels).mockResolvedValueOnce({
      success: true,
      models: ['gpt-5', 'gpt-5-mini'],
      catalog: [
        { id: 'gpt-5', name: 'GPT-5', contextWindow: 128_000, maxTokens: 16_384, reasoning: true, vision: true },
        { id: 'gpt-5-mini', name: 'GPT-5 Mini', contextWindow: 128_000, maxTokens: 16_384, reasoning: true, vision: true },
      ],
    })
    vi.mocked(api.cloudSaveConfig).mockResolvedValueOnce({
      success: true,
      result: { ok: true, apiKeyMasked: 'sk-****1234', takesEffect: 'next-turn' },
    })

    render(<CloudView onBackHome={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '云端模型配置' }))

    await waitFor(() => {
      expect(api.cloudFetchModels).toHaveBeenCalledWith({ providerId: 'openai' })
    })
    const providerSelect = screen.getByLabelText('供应商') as HTMLSelectElement
    expect(providerSelect.value).toBe('openai')
    const modelSelect = screen.getByLabelText('模型') as HTMLSelectElement
    expect(modelSelect.value).toBe('gpt-5')
    expect(screen.getByText(/sk-\*\*\*\*9999/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-new-1234' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(api.cloudSaveConfig).toHaveBeenCalledWith({
        providerId: 'openai',
        model: 'gpt-5',
        apiKey: 'sk-new-1234',
      })
    })
  })

  it('助手回复按 Markdown 渲染，且输入框支持 Enter 发送与 Shift+Enter 换行（U-01 / U-02）', () => {
    useCloudStore.setState({
      messages: [
        {
          id: 'm-md',
          role: 'assistant',
          text: '包含 **关键结论** 与 `npm test`',
          at: Date.now(),
          traces: [],
        },
      ],
    })
    const { container } = render(<CloudView onBackHome={() => undefined} />)
    expect(container.querySelector('.chat-markdown strong')?.textContent).toBe('关键结论')
    expect(container.querySelector('.chat-markdown code')?.textContent).toBe('npm test')
    expect(screen.getByText('Enter 发送 · Shift+Enter 换行')).toBeTruthy()

    const textarea = screen.getByPlaceholderText('说说你想让终端做什么…') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hello cloud' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(sent.length).toBe(0)

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sent.length).toBe(1)
    expect(sent[0]).toMatchObject({ type: 'say', text: 'hello cloud' })
  })

  it('右栏支持一键折叠成窄条并展开（U-04）', () => {
    render(<CloudView onBackHome={() => undefined} />)
    expect(screen.getByText('已确认的授权')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '收起运行态面板' }))
    expect(screen.queryByText('已确认的授权')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '展开运行态面板' }))
    expect(screen.getByText('已确认的授权')).toBeTruthy()
  })

  it('记忆弹窗支持内联编辑条目并保存标签（U-03）', async () => {
    vi.mocked(api.cloudGetMemoryData).mockResolvedValueOnce({
      success: true,
      memories: [
        {
          id: 'mem-1',
          kind: 'fact',
          content: '原内容',
          tags: ['old'],
          source: 'auto',
          pinned: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      docs: [],
      dreams: [],
    })
    vi.mocked(api.cloudUpdateMemory).mockResolvedValueOnce({
      success: true,
      memory: {
        id: 'mem-1',
        kind: 'decision',
        content: '新决定',
        tags: ['frontend', 'cloud'],
        source: 'manual',
        pinned: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })

    render(<CloudView onBackHome={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: '记忆与留存文档' }))
    expect(await screen.findByText('原内容')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByDisplayValue('原内容'), { target: { value: '新决定' } })
    fireEvent.change(screen.getByDisplayValue('old'), { target: { value: 'frontend, cloud' } })
    const kindSelects = screen.getAllByDisplayValue('事实')
    fireEvent.change(kindSelects[kindSelects.length - 1], { target: { value: 'decision' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(api.cloudUpdateMemory).toHaveBeenCalledWith({
        id: 'mem-1',
        kind: 'decision',
        content: '新决定',
        tags: ['frontend', 'cloud'],
      })
    })
    expect(await screen.findByText('新决定')).toBeTruthy()
    expect(screen.getByText('frontend')).toBeTruthy()
    expect(screen.getByText('cloud')).toBeTruthy()
  })

  it('梦境整理有记录时不显示空态，并展示本地化触发方式；未读为 0 时不发 mark_read', async () => {
    vi.mocked(api.cloudGetMemoryData).mockResolvedValueOnce({
      success: true,
      memories: [],
      docs: [],
      dreams: [
        {
          id: 'dream-1',
          at: Date.now(),
          trigger: 'manual',
          summary: '整理了 2 条记忆',
          added: 1,
          merged: 1,
          removed: 0,
        },
      ],
    })
    useCloudStore.setState({ lastSeq: 12, lastReadSeq: 10, unreadCount: 0 })

    render(<CloudView onBackHome={() => undefined} />)
    expect(sent.filter((frame) => frame.type === 'mark_read')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: '记忆与留存文档' }))
    const dreamTab = await screen.findByRole('tab', { name: /梦境记录/ })
    fireEvent.click(dreamTab)

    expect(await screen.findByText('整理了 2 条记忆')).toBeTruthy()
    expect(screen.getByText(/手动/)).toBeTruthy()
    expect(screen.queryByText(/还没有梦境整理记录/)).toBeNull()
  })

  it('助手消息携带思考过程与工具轨迹时渲染可折叠思考块', () => {
    useCloudStore.setState({
      messages: [
        {
          id: 'm-think-ui',
          role: 'assistant',
          text: '最终结论',
          at: Date.now(),
          thinking: '先核对在线设备清单，再决定派活目标',
          thinkingDurationMs: 2400,
          traces: [
            { id: 'tc-1', toolName: 'list_devices', summary: '工作站在线', status: 'ok', durationMs: 55 },
          ],
        },
      ],
    })
    render(<CloudView onBackHome={() => undefined} />)
    const toggle = screen.getByRole('button', { name: /思考/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/先核对在线设备清单/)).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/先核对在线设备清单/)).toBeTruthy()
    expect(screen.getByText('list_devices')).toBeTruthy()
  })

  it('工单长 Markdown 报告外层只显示清洗后的单行预览，点开结果区按 Markdown 渲染', () => {
    const report = '# 「画板开发」现状报告\n\n- **技术栈**：`WinUI 3`\n- 构建通过'
    useCloudStore.setState({
      tasks: [
        {
          id: 'T-report',
          workUnitId: 'u-1',
          title: '只读检查「画板开发」',
          status: 'done',
          deviceId: 'dev-1',
          workspacePath: 'E:/Projects/画板开发',
          createdAt: 1,
          updatedAt: 2,
          lastMilestone: report,
          result: { summary: report, changedFiles: [{ path: 'README.md', kind: 'modified' }] },
        },
      ],
    })

    const { container } = render(<CloudView onBackHome={() => undefined} />)
    // 外层摘要已剥离 Markdown 符号且单行截断，未展开前不渲染 Markdown 标题
    expect(screen.getByText(/「画板开发」现状报告 · 技术栈：WinUI 3/)).toBeTruthy()
    expect(container.querySelector('#task-result-T-report')).toBeNull()

    const toggle = screen.getByRole('button', { name: /结果与改动清单/ })
    expect(toggle.textContent).toContain('1 个文件')
    fireEvent.click(toggle)

    const panel = container.querySelector('#task-result-T-report')
    expect(panel?.querySelector('h1')?.textContent).toBe('「画板开发」现状报告')
    expect(panel?.querySelector('strong')?.textContent).toBe('技术栈')
    expect(panel?.textContent).toContain('README.md')
  })
})
