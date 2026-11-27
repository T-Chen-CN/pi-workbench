// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWorkbenchI18n,
  i18n,
  localizeErrorMessage,
  translate,
  translations,
} from '@pi-workbench/i18n'
import { HostDocumentProvider, Modal } from '@pi-workbench/ui'
import {
  CloudChatComposer,
  CloudConfigForm,
  CloudDeviceList,
  CloudMemoryManager,
  type CloudMemoryItem,
} from '@pi-workbench/cloud-ui'
import { useI18nStore } from '../../src/store/i18nStore'
import { CloudWebApp } from '../../apps/cloud/web-src/CloudWebApp'

function walkFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walkFiles(full) : [full]
  })
}

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = FakeWebSocket.OPEN
  listeners: Record<string, Array<(event: any) => void>> = {}
  sent: string[] = []
  constructor(public url: string) {}
  addEventListener(type: string, cb: (event: any) => void) {
    this.listeners[type] = [...(this.listeners[type] ?? []), cb]
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED
  }
  send(data: any) {
    this.sent.push(String(data))
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useI18nStore.getState().setLanguage('zh')
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('Phase D · @pi-workbench/i18n typed i18next contract', () => {
  it('keeps strict zh/en key parity and single-brace {param} interpolation', () => {
    const zhKeys = Object.keys(translations.zh).sort()
    const enKeys = Object.keys(translations.en).sort()
    expect(enKeys).toEqual(zhKeys)

    for (const lang of ['zh', 'en'] as const) {
      for (const [key, value] of Object.entries(translations[lang])) {
        expect(value, `${lang}.${key}`).not.toMatch(/\{\{|\}\}/)
      }
    }

    const custom = createWorkbenchI18n('en')
    expect(custom.t('welcomeProjectCount', { replace: { count: 7 } })).toBe('7 projects')
    expect(translate('zh', 'welcomeProjectCount', { count: 7 })).toBe('共 7 个项目')
    expect(translate('en', 'trayRunningTaskOne', { count: 1 })).toBe('1 task running')
    expect(translate('en', 'trayRunningTaskMany', { count: 3 })).toBe('3 tasks running')
    expect(translate('zh', 'trayShowWindow')).toBe('显示主窗口')
    expect(translate('en', 'trayShowWindow')).toBe('Show Main Window')
  })

  it('localizes structured error codes, legacy strings, prefixes, and preserves unknown messages', () => {
    const zhT = (key: keyof typeof translations.zh, params?: Record<string, string | number>) =>
      translate('zh', key, params)
    const enT = (key: keyof typeof translations.zh, params?: Record<string, string | number>) =>
      translate('en', key, params)

    expect(localizeErrorMessage('ERR_PATH_OUTSIDE_WORKSPACE', zhT)).toBe('路径不在当前工作区内')
    expect(localizeErrorMessage('ERR_PATH_OUTSIDE_WORKSPACE', enT)).toBe(
      'Path is outside the open workspace'
    )
    expect(localizeErrorMessage('ERR_UPDATE_RATE_LIMIT', zhT)).toBe('更新检查过于频繁，请稍后再试')
    expect(localizeErrorMessage('File already exists', zhT)).toBe('文件已存在')
    expect(localizeErrorMessage('Failed to initialize agent: bad key', enT)).toBe(
      'Failed to initialize agent: bad key'
    )
    expect(localizeErrorMessage('Failed to initialize agent: bad key', zhT)).toBe(
      'Agent 初始化失败：bad key'
    )
    expect(localizeErrorMessage('Custom unmapped error', zhT)).toBe('Custom unmapped error')
    expect(localizeErrorMessage(null, zhT)).toBe('')
  })

  it('synchronizes desktop useI18nStore with the shared @pi-workbench/i18n singleton', () => {
    useI18nStore.getState().setLanguage('en')
    expect(i18n.language).toBe('en')
    expect(useI18nStore.getState().t('cloudTitle')).toBe('Cloud')

    useI18nStore.getState().setLanguage('zh')
    expect(i18n.language).toBe('zh')
    expect(useI18nStore.getState().t('cloudTitle')).toBe('云端')
  })
})

describe('Phase D · @pi-workbench/ui and @pi-workbench/cloud-ui deduplication boundaries', () => {
  it('has zero desktop store / electron / src TS imports in packages/ui, packages/cloud-ui, and apps/cloud/web-src', () => {
    const dirs = [
      resolve(__dirname, '../../packages/ui/src'),
      resolve(__dirname, '../../packages/cloud-ui/src'),
      resolve(__dirname, '../../apps/cloud/web-src'),
    ]
    for (const dir of dirs) {
      const files = walkFiles(dir).filter((file) => /\.(ts|tsx)$/.test(file))
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        const content = readFileSync(file, 'utf-8')
        expect(content, `${file} must not import zustand`).not.toMatch(/\bfrom\s+['"]zustand['"]/)
        expect(content, `${file} must not import electron`).not.toMatch(/\bfrom\s+['"]electron['"]/)
        expect(content, `${file} must not import TS/TSX modules from ../../../src/`).not.toMatch(
          /\bfrom\s+['"][^'"]*\/src\/(?!index\.css)/
        )
      }
    }

    // Verify Paper & Ink invariants in packages/ui/src/patterns.tsx directly
    const patternsSrc = readFileSync(resolve(__dirname, '../../packages/ui/src/patterns.tsx'), 'utf-8')
    expect(patternsSrc).toContain('border border-rule-hairline bg-raised')
    expect(patternsSrc).not.toContain('shadow-print')
    expect(patternsSrc).toContain('border-b border-rule-divide')
    expect(patternsSrc.slice(patternsSrc.indexOf('data-tab-aux=""'))).toContain('h-6 w-6')
  })

  it('renders @pi-workbench/ui Modal with default document and custom HostDocumentProvider', () => {
    const { rerender } = render(
      <Modal open={true} onClose={() => {}} title="Standalone Modal">
        <p>Body content</p>
      </Modal>
    )
    expect(screen.getByRole('dialog', { name: 'Standalone Modal' })).toBeTruthy()

    const auxDoc = document.implementation.createHTMLDocument('aux')
    rerender(
      <HostDocumentProvider value={auxDoc}>
        <Modal open={true} onClose={() => {}} title="Aux Modal">
          <p>Inside aux</p>
        </Modal>
      </HostDocumentProvider>
    )
    expect(auxDoc.body.textContent).toContain('Aux Modal')
  })

  it('renders shared CloudChatComposer, CloudDeviceList, CloudConfigForm, and CloudMemoryManager in English with zero desktop store', async () => {
    const onSend = vi.fn()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    const memories: CloudMemoryItem[] = [
      {
        id: 'm1',
        kind: 'fact',
        content: 'Uses Node 24',
        tags: ['runtime'],
        source: 'manual',
        pinned: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'm2',
        kind: 'decision',
        content: 'Adopted i18next',
        tags: ['i18n'],
        source: 'dream',
        pinned: false,
        createdAt: 2,
        updatedAt: 2,
      },
    ]

    render(
      <div>
        <CloudChatComposer
          value="Check status"
          onChange={() => {}}
          onSend={onSend}
          canStopReply={false}
          onStopReply={() => {}}
          language="en"
        />
        <CloudDeviceList
          devices={[
            {
              id: 'dev-1',
              name: 'Workstation',
              platform: 'win32',
              online: true,
              workspaces: [{ path: '/repo', name: 'repo', isGit: true }],
            },
          ]}
          pairCode={{ code: '654321', expiresAt: Date.now() + 60_000 }}
          language="en"
          onGeneratePairCode={async () => {}}
          onRemoveDevice={async () => {}}
        />
        <CloudConfigForm
          providerId="openai"
          model="gpt-5"
          apiKey=""
          apiKeyMasked="sk-****8888"
          models={[{ id: 'gpt-5', name: 'GPT-5', contextWindow: 128_000, reasoning: true, vision: true }]}
          language="en"
          onProviderChange={() => {}}
          onModelChange={() => {}}
          onApiKeyChange={() => {}}
        />
        <CloudMemoryManager
          memories={memories}
          docs={[]}
          dreams={[]}
          docDrafts={{}}
          language="en"
          layout="cards"
          showKindFilter
          onDocDraftChange={() => {}}
          onRefresh={async () => {}}
          onAddMemory={async () => ({ ok: true })}
          onUpdateMemory={async () => ({ ok: true })}
          onDeleteMemory={async () => ({ ok: true })}
          onSaveDoc={async () => ({ ok: true })}
          onRunDream={async () => ({ ok: true })}
        />
      </div>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('654321'))

    expect(screen.getByText('GPT-5')).toBeTruthy()
    expect(screen.getByText('Uses Node 24')).toBeTruthy()
    expect(screen.getByText('Adopted i18next')).toBeTruthy()

    // Filter memories by kind ('Decision')
    fireEvent.click(screen.getByRole('button', { name: 'Decision' }))
    expect(screen.queryByText('Uses Node 24')).toBeNull()
    expect(screen.getByText('Adopted i18next')).toBeTruthy()
  })
})

describe('Phase D · Cloud Web live ZH ↔ EN switching', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const path = String(typeof input === 'string' ? input : input.url).split('?')[0]
        const json = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload })
        if (path === '/v1/me') return json({ hasAccount: true, authenticated: true, version: '0.11.2' })
        if (path === '/v1/devices') return json({ devices: [] })
        if (path === '/v1/authorizations') return json({ authorizations: [] })
        if (path === '/v1/cloud-config') return json({ configured: false })
        if (path === '/v1/cloud-config/catalog') {
          return json({
            providerId: 'deepseek',
            models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1_000_000 }],
          })
        }
        if (path === '/v1/memories') return json({ memories: [] })
        if (path === '/v1/cloud-docs') return json({ docs: [] })
        if (path === '/v1/dreams') return json({ dreams: [] })
        return { ok: false, status: 404, json: async () => ({}) }
      })
    )
  })

  it('defaults to Chinese and switches all Cloud Web tabs, composer, cards, and settings live to English', async () => {
    render(<CloudWebApp />)
    await waitFor(() => expect(document.querySelector('header.top')).not.toBeNull())

    // Default Chinese
    expect(screen.getByRole('tab', { name: '会话' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '记忆' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy()
    expect(document.querySelector('aside')?.textContent).toContain('已确认的授权')

    // Toggle to English
    fireEvent.click(screen.getByRole('button', { name: '切换界面语言' }))
    expect(window.localStorage.getItem('pi-cloud-lang')).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Tasks' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Devices' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Memory' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop reply' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm plan…' })).toBeTruthy()
    expect(document.querySelector('aside')?.textContent).toContain('Confirmed authorizations')

    // Memory tab in English
    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }))
    expect(await screen.findByText('Structured long-term memory')).toBeTruthy()
    expect(screen.getByText('Saved cloud docs (live)')).toBeTruthy()
    expect(screen.getByText('Dream consolidation log')).toBeTruthy()

    // Settings tab in English
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(await screen.findByText('Cloud model settings')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()

    // Toggle back to Chinese
    fireEvent.click(screen.getByRole('button', { name: 'Switch interface language' }))
    expect(window.localStorage.getItem('pi-cloud-lang')).toBe('zh')
    expect(screen.getByRole('tab', { name: '会话' })).toBeTruthy()
    expect(screen.getByText('云端模型配置')).toBeTruthy()
  })
})
