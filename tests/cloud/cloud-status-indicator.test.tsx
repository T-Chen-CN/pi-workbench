// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudStatusIndicator } from '../../src/components/cloud/CloudStatusIndicator'
import { useCloudStore } from '../../src/store/cloudStore'
import { useI18nStore } from '../../src/store/i18nStore'
import type { CloudTaskRow } from '../../src/types/cloud'

function makeTask(overrides: Partial<CloudTaskRow> = {}): CloudTaskRow {
  return {
    id: 'T-001',
    title: '构建并跑单测',
    deviceId: 'dev-1',
    workspacePath: '/repo',
    workUnitId: 'unit-1',
    status: 'running',
    createdAt: Date.now() - 65_000,
    updatedAt: Date.now() - 1_000,
    startedAt: Date.now() - 65_000,
    ...overrides,
  }
}

beforeEach(() => {
  useI18nStore.setState({ language: 'zh' })
  useCloudStore.setState({
    link: { linked: true, deviceId: 'dev-1', deviceName: '我的电脑', baseUrl: 'https://x' },
    deviceState: { status: 'online', pending: 0 },
    clientState: { status: 'open', lastSeq: 0 },
    devices: [{ id: 'dev-1', name: '我的电脑', platform: 'win32', online: true, workspaces: [] }],
    tasks: [],
    stoppingTaskIds: {},
    initialized: true,
    init: vi.fn(async () => {}),
    stopTask: vi.fn(async () => {}),
  })
})

afterEach(() => {
  cleanup()
})

describe('CloudStatusIndicator（4.6 / A-08）', () => {
  it('单工单时显示「设备 · 标题 · 状态 · 已耗时」并提供停止按钮', () => {
    const stopTask = vi.fn(async () => {})
    useCloudStore.setState({
      tasks: [makeTask()],
      stopTask,
    })
    const onOpen = vi.fn()
    render(<CloudStatusIndicator onOpen={onOpen} />)

    expect(screen.getByText(/我的电脑 · 构建并跑单测 · 执行中/)).toBeTruthy()
    expect(screen.getByText(/01:0[5-9]/)).toBeTruthy()

    const stopButton = screen.getByRole('button', { name: '停止工单' })
    fireEvent.click(stopButton)
    expect(stopTask).toHaveBeenCalledWith('T-001')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('设备离线时停止按钮置灰', () => {
    useCloudStore.setState({
      devices: [{ id: 'dev-1', name: '我的电脑', platform: 'win32', online: false, workspaces: [] }],
      tasks: [makeTask()],
    })
    render(<CloudStatusIndicator onOpen={vi.fn()} />)

    const stopButton = screen.getByRole('button', { name: '停止工单' }) as HTMLButtonElement
    expect(stopButton.disabled).toBe(true)
  })

  it('多工单时显示摘要并在点开后列出全部与逐条停止入口', () => {
    const stopTask = vi.fn(async () => {})
    useCloudStore.setState({
      tasks: [
        makeTask({ id: 'T-001', title: '旧工单', updatedAt: Date.now() - 10_000 }),
        makeTask({ id: 'T-007', title: '构建中任务', updatedAt: Date.now() }),
      ],
      stopTask,
    })
    render(<CloudStatusIndicator onOpen={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: /2 个执行中 · 最近：T-007 执行中/ })
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: '工单' })
    expect(dialog.textContent).toContain('T-001 · 旧工单')
    expect(dialog.textContent).toContain('T-007 · 构建中任务')

    const stopButtons = screen.getAllByRole('button', { name: '停止工单' })
    expect(stopButtons).toHaveLength(2)
    fireEvent.click(stopButtons[0])
    expect(stopTask).toHaveBeenCalledWith('T-007')
  })
})
