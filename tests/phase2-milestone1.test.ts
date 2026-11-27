import { describe, expect, it, vi } from 'vitest'
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

import {
  buildApprovalDetails,
  categorizeTool,
  sanitizeApprovalText,
} from '../pi-bridge/src/approval-policy'
import { parseGithubRemote } from '../electron/git-worktrees'
import { PluginManager } from '../electron/plugin-manager'
import { runDreamConsolidation } from '../apps/cloud/src/memory/memory-engine'
import { CloudMemoryStore } from '../apps/cloud/src/memory/memory-store'

describe('Phase 2 Milestone 1 hardening', () => {
  it('categorizes switch_worktree under write and strips OSC/BiDi/CR spoofing from approval text', () => {
    expect(categorizeTool('switch_worktree')).toBe('write')
    const poisoned = '\u001b]0;fake\u0007\u202eevil\r\u001b[31mrm -rf /\u001b[0m'
    expect(sanitizeApprovalText(poisoned)).toBe('evilrm -rf /')
    const details = buildApprovalDetails('bash', { command: poisoned, path: '\u202ea.txt' })
    expect(details.command).toBe('evilrm -rf /')
    expect(details.path).toBe('a.txt')
  })

  it('rejects malformed GitHub remote owner/repo segments', () => {
    expect(parseGithubRemote('https://github.com/valid-owner/valid_repo.git')).toEqual({
      owner: 'valid-owner',
      repo: 'valid_repo',
    })
    expect(parseGithubRemote('https://github.com/owner/..evil.git')).toBeNull()
    expect(parseGithubRemote('https://github.com/-badowner/repo.git')).toBeNull()
    expect(parseGithubRemote('https://github.com/owner/repo?foo=bar')).toBeNull()
  })

  it('blocks plugin auto-activation when disk files change after approval hash pinning', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-plugin-hash-'))
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-plugin-state-'))
    const stateFilePath = path.join(stateDir, 'workspace-plugins.json')
    const pluginDir = path.join(workspace, '.pi-workbench', 'plugins', 'demo')
    await fs.mkdir(pluginDir, { recursive: true })
    await fs.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ id: 'demo', name: 'Demo', main: 'index.js' }),
      'utf-8'
    )
    await fs.writeFile(
      path.join(pluginDir, 'index.js'),
      `module.exports = { activate(api) { api.registerCommand('demo.hi', () => ({ success: true, output: 'v1' })) } }`,
      'utf-8'
    )

    const mgr = new PluginManager({ watch: false, stateFilePath })
    try {
      const enabled = mgr.setEnabled(workspace, 'demo', true)
      expect(enabled[0].enabled).toBe(true)
      expect(enabled[0].error).toBeUndefined()

      // Simulate untrusted modification (e.g. git pull / agent edit) without re-enabling
      await fs.writeFile(
        path.join(pluginDir, 'index.js'),
        `module.exports = { activate() { throw new Error('should not run') } }`,
        'utf-8'
      )
      const reloaded = mgr.reload(workspace)
      expect(reloaded[0].enabled).toBe(false)
      expect(reloaded[0].error).toContain('changed since approval')
    } finally {
      await mgr.disposeAllAsync()
      await fs.rm(workspace, { recursive: true, force: true })
      await fs.rm(stateDir, { recursive: true, force: true })
    }
  })

  it('guards dream consolidation against destructive wipe with empty upsert', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-dream-guard-'))
    try {
      const store = await CloudMemoryStore.open(dir)
      await store.mergeAutoMemories(
        Array.from({ length: 10 }, (_, i) => ({
          kind: 'fact',
          content: `Auto fact number ${i + 1} with distinct details`,
          tags: ['auto'],
        })),
        'auto',
        1000
      )
      const allIds = store.listMemories().map((m) => m.id)
      const res = await runDreamConsolidation(
        store,
        'manual',
        async () => JSON.stringify({ summary: 'wipe all', removeIds: allIds, upsert: [] }),
        2000
      )
      expect(res).toBeNull()
      expect(store.listMemories()).toHaveLength(10)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
