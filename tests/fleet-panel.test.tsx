// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FleetPanel } from '../src/components/FleetPanel'
import { useEditorStore } from '../src/store/editorStore'
import { useI18nStore } from '../src/store/i18nStore'
import { api } from '../src/api'
import { translations } from '../src/i18n/translations'
import type { FleetTask } from '../src/types/electron'

vi.mock('../src/api', () => ({
  api: {
    fleetList: vi.fn(),
    fleetGet: vi.fn(),
    fleetCreate: vi.fn(),
    fleetCancel: vi.fn(),
    fleetCleanup: vi.fn(),
    fleetMerge: vi.fn(),
    onFleetTaskUpdated: vi.fn(() => () => {}),
  },
}))

vi.mock('../src/store/dialogStore', () => ({
  confirmDialog: vi.fn(async () => true),
  useDialogStore: {
    getState: () => ({ current: null }),
  },
}))

function makeTask(overrides: Partial<FleetTask>): FleetTask {
  return {
    id: 'task-1',
    workspace: '/ws',
    name: 'patrol',
    prompt: 'Check the build',
    status: 'running',
    worktree: '/ws/.pi-worktrees/patrol-task-1',
    branch: 'pi-fleet/patrol',
    createdAt: 1,
    updatedAt: 2,
    output: '',
    ...overrides,
  }
}

const running = makeTask({ id: 'running-1', name: 'patrol', status: 'running' })
const succeeded = makeTask({
  id: 'done-1',
  name: 'release',
  status: 'succeeded',
  branch: 'pi-fleet/release',
})
const failed = makeTask({
  id: 'failed-1',
  name: 'nightly',
  status: 'failed',
  branch: 'pi-fleet/nightly',
  error: 'tests failed',
})

beforeEach(() => {
  useI18nStore.getState().setLanguage('zh')
  useEditorStore.getState().reset()
  vi.clearAllMocks()
  vi.mocked(api.fleetList).mockResolvedValue({
    success: true,
    tasks: [running, succeeded, failed],
  })
  vi.mocked(api.fleetGet).mockResolvedValue({ success: true, task: running })
  vi.mocked(api.fleetCancel).mockResolvedValue({ success: true })
  vi.mocked(api.fleetCleanup).mockResolvedValue({ success: true })
  vi.mocked(api.fleetMerge).mockResolvedValue({ success: true })
  vi.mocked(api.fleetCreate).mockResolvedValue({
    success: true,
    task: makeTask({ id: 'new-1', name: 'new task' }),
  })
  vi.mocked(api.onFleetTaskUpdated).mockReturnValue(() => {})
})

afterEach(() => {
  cleanup()
})

describe('FleetPanel', () => {
  it('renders tasks with their status', async () => {
    render(<FleetPanel workspacePath="/ws" open onClose={vi.fn()} />)

    expect(await screen.findByText('patrol')).toBeTruthy()
    expect(screen.getByText('release')).toBeTruthy()
    expect(screen.getByText('nightly')).toBeTruthy()
    expect(screen.getByText(translations.zh.fleetRunning)).toBeTruthy()
    expect(screen.getByText(translations.zh.fleetSucceeded)).toBeTruthy()
    expect(screen.getByText(translations.zh.fleetFailed)).toBeTruthy()
  })

  it('shows an empty state when there are no tasks', async () => {
    vi.mocked(api.fleetList).mockResolvedValue({ success: true, tasks: [] })
    render(<FleetPanel workspacePath="/ws" open onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText(translations.zh.fleetEmpty)).toBeTruthy()
    })
  })

  it('creates a task from the form', async () => {
    render(<FleetPanel workspacePath="/ws" open onClose={vi.fn()} />)
    await screen.findByText('patrol')

    fireEvent.change(screen.getByPlaceholderText(translations.zh.fleetNamePlaceholder), {
      target: { value: 'new task' },
    })
    fireEvent.change(screen.getByPlaceholderText(translations.zh.fleetPromptPlaceholder), {
      target: { value: 'Do the thing' },
    })
    fireEvent.click(screen.getByText(translations.zh.fleetCreate))

    await waitFor(() => {
      expect(api.fleetCreate).toHaveBeenCalledWith('/ws', 'new task', 'Do the thing')
    })
  })

  it('cancels a running task', async () => {
    render(<FleetPanel workspacePath="/ws" open onClose={vi.fn()} />)
    await screen.findByText('patrol')

    fireEvent.click(screen.getByText(translations.zh.fleetCancel))

    await waitFor(() => {
      expect(api.fleetCancel).toHaveBeenCalledWith('running-1', '/ws')
    })
  })

  it('only offers merge for succeeded tasks', async () => {
    render(<FleetPanel workspacePath="/ws" open onClose={vi.fn()} />)
    await screen.findByText('release')

    const mergeButtons = screen.getAllByText(translations.zh.fleetMerge)
    expect(mergeButtons).toHaveLength(1)

    fireEvent.click(mergeButtons[0])
    await waitFor(() => {
      expect(api.fleetMerge).toHaveBeenCalledWith('done-1', '/ws')
    })
  })

  it('cleans up a finished task', async () => {
    render(<FleetPanel workspacePath="/ws" open onClose={vi.fn()} />)
    await screen.findByText('release')

    fireEvent.click(screen.getAllByText(translations.zh.fleetCleanup)[0])

    await waitFor(() => {
      expect(api.fleetCleanup).toHaveBeenCalledWith('done-1', '/ws')
    })
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(<FleetPanel workspacePath="/ws" open onClose={onClose} />)
    await screen.findByText('patrol')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
