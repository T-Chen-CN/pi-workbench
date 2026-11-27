import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => '',
  },
}))

import { ApprovalBroker } from '../../electron/approval-broker'
import { isPathInsideRoot } from '../../electron/path-safety'
import { sanitizeCanvasState, CANVAS_STATE_VERSION } from '../../electron/repo-map-canvas'
import { configureRenderBridge, renderDocumentPages } from '../../electron/documents/render-bridge'

describe('ApprovalBroker hardening', () => {
  it('denies duplicate requestId immediately without overwriting active approval', async () => {
    const sent: string[] = []
    const broker = new ApprovalBroker((payload) => {
      sent.push(payload.requestId)
    })
    const base = {
      requestId: 'req-dup',
      workspaceDir: '/ws/demo',
      sessionId: 'sess-1',
      toolCallId: 'tc-1',
      toolName: 'bash',
      category: 'command' as const,
      summary: 'echo hi',
      details: { command: 'echo hi' },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }

    const first = broker.request(base)
    const duplicate = await broker.request(base)
    expect(duplicate).toEqual({ action: 'deny', reason: 'Duplicate approval request ID.' })
    expect(sent).toEqual(['req-dup'])
    expect(broker.pendingCount).toBe(1)

    expect(broker.respond('req-dup', { action: 'allow-once' })).toBe(true)
    await expect(first).resolves.toEqual({ action: 'allow-once' })
    expect(broker.pendingCount).toBe(0)
  })

  it('normalizes workspace paths with canonicalizePath / case-insensitivity in cancelForWorkspace', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-approval-ws-'))
    try {
      const broker = new ApprovalBroker(() => undefined)
      const pending = broker.request({
        requestId: 'req-ws',
        workspaceDir: `${tmp}${path.sep}`,
        sessionId: 'sess-1',
        toolCallId: 'tc-1',
        toolName: 'write',
        category: 'write',
        summary: 'write file',
        details: {},
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      })

      const variant = process.platform === 'win32' ? tmp.toUpperCase() : tmp
      broker.cancelForWorkspace(variant)
      await expect(pending).resolves.toMatchObject({ action: 'deny' })
      expect(broker.pendingCount).toBe(0)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('isPathInsideRoot', () => {
  it('accepts filenames starting with .. such as ..env and ..foo while rejecting parent escapes', () => {
    const root = path.resolve('/repo')
    expect(isPathInsideRoot(root, path.join(root, '..env'))).toBe(true)
    expect(isPathInsideRoot(root, path.join(root, '..foo', 'bar.ts'))).toBe(true)
    expect(isPathInsideRoot(root, root)).toBe(true)
    expect(isPathInsideRoot(root, path.dirname(root))).toBe(false)
    expect(isPathInsideRoot(root, path.resolve(root, '..', 'outside.txt'))).toBe(false)
  })
})

describe('sanitizeCanvasState prototype pollution guard', () => {
  it('drops __proto__, constructor, and prototype keys without polluting Object.prototype', () => {
    const raw = JSON.parse(
      JSON.stringify({
        version: CANVAS_STATE_VERSION,
        layoutVersion: 4,
        zoom: 1,
        pan: { x: 0, y: 0 },
        folders: {
          'src/safe': { x: 10, y: 20 },
          constructor: { x: 1, y: 2 },
          prototype: { x: 3, y: 4 },
          'src/__proto__': { x: 5, y: 6 },
        },
        files: {
          'src/index.ts': { x: 30, y: 40 },
        },
      })
    ) as Record<string, unknown>
    Object.defineProperty(raw.files as Record<string, unknown>, '__proto__', {
      value: { x: 99, y: 99 },
      enumerable: true,
      configurable: true,
    })

    const clean = sanitizeCanvasState(raw)
    expect(Object.keys(clean.folders)).toEqual(['src/safe'])
    expect(Object.keys(clean.files)).toEqual(['src/index.ts'])
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })
})

describe('render-bridge main-window only target', () => {
  let tmpDir = ''
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-render-bridge-'))
  })
  afterEach(async () => {
    configureRenderBridge({ getMainWindow: () => null })
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('rejects cleanly when mainWindow is unavailable instead of falling back to auxiliary windows', async () => {
    const pdfFile = path.join(tmpDir, 'scan.pdf')
    await fs.writeFile(pdfFile, '%PDF-1.4\n%EOF\n')
    configureRenderBridge({ getMainWindow: () => null })

    await expect(
      renderDocumentPages({ path: pdfFile, pages: [1], scale: 2 })
    ).rejects.toThrow(/没有可用窗口/)
  })
})
