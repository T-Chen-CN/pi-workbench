import { describe, expect, it, vi } from 'vitest'
import { AgentRegistry, type RegisteredAgent } from '../electron/agent-registry'

function createFakeAgent(initialized = true): {
  agent: RegisteredAgent
  state: { disposed: boolean }
} {
  const state = { disposed: false }
  const agent: RegisteredAgent = {
    initialize: vi.fn(async () => ({ success: true })),
    chat: vi.fn(async () => ({ success: true, response: 'ok' })),
    dispose: vi.fn(() => {
      state.disposed = true
    }),
    isInitialized: () => initialized,
    getSessionMessages: () => [],
  }
  return { agent, state }
}

describe('AgentRegistry', () => {
  it('starts empty', () => {
    const registry = new AgentRegistry()
    expect(registry.get('/tmp/a')).toBeNull()
    expect(registry.shouldReuse('/tmp/a', 'config')).toBe(false)
    expect(registry.size()).toBe(0)
  })

  it('reuses an initialized agent only for the same config key', async () => {
    const registry = new AgentRegistry()
    const { agent } = createFakeAgent()
    await registry.set('/tmp/a', agent, 'config-1')

    expect(registry.shouldReuse('/tmp/a', 'config-1')).toBe(true)
    expect(registry.shouldReuse('/tmp/a', 'config-2')).toBe(false)
    expect(registry.shouldReuse('/tmp/b', 'config-1')).toBe(false)
  })

  it('does not reuse an agent that failed to initialize', async () => {
    const registry = new AgentRegistry()
    const { agent } = createFakeAgent(false)
    await registry.set('/tmp/a', agent, 'config-1')

    expect(registry.shouldReuse('/tmp/a', 'config-1')).toBe(false)
  })

  it('disposes the previous agent when replacing a workspace entry', async () => {
    const registry = new AgentRegistry()
    const first = createFakeAgent()
    const second = createFakeAgent()

    await registry.set('/tmp/a', first.agent, 'config-1')
    await registry.set('/tmp/a', second.agent, 'config-2')

    expect(first.state.disposed).toBe(true)
    expect(second.state.disposed).toBe(false)
    expect(registry.get('/tmp/a')).toBe(second.agent)
    expect(registry.size()).toBe(1)
  })

  it('disposes and forgets one workspace', async () => {
    const registry = new AgentRegistry()
    const { agent, state } = createFakeAgent()
    await registry.set('/tmp/a', agent, 'config')

    await registry.dispose('/tmp/a')

    expect(state.disposed).toBe(true)
    expect(registry.get('/tmp/a')).toBeNull()
    expect(registry.size()).toBe(0)
  })

  it('ignores disposing an unknown workspace', async () => {
    const registry = new AgentRegistry()
    await expect(registry.dispose('/tmp/missing')).resolves.toBeUndefined()
  })

  it('disposes every agent', async () => {
    const registry = new AgentRegistry()
    const a = createFakeAgent()
    const b = createFakeAgent()
    await registry.set('/tmp/a', a.agent, 'config')
    await registry.set('/tmp/b', b.agent, 'config')

    await registry.disposeAll()

    expect(a.state.disposed).toBe(true)
    expect(b.state.disposed).toBe(true)
    expect(registry.size()).toBe(0)
  })
})

describe('AgentRegistry running sessions', () => {
  it('collects session ids per workspace and skips idle agents', async () => {
    const registry = new AgentRegistry()
    const idle = createFakeAgent()
    const busy = createFakeAgent()
    busy.agent.hasRunningSessions = () => ['s1', 's2']

    await registry.set('/tmp/idle', idle.agent, 'config-1')
    await registry.set('/tmp/busy', busy.agent, 'config-1')

    expect(registry.listRunning()).toEqual([{ workspaceDir: '/tmp/busy', sessionIds: ['s1', 's2'] }])
  })

  it('treats agents without the hook as idle', async () => {
    const registry = new AgentRegistry()
    const { agent } = createFakeAgent()
    await registry.set('/tmp/a', agent, 'config-1')

    expect(registry.listRunning()).toEqual([])
  })
})
