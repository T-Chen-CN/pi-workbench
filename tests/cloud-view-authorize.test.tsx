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
    cloudFetchModels: vi.fn(async () => ({ success: false, models: [] })),
    cloudPair: vi.fn(async () => ({ success: false })),
    cloudUnlink: vi.fn(async () => ({ success: true })),
    cloudListWorkspaces: vi.fn(async () => ({ success: true, workspaces: [] })),
    onCloudState: vi.fn(() => () => undefined),
    onCloudClientState: vi.fn(() => () => undefined),
    onCloudClientFrame: vi.fn(() => () => undefined),
  },
}))

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
