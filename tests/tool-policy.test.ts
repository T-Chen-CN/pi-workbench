import { describe, expect, it } from 'vitest'
import {
  PLAN_MODE_TOOLS,
  READ_ONLY_TOOLS,
  resolveModeTools,
} from '../pi-bridge/src/tool-policy'

const REGISTERED = [
  'read',
  'grep',
  'find',
  'ls',
  'write',
  'edit',
  'bash',
  'powershell',
  // 内置联网扩展先于内联扩展加载，注册顺序据此排列
  'web_search',
  'fetch_content',
  'get_search_content',
  'source_check',
  'submit_plan',
  'update_plan_step',
]

describe('resolveModeTools', () => {
  it('limits readonly to the read-only tools', () => {
    expect(resolveModeTools('readonly', REGISTERED, 'win32')).toEqual([
      ...READ_ONLY_TOOLS,
    ])
  })

  it('adds submit_plan in plan mode without enabling write or command tools', () => {
    const tools = resolveModeTools('plan', REGISTERED, 'win32')
    expect(tools).toEqual([...PLAN_MODE_TOOLS])
    expect(tools).not.toContain('write')
    expect(tools).not.toContain('bash')
  })

  it('keeps web tools available in readonly and plan modes', () => {
    for (const mode of ['readonly', 'plan'] as const) {
      const tools = resolveModeTools(mode, REGISTERED, 'win32')
      expect(tools).toEqual(
        expect.arrayContaining([
          'web_search',
          'fetch_content',
          'get_search_content',
          'source_check',
        ])
      )
    }
  })

  it('exposes all registered tools except plan-only tools in ask and auto', () => {
    const expected = REGISTERED.filter((name) => name !== 'submit_plan')
    expect(resolveModeTools('ask', REGISTERED, 'win32')).toEqual(expected)
    expect(resolveModeTools('auto', REGISTERED, 'win32')).toEqual(expected)
  })

  it('includes update_plan_step in execution modes', () => {
    expect(resolveModeTools('ask', REGISTERED, 'win32')).toContain(
      'update_plan_step'
    )
    expect(resolveModeTools('auto', REGISTERED, 'win32')).toContain(
      'update_plan_step'
    )
  })

  it('keeps powershell out of non-Windows execution modes', () => {
    expect(resolveModeTools('ask', REGISTERED, 'darwin')).not.toContain(
      'powershell'
    )
    expect(resolveModeTools('auto', REGISTERED, 'linux')).not.toContain(
      'powershell'
    )
    expect(resolveModeTools('ask', REGISTERED, 'win32')).toContain('powershell')
  })

  it('ignores tools that are not registered', () => {
    expect(
      resolveModeTools('readonly', ['read', 'bash', 'submit_plan'], 'win32')
    ).toEqual(['read'])
  })

  it('keeps plan-only tools out of execution even if they are registered', () => {
    expect(resolveModeTools('auto', ['read', 'submit_plan'], 'win32')).toEqual([
      'read',
    ])
  })

  it('returns an empty list when nothing is registered', () => {
    expect(resolveModeTools('auto', [], 'win32')).toEqual([])
  })
})
