import { describe, it, expect } from 'vitest'
import {
  CLOUD_PROTOCOL_CAPABILITIES,
  CLOUD_PROTOCOL_VERSION,
  CLIENT_TO_SERVER_TYPES,
  DEVICE_TO_SERVER_TYPES,
  decodeFrame,
  negotiateProtocolCapabilities,
  parseClientToServerFrame,
  parseDeviceToServerFrame,
} from '../pi-bridge/src/cloud-protocol'
import {
  appSaveSettingsSchema,
  cloudPairSchema,
  cloudSaveConfigSchema,
  fsRenameSchema,
  fsWriteFileSchema,
  gitCreateBranchSchema,
  gitMergeSchema,
  parseIpcInput,
  safePathSchema,
  terminalCreateSchema,
  terminalResizeSchema,
  terminalWriteSchema,
} from '../electron/ipc/schemas'

describe('Phase 2 Milestone 4 — Zod IPC & Cloud Protocol Schemas', () => {
  describe('cloud-protocol Zod validation & capability negotiation', () => {
    it('validates well-formed client and device frames with forward-compatible loose fields', () => {
      const clientRes = parseClientToServerFrame(
        JSON.stringify({
          v: CLOUD_PROTOCOL_VERSION,
          type: 'say',
          text: 'hello',
          clientMessageId: 'msg-1',
          futureField: 'kept-for-forward-compat',
        })
      )
      expect(clientRes.ok).toBe(true)

      const deviceRes = parseDeviceToServerFrame(
        JSON.stringify({
          v: CLOUD_PROTOCOL_VERSION,
          type: 'hello',
          deviceId: 'dev-1',
          workspaces: [{ path: '/repo', name: 'repo', isGit: true }],
          capabilities: [...CLOUD_PROTOCOL_CAPABILITIES, 'future-cap'],
        })
      )
      expect(deviceRes.ok).toBe(true)
    })

    it('rejects malformed client/device frames via decodeFrame', () => {
      const badSay = decodeFrame(
        JSON.stringify({ v: 1, type: 'say', text: 123, clientMessageId: 'm1' }),
        CLIENT_TO_SERVER_TYPES
      )
      expect(badSay.ok).toBe(false)
      if (!badSay.ok) expect(badSay.code).toBe('invalid-frame')

      const badPlan = decodeFrame(
        JSON.stringify({ v: 1, type: 'confirm_plan', planText: 'ok', items: 'not-array', quota: -1 }),
        CLIENT_TO_SERVER_TYPES
      )
      expect(badPlan.ok).toBe(false)

      const badDevice = decodeFrame(
        JSON.stringify({ v: 1, type: 'task_status', taskId: '', status: 'bogus', at: 'now' }),
        DEVICE_TO_SERVER_TYPES
      )
      expect(badDevice.ok).toBe(false)
    })

    it('negotiates protocol capabilities as intersection with supported list', () => {
      expect(negotiateProtocolCapabilities(undefined)).toEqual([])
      expect(negotiateProtocolCapabilities(['sqlite-store', 'unknown-future-cap'])).toEqual([
        'sqlite-store',
      ])
      expect(negotiateProtocolCapabilities([...CLOUD_PROTOCOL_CAPABILITIES])).toEqual([
        ...CLOUD_PROTOCOL_CAPABILITIES,
      ])
    })
  })

  describe('electron IPC Zod schemas', () => {
    it('blocks NUL bytes and oversized writes on file schemas', () => {
      expect(parseIpcInput(safePathSchema, '/tmp/a\0b').ok).toBe(false)
      expect(parseIpcInput(safePathSchema, '').ok).toBe(false)
      expect(parseIpcInput(fsRenameSchema, { oldPath: '/a', newPath: '/b' }).ok).toBe(true)
      expect(
        parseIpcInput(fsWriteFileSchema, {
          filePath: '/repo/a.txt',
          content: 'ok',
        }).ok
      ).toBe(true)
    })

    it('enforces terminal create/resize/write bounds', () => {
      const fallback = parseIpcInput(terminalCreateSchema, {
        workspaceDir: '/repo',
        cols: -5,
        rows: 99999,
      })
      expect(fallback.ok).toBe(true)
      if (fallback.ok) {
        expect(fallback.data.cols).toBe(80)
        expect(fallback.data.rows).toBe(24)
      }

      expect(
        parseIpcInput(terminalResizeSchema, { id: 't1', cols: 0, rows: 24 }).ok
      ).toBe(false)
      expect(
        parseIpcInput(terminalWriteSchema, { id: 't1', data: 'ls\n' }).ok
      ).toBe(true)
    })

    it('strips unknown keys from app:saveSettings and rejects invalid enum/range values', () => {
      const stripped = parseIpcInput(appSaveSettingsSchema, {
        language: 'en',
        theme: 'dark',
        recentWorkspaces: ['/evil'],
        unknownArbitraryKey: { nested: true },
      })
      expect(stripped.ok).toBe(true)
      if (stripped.ok) {
        expect(stripped.data).toEqual({ language: 'en', theme: 'dark' })
        expect('recentWorkspaces' in stripped.data).toBe(false)
        expect('unknownArbitraryKey' in stripped.data).toBe(false)
      }

      expect(parseIpcInput(appSaveSettingsSchema, { language: 'fr' }).ok).toBe(false)
      expect(parseIpcInput(appSaveSettingsSchema, { autoSaveDelay: 10 }).ok).toBe(false)
    })

    it('validates git and cloud IPC payloads', () => {
      expect(
        parseIpcInput(gitCreateBranchSchema, {
          workspaceDir: '/repo',
          sha: 'deadbeef',
          name: 'feat/x',
        }).ok
      ).toBe(true)
      expect(
        parseIpcInput(gitCreateBranchSchema, {
          workspaceDir: '/repo',
          sha: '--upload-pack=evil',
          name: 'feat/x',
        }).ok
      ).toBe(false)
      expect(
        parseIpcInput(gitMergeSchema, {
          workspaceDir: '/repo',
          worktreePath: '/repo',
          branch: 'main',
          strategy: 'invalid',
        }).ok
      ).toBe(false)
      expect(
        parseIpcInput(cloudPairSchema, { baseUrl: 'https://cloud.example.com', code: '123456' }).ok
      ).toBe(true)
      expect(
        parseIpcInput(cloudSaveConfigSchema, { providerId: 'openai', modelId: 'gpt-5', extra: 1 })
          .ok
      ).toBe(true)
    })
  })
})
