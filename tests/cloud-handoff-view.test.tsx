// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudWorkspaceView } from '../src/components/CloudWorkspaceView'
import { UNCONFIGURED_CONNECTION } from '../src/api/cloud'
import { useCloudStore } from '../src/store/cloudStore'
import { useDialogStore } from '../src/store/dialogStore'
import { useI18nStore } from '../src/store/i18nStore'
import { translations } from '../src/i18n/translations'
import type { CloudHandoffPreview } from '../src/types/cloud'

const zh = translations.zh

const PREVIEW: CloudHandoffPreview = {
  version: 'v1.1',
  fileName: 'pi-cloud-20261106-0123.txt',
  baseUrl: 'https://api.example.com',
  dashboardUrl: 'https://dash.example.com',
  keyMask: 'abc****ABCD',
  keyLength: 40,
  dashboardUser: 'admin',
  hasDashboardPassword: true,
  hasDashboardToken: true,
  authMode: 'basic',
  profile: 'pi-cloud',
  hermesVersion: '0.22.6',
  serverHost: '1.2.3.4',
  generatedAt: '2026-11-06T01:00:00Z',
  checks: {
    dnsOk: true,
    capabilitiesHttp: 200,
    dashboardHttp: 200,
    sseOk: true,
    tlsNotAfter: '2027-02-01T00:00:00Z',
  },
  warnings: [],
  ignored: [],
  willOverwrite: false,
  applyNonce: 'nonce-1',
}

const PLAINTEXT_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'

function installBridge(overrides: Record<string, unknown> = {}) {
  const pick = vi.fn(async () => ({ success: true, canceled: false, preview: PREVIEW }))
  const apply = vi.fn(async () => ({
    success: true,
    config: {
      dashboardUrl: 'https://dash.example.com',
      hasDeviceToken: true,
      deviceId: 'dev-1',
      hasDashboardToken: true,
      dashboardUser: 'admin',
      hasDashboardPassword: true,
    },
  }))
  const copy = vi.fn(async () => ({ success: true }))
  const writeClipboard = vi.fn(async (text: string) => {
    void text
    return true
  })

  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    cloudConfigGet: async () => ({
      success: true,
      config: {
        dashboardUrl: 'https://dash.example.com',
        hasDeviceToken: true,
        deviceId: 'dev-1',
        deviceScopes: ['chat'],
        hasDashboardToken: false,
        dashboardUser: '',
        hasDashboardPassword: false,
      },
    }),
    cloudConfigSet: async () => ({ success: true }),
    cloudConnect: async () => ({ success: true, state: 'connected', capabilities: {} }),
    cloudDisconnect: async () => ({ success: true }),
    cloudSessionsList: async () => ({ success: true, sessions: [], hasMore: false }),
    cloudHandoffPick: pick,
    cloudHandoffApply: apply,
    cloudHandoffCopy: copy,
    writeClipboardText: writeClipboard,
    onCloudEvent: () => () => {},
    onCloudStatus: () => () => {},
    onCloudDashboardLoadFailed: () => () => {},
    onCloudDashboardClosed: () => () => {},
    ...overrides,
  }
  return { pick, apply, copy, writeClipboard }
}

function resetStore() {
  useCloudStore.setState({
    bridgeAvailable: true,
    hydrated: true,
    config: {
      ...UNCONFIGURED_CONNECTION,
      dashboardUrl: 'https://dash.example.com',
      hasDeviceToken: true,
      deviceId: 'dev-1',
    },
    connection: 'connected',
    error: null,
    capabilities: null,
    sessions: [],
    sessionsLoading: false,
    sessionsLoadingMore: false,
    sessionsHasMore: false,
    sessionQuery: '',
    sessionActionPending: null,
    sessionsSyncedAt: null,
    syncing: false,
    sessionsError: null,
    activeSessionId: null,
    sessionMeta: null,
    parts: [],
    partsLoading: false,
    partsError: null,
    runId: null,
    runState: null,
    runError: null,
    steerError: null,
    resolveError: null,
    resolvingUnknown: false,
    pendingWrites: [],
    ledgerError: null,
    jobs: [],
    jobsLoading: false,
    jobsError: null,
    jobActionPending: null,
    clarifyPending: null,
    clarifyError: null,
    diagnostics: null,
    diagnosticsLoading: false,
    diagnosticsError: null,
    pending: null,
    pendingDisconnect: null,
    historyToken: 0,
    draft: '',
    handoffPreview: null,
    handoffBusy: null,
    handoffError: null,
  })
  useDialogStore.setState({ current: null })
}

const renderPage = () => render(<CloudWorkspaceView view="cloud-connection" onNavigate={vi.fn()} />)

beforeEach(() => {
  useI18nStore.getState().setLanguage('zh')
  resetStore()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('cloud handoff import (view)', () => {
  it('picks a file and shows a masked preview only', async () => {
    const { pick, apply } = installBridge()
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: zh.cloudImportFromFile }))
    await waitFor(() => expect(pick).toHaveBeenCalled())

    expect(await screen.findByText(zh.cloudImportTitle)).toBeTruthy()
    // 预览里只有掩码
    expect(screen.getByText(PREVIEW.keyMask)).toBeTruthy()
    expect(document.body.textContent).not.toContain(PLAINTEXT_KEY)
    // 还没确认，不写盘
    expect(apply).not.toHaveBeenCalled()
  })

  it('asks before overwriting a live connection, then applies with the nonce', async () => {
    const { apply } = installBridge()
    useCloudStore.setState({ handoffPreview: { ...PREVIEW, willOverwrite: true } })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: zh.cloudImportConfirm }))

    // 覆盖前的确认框：此时还没写盘
    await waitFor(() => expect(useDialogStore.getState().current?.kind).toBe('confirm'))
    expect(apply).not.toHaveBeenCalled()

    useDialogStore.getState().close(true)
    await waitFor(() => expect(apply).toHaveBeenCalledWith({ applyNonce: PREVIEW.applyNonce }))
    // 应用完关上预览
    await waitFor(() => expect(screen.queryByText(zh.cloudImportTitle)).toBeNull())
  })

  it('applies straight away when there is nothing to overwrite', async () => {
    const { apply } = installBridge()
    useCloudStore.setState({ handoffPreview: PREVIEW })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: zh.cloudImportConfirm }))
    await waitFor(() => expect(apply).toHaveBeenCalledWith({ applyNonce: PREVIEW.applyNonce }))
    expect(useDialogStore.getState().current).toBeNull()
  })

  it('keeps the dialog open and explains a rejected file', async () => {
    installBridge({ cloudHandoffPick: async () => ({ success: false, canceled: false, code: 'not_handoff' }) })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: zh.cloudImportFromFile }))
    expect(await screen.findByText(zh.cloudHandoffErr_not_handoff)).toBeTruthy()
  })

  it('copies the console password without printing it', async () => {
    const { copy } = installBridge()
    useCloudStore.setState({ handoffPreview: PREVIEW })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: zh.cloudImportCopyPassword }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith({ field: 'password' }))
    expect(document.body.textContent).not.toContain(PLAINTEXT_KEY)
  })

  it('hides the dialog when the user leaves the connection page', async () => {
    installBridge()
    useCloudStore.setState({ handoffPreview: PREVIEW })
    const view = render(<CloudWorkspaceView view="cloud-connection" onNavigate={vi.fn()} />)
    expect(await screen.findByText(zh.cloudImportTitle)).toBeTruthy()

    view.rerender(<CloudWorkspaceView view="cloud-session" onNavigate={vi.fn()} />)
    await waitFor(() => expect(screen.queryByText(zh.cloudImportTitle)).toBeNull())
    // 状态没丢：切回来还在
    expect(useCloudStore.getState().handoffPreview).toBeTruthy()
  })
})

describe('hermes bootstrap prompt entry', () => {
  it('copies the prompt straight from the connection page', async () => {
    const { writeClipboard } = installBridge()
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: zh.cloudBootstrapCopy }))
    await waitFor(() => expect(writeClipboard).toHaveBeenCalled())

    const text = writeClipboard.mock.calls[0][0] as string
    expect(text).toContain('# hermes-handoff v1.1')
    expect(text).toContain('API_SERVER_KEY')
    // 模板里的密钥只能是空占位符
    expect(text).not.toMatch(/^API_KEY=.+/m)
  })
})
