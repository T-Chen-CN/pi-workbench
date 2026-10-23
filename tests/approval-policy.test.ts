import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERMISSION_POLICY,
  buildApprovalDetails,
  categorizeTool,
  isAllowDecision,
  normalizePermissionPolicy,
} from '../pi-bridge/src/approval-policy'

describe('categorizeTool', () => {
  it('groups read-only tools', () => {
    for (const name of ['read', 'grep', 'find', 'ls']) {
      expect(categorizeTool(name)).toBe('read')
    }
  })

  it('groups file mutations', () => {
    expect(categorizeTool('write')).toBe('write')
    expect(categorizeTool('edit')).toBe('write')
  })

  it('groups command execution', () => {
    expect(categorizeTool('bash')).toBe('command')
    expect(categorizeTool('powershell')).toBe('command')
  })

  it('falls back to other for unknown tools', () => {
    expect(categorizeTool('mcp__server__tool')).toBe('other')
  })
})

describe('normalizePermissionPolicy', () => {
  it('returns defaults for missing or invalid input', () => {
    expect(normalizePermissionPolicy(undefined)).toEqual(DEFAULT_PERMISSION_POLICY)
    expect(normalizePermissionPolicy('nonsense')).toEqual(DEFAULT_PERMISSION_POLICY)
    expect(normalizePermissionPolicy({ write: 'maybe' }).write).toBe('ask')
  })

  it('keeps valid overrides', () => {
    const policy = normalizePermissionPolicy({ write: 'deny', command: 'allow' })
    expect(policy.write).toBe('deny')
    expect(policy.command).toBe('allow')
    expect(policy.read).toBe('allow')
  })
})

describe('buildApprovalDetails', () => {
  it('summarizes write calls without exposing the whole file', () => {
    const content = 'x'.repeat(1000)
    const details = buildApprovalDetails('write', { path: 'src/a.ts', content })
    expect(details.path).toBe('src/a.ts')
    expect(details.preview?.length).toBeLessThan(content.length)
    expect(details.preview?.endsWith('…')).toBe(true)
  })

  it('summarizes edit call counts and command text', () => {
    expect(buildApprovalDetails('edit', { path: 'a.ts', edits: [{}, {}] }).editCount).toBe(2)
    const details = buildApprovalDetails('bash', { command: 'npm test' })
    expect(details.command).toBe('npm test')
  })

  it('omits missing fields', () => {
    expect(buildApprovalDetails('read', {})).toEqual({})
  })
})

describe('isAllowDecision', () => {
  it('treats all allow variants as allowed', () => {
    expect(isAllowDecision({ action: 'allow-once' })).toBe(true)
    expect(isAllowDecision({ action: 'allow-session' })).toBe(true)
    expect(isAllowDecision({ action: 'allow-always' })).toBe(true)
    expect(isAllowDecision({ action: 'deny', reason: 'no' })).toBe(false)
  })
})
