import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERMISSION_LEVEL,
  DEFAULT_PERMISSION_POLICY,
  PERMISSION_LEVEL_POLICIES,
  buildApprovalDetails,
  categorizeTool,
  derivePermissionLevelFromPolicy,
  isAllowDecision,
  normalizePermissionPolicy,
  normalizeSessionPermission,
  resolvePermissionPolicy,
} from '../pi-bridge/src/approval-policy'

describe('categorizeTool', () => {
  it('groups read-only tools', () => {
    for (const name of [
      'read',
      'grep',
      'find',
      'ls',
      'submit_plan',
      'update_plan_step',
      'web_search',
      'fetch_content',
      'get_search_content',
      'source_check',
    ]) {
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
    expect(isAllowDecision({ action: 'allow-always' })).toBe(true)
    expect(isAllowDecision({ action: 'deny', reason: 'no' })).toBe(false)
  })
})

describe('session permission', () => {
  it('defaults to the ask mode', () => {
    expect(normalizeSessionPermission(undefined)).toEqual({
      mode: DEFAULT_PERMISSION_LEVEL,
      grants: [],
    })
    expect(normalizeSessionPermission({ mode: 'nonsense' }).mode).toBe('ask')
  })

  it('accepts the legacy level field from older sessions', () => {
    expect(normalizeSessionPermission({ level: 'readonly' })).toEqual({
      mode: 'readonly',
      grants: [],
    })
    expect(normalizeSessionPermission({ level: 'ask', grants: ['write'] })).toEqual({
      mode: 'ask',
      grants: ['write'],
    })
  })

  it('keeps plan as a read-only session mode', () => {
    expect(resolvePermissionPolicy({ mode: 'plan' })).toEqual(
      PERMISSION_LEVEL_POLICIES.readonly
    )
  })

  it('only keeps grants for categories that ask by default', () => {
    expect(
      normalizeSessionPermission({
        mode: 'ask',
        grants: ['write', 'read', 'bogus', 'command'],
      }).grants
    ).toEqual(['write', 'command'])
  })

  it('drops grants outside the ask mode', () => {
    expect(normalizeSessionPermission({ mode: 'auto', grants: ['write'] })).toEqual({
      mode: 'auto',
      grants: [],
    })
    expect(normalizeSessionPermission({ mode: 'readonly', grants: ['write'] })).toEqual({
      mode: 'readonly',
      grants: [],
    })
    expect(normalizeSessionPermission({ mode: 'plan', grants: ['write'] })).toEqual({
      mode: 'plan',
      grants: [],
    })
  })

  it('resolves the four modes into policies', () => {
    expect(resolvePermissionPolicy({ mode: 'readonly' })).toEqual(
      PERMISSION_LEVEL_POLICIES.readonly
    )
    expect(resolvePermissionPolicy({ mode: 'ask' })).toEqual(PERMISSION_LEVEL_POLICIES.ask)
    expect(resolvePermissionPolicy({ mode: 'auto' })).toEqual(PERMISSION_LEVEL_POLICIES.auto)
    expect(resolvePermissionPolicy({ mode: 'plan' })).toEqual(PERMISSION_LEVEL_POLICIES.readonly)
  })

  it('applies grants on top of the ask mode', () => {
    const policy = resolvePermissionPolicy({ mode: 'ask', grants: ['write', 'command'] })
    expect(policy).toEqual({ read: 'allow', write: 'allow', command: 'allow', other: 'ask' })
  })
})

describe('derivePermissionLevelFromPolicy', () => {
  it('maps presets back to their level', () => {
    expect(derivePermissionLevelFromPolicy(PERMISSION_LEVEL_POLICIES.readonly)).toBe('readonly')
    expect(derivePermissionLevelFromPolicy(PERMISSION_LEVEL_POLICIES.ask)).toBe('ask')
    expect(derivePermissionLevelFromPolicy(PERMISSION_LEVEL_POLICIES.auto)).toBe('auto')
  })

  it('never widens permissions when migrating custom policies', () => {
    // 写入已放开但命令仍询问：只能落到更严的 ask，不能落到 auto
    expect(
      derivePermissionLevelFromPolicy({
        read: 'allow',
        write: 'allow',
        command: 'ask',
        other: 'ask',
      })
    ).toBe('ask')
    // 只把 write 收紧为拒绝时，ask 档会放宽命令，因此只能落到只读
    expect(derivePermissionLevelFromPolicy({ write: 'deny' })).toBe('readonly')
    expect(derivePermissionLevelFromPolicy({ write: 'deny', command: 'deny', other: 'deny' })).toBe(
      'readonly'
    )
  })
})
