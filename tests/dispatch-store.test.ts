// @vitest-environment jsdom
/**
 * 派活 store：主进程推送的运行态要能反向修正开关显示。
 *
 * 这条是 UI 验收里发现的：从别的入口（另一个窗口 / 退出前落盘）改掉开关后，
 * 卡片仍显示旧状态，因为 `applyState` 只合并了 state，没把 `enabled` 带上来。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/api/dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/dispatch')>()),
  dispatchApi: {
    state: vi.fn(async () => ({ success: true, config: { enabled: false, workspaces: [], state: {} } })),
    setEnabled: vi.fn(),
    addWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    stop: vi.fn()
  }
}))

import { useDispatchStore } from '../src/store/dispatchStore'

const baseConfig = {
  enabled: true,
  workspaces: [],
  state: {
    enabled: true,
    connected: true,
    lastFrameAt: null,
    lastError: null,
    runningTaskId: null,
    runningWorkspace: null,
    question: null,
    queued: 0,
    publishedAt: null,
    recent: []
  }
}

beforeEach(() => {
  useDispatchStore.setState({ config: baseConfig as never, recent: [], busy: false, error: null })
})

describe('dispatchStore.applyState', () => {
  it('follows the enabled flag pushed by the worker', () => {
    useDispatchStore.getState().applyState({ state: { ...baseConfig.state, enabled: false } })
    expect(useDispatchStore.getState().config.enabled).toBe(false)
  })

  it('keeps the previous flag when the push does not carry one', () => {
    const { enabled: _enabled, ...rest } = baseConfig.state
    useDispatchStore.getState().applyState({ state: rest })
    expect(useDispatchStore.getState().config.enabled).toBe(true)
  })
})
