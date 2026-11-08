// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DispatchCard } from '../src/components/DispatchCard'
import { useDispatchStore } from '../src/store/dispatchStore'
import { useI18nStore } from '../src/store/i18nStore'
import { EMPTY_DISPATCH_CONFIG } from '../src/api/dispatch'

const zh = useI18nStore.getState().t

const WORKSPACE = {
  id: 'ws-1',
  path: '/Users/dev/repo',
  label: 'Repo',
  description: '前端',
  exists: true,
  published: true,
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    config: {
      enabled: true,
      workspaces: [WORKSPACE],
      state: {
        enabled: true,
        connected: true,
        lastFrameAt: 1,
        lastError: null,
        runningTaskId: null,
        runningWorkspace: null,
        queued: 0,
        publishedAt: 1,
        recent: [],
      },
      ...overrides,
    },
  }
}

interface Stub {
  set: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  listeners: Array<(payload: unknown) => void>
}

function installBridge(getResult: unknown, overrides: Partial<Stub> = {}): Stub {
  const stub: Stub = {
    set: vi.fn(async () => config()),
    stop: vi.fn(async () => config({ enabled: false })),
    remove: vi.fn(async () => config({ workspaces: [] })),
    listeners: [],
    ...overrides,
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    dispatchConfigGet: async () => getResult,
    dispatchConfigSet: stub.set,
    dispatchWorkspaceAdd: async () => config(),
    dispatchWorkspaceUpdate: async () => config(),
    dispatchWorkspaceRemove: stub.remove,
    dispatchState: async () => getResult,
    dispatchStop: stub.stop,
    onDispatchState: (callback: (payload: unknown) => void) => {
      stub.listeners.push(callback)
      return () => {}
    },
  }
  return stub
}

beforeEach(() => {
  useI18nStore.setState({ language: 'zh' })
  useDispatchStore.setState({ config: EMPTY_DISPATCH_CONFIG, recent: [], busy: false, error: null })
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('DispatchCard', () => {
  it('shows the empty state and cannot be turned on without a workspace', async () => {
    installBridge(config({ enabled: false, workspaces: [] }))
    render(<DispatchCard connected />)
    await waitFor(() => expect(screen.getByText(zh('cloudDispatchEmpty'))).toBeTruthy())
    const toggle = screen.getByRole('button', { name: zh('cloudDispatchEnable') }) as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
  })

  it('lists workspaces with their local path and publication state', async () => {
    installBridge(config())
    render(<DispatchCard connected />)
    await waitFor(() => expect(screen.getByText('Repo')).toBeTruthy())
    expect(screen.getByText('/Users/dev/repo')).toBeTruthy()
    expect(screen.getByText(zh('cloudDispatchConnected'))).toBeTruthy()
  })

  it('marks a workspace whose directory is gone', async () => {
    installBridge(config({ workspaces: [{ ...WORKSPACE, exists: false, published: false }] }))
    render(<DispatchCard connected />)
    await waitFor(() => expect(screen.getByText(zh('cloudDispatchMissing'))).toBeTruthy())
  })

  it('toggles dispatch through the bridge', async () => {
    const stub = installBridge(config())
    render(<DispatchCard connected />)
    await waitFor(() => expect(screen.getByText('Repo')).toBeTruthy())
    screen.getByRole('button', { name: zh('cloudDispatchOff') }).click()
    await waitFor(() => expect(stub.set).toHaveBeenCalledWith({ enabled: false }))
  })

  it('follows pushed state instead of keeping a local guess', async () => {
    const stub = installBridge(config())
    render(<DispatchCard connected />)
    await waitFor(() => expect(stub.listeners).toHaveLength(1))

    stub.listeners[0]({
      config: config({
        state: {
          enabled: true,
          connected: true,
          lastFrameAt: 2,
          lastError: null,
          runningTaskId: 't-1',
          runningWorkspace: 'Repo',
          queued: 2,
          publishedAt: 2,
          recent: [],
        },
      }).config,
    })

    await waitFor(() =>
      expect(screen.getByText(zh('cloudDispatchRunning').replace('{workspace}', 'Repo'))).toBeTruthy()
    )
    expect(screen.getByText(zh('cloudDispatchQueued').replace('{count}', '2'))).toBeTruthy()
  })

  it('says dispatch is unavailable without a main process', () => {
    render(<DispatchCard connected />)
    expect(screen.getByText(zh('cloudDispatchLocalOnly'))).toBeTruthy()
  })
})
