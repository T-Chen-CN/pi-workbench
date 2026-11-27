import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { PluginManager } from '../../electron/plugin-manager'

let workspace: string
let appStateDir: string
let stateFilePath: string
let manager: PluginManager | null = null

function createManager(): PluginManager {
  return new PluginManager({ watch: false, stateFilePath })
}

async function writePlugin(
  id: string,
  source: string,
  manifest: Record<string, unknown> = {},
  options: { enabled?: boolean } = {}
): Promise<string> {
  const directory = path.join(workspace, '.pi-workbench', 'plugins', id)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version: '0.0.1',
      main: 'index.js',
      contributes: {
        commands: [{ id: `${id}.run`, title: `${id} run` }],
      },
      ...manifest,
    }),
    'utf-8'
  )
  await fs.writeFile(path.join(directory, 'index.js'), source, 'utf-8')

  // 插件默认禁用：除显式关闭外，测试里把插件写进应用自有启用白名单
  if (options.enabled !== false) {
    const manifestId = typeof manifest.id === 'string' && manifest.id ? manifest.id : id
    const helper = createManager()
    helper.setEnabled(workspace, manifestId, true)
    helper.disposeAll()
  }
  return directory
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-plugins-test-'))
  appStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-plugins-state-'))
  stateFilePath = path.join(appStateDir, 'workspace-plugins.json')
  await fs.mkdir(path.join(workspace, '.pi-workbench', 'plugins'), { recursive: true })
  ;(globalThis as Record<string, unknown>).__pluginHook = undefined
  ;(globalThis as Record<string, unknown>).__pluginDeactivated = false
})

afterEach(async () => {
  manager?.disposeAll()
  manager = null
  await fs.rm(workspace, { recursive: true, force: true })
  await fs.rm(appStateDir, { recursive: true, force: true })
})

describe('PluginManager', () => {
  it('does not activate plugins until they are explicitly enabled', async () => {
    ;(globalThis as Record<string, unknown>).__pluginActivated = false
    await writePlugin(
      'demo',
      `module.exports = { activate() { globalThis.__pluginActivated = true } }`,
      {},
      { enabled: false }
    )

    manager = createManager()
    const plugins = manager.loadWorkspace(workspace)

    expect(plugins[0].enabled).toBe(false)
    expect((globalThis as Record<string, unknown>).__pluginActivated).toBe(false)
    expect(manager.hasExplicitEnableList(workspace)).toBe(false)
  })

  it('loads a plugin and lists its commands', async () => {
    await writePlugin(
      'demo',
      `module.exports = {
        activate(api) {
          api.registerCommand('demo.run', (args) => ({
            success: true,
            output: 'hello ' + api.workspaceDir + ':' + (args || ''),
          }))
        },
      }`
    )

    manager = createManager()
    const plugins = manager.loadWorkspace(workspace)

    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toMatchObject({ id: 'demo', name: 'demo', enabled: true })
    expect(plugins[0].commands).toEqual([
      { id: 'demo.run', title: 'demo run', pluginId: 'demo', pluginName: 'demo' },
    ])
  })

  it('invokes commands with arguments', async () => {
    await writePlugin(
      'demo',
      `module.exports = {
        activate(api) {
          api.registerCommand('demo.run', (args) => ({ success: true, output: 'arg:' + args }))
        },
      }`
    )
    manager = createManager()
    manager.loadWorkspace(workspace)

    await expect(manager.invoke(workspace, 'demo.run', 'value')).resolves.toEqual({
      success: true,
      output: 'arg:value',
    })
    await expect(manager.invoke(workspace, 'missing.command')).resolves.toMatchObject({
      success: false,
    })
  })

  it('surfaces command errors', async () => {
    await writePlugin(
      'demo',
      `module.exports = {
        activate(api) {
          api.registerCommand('demo.run', () => { throw new Error('boom') })
        },
      }`
    )
    manager = createManager()
    manager.loadWorkspace(workspace)

    await expect(manager.invoke(workspace, 'demo.run')).resolves.toEqual({
      success: false,
      error: 'boom',
    })
  })

  it('dispatches hooks and isolates hook failures', async () => {
    await writePlugin(
      'hooks',
      `module.exports = {
        activate(api) {
          api.on('file:saved', (payload) => { globalThis.__pluginHook = payload.path })
          api.on('file:saved', () => { throw new Error('hook boom') })
        },
      }`
    )
    manager = createManager()
    manager.loadWorkspace(workspace)

    await manager.emit(workspace, 'file:saved', { path: '/tmp/a.ts' })

    expect((globalThis as Record<string, unknown>).__pluginHook).toBe('/tmp/a.ts')
  })

  it('records invalid manifests without breaking other plugins', async () => {
    const badDirectory = path.join(workspace, '.pi-workbench', 'plugins', 'bad')
    await fs.mkdir(badDirectory, { recursive: true })
    await fs.writeFile(path.join(badDirectory, 'plugin.json'), '{ not json', 'utf-8')

    await writePlugin(
      'good',
      `module.exports = { activate(api) { api.registerCommand('good.run', () => ({ success: true })) } }`
    )

    manager = createManager()
    const plugins = manager.loadWorkspace(workspace)

    expect(plugins).toHaveLength(2)
    const bad = plugins.find((plugin) => plugin.id === 'bad')
    expect(bad?.error).toContain('Invalid plugin.json')
  })

  it('rejects plugin entry points outside the plugin directory', async () => {
    await writePlugin(
      'escape',
      `module.exports = { activate() {} }`,
      { main: '../outside.js' }
    )

    manager = createManager()
    const plugins = manager.loadWorkspace(workspace)

    expect(plugins[0].error).toContain('inside its own directory')
  })

  it('ignores untrusted enabledPlugins in repository .pi-workbench/config.json', async () => {
    ;(globalThis as Record<string, unknown>).__pluginActivated = false
    await writePlugin(
      'evil',
      `module.exports = { activate() { globalThis.__pluginActivated = true } }`,
      {},
      { enabled: false }
    )
    await fs.writeFile(
      path.join(workspace, '.pi-workbench', 'config.json'),
      JSON.stringify({ enabledPlugins: ['evil'], pluginsConfigured: true }),
      'utf-8'
    )

    manager = createManager()
    const plugins = manager.loadWorkspace(workspace)

    expect(plugins[0].enabled).toBe(false)
    expect((globalThis as Record<string, unknown>).__pluginActivated).toBe(false)
    expect(manager.hasExplicitEnableList(workspace)).toBe(false)
  })

  it('respects explicit enabled plugin lists stored in app-owned config', async () => {
    await writePlugin(
      'demo',
      `module.exports = { activate(api) { api.registerCommand('demo.run', () => ({ success: true })) } }`,
      {},
      { enabled: false }
    )

    manager = createManager()
    let plugins = manager.loadWorkspace(workspace)

    expect(plugins[0].enabled).toBe(false)
    expect(plugins[0].commands).toEqual([])
    await expect(manager.invoke(workspace, 'demo.run')).resolves.toMatchObject({ success: false })

    plugins = manager.setEnabled(workspace, 'demo', true)
    expect(plugins[0].enabled).toBe(true)
    expect(manager.hasExplicitEnableList(workspace)).toBe(true)

    const stored = JSON.parse(await fs.readFile(stateFilePath, 'utf-8')) as {
      workspaces: Record<string, { enabledPlugins: string[] }>
    }
    expect(Object.values(stored.workspaces)[0]?.enabledPlugins).toEqual(['demo'])
  })

  it('rejects duplicate plugin ids without breaking the first plugin', async () => {
    const source = `module.exports = {
      activate(api) {
        api.registerCommand('shared.run', () => ({ success: true, output: 'ok' }))
      },
    }`

    await writePlugin('first', source, { id: 'shared' })
    await writePlugin('second', source, { id: 'shared' })

    manager = createManager()
    const plugins = manager.loadWorkspace(workspace)

    const shared = plugins.filter((plugin) => plugin.id === 'shared')
    expect(shared).toHaveLength(2)
    expect(shared[0].enabled).toBe(true)
    expect(shared[0].error).toBeUndefined()
    expect(shared[1].enabled).toBe(false)
    expect(shared[1].error).toContain('Duplicate plugin id')

    await expect(manager.invoke(workspace, 'shared.run')).resolves.toMatchObject({
      success: true,
      output: 'ok',
    })
  })

  it('reloads changed plugin code', async () => {
    await writePlugin(
      'demo',
      `module.exports = { activate(api) { api.registerCommand('demo.run', () => ({ success: true, output: 'v1' })) } }`
    )
    manager = createManager()
    manager.loadWorkspace(workspace)

    await expect(manager.invoke(workspace, 'demo.run')).resolves.toMatchObject({ output: 'v1' })

    await writePlugin(
      'demo',
      `module.exports = { activate(api) { api.registerCommand('demo.run', () => ({ success: true, output: 'v2' })) } }`
    )
    manager.reload(workspace)

    await expect(manager.invoke(workspace, 'demo.run')).resolves.toMatchObject({ output: 'v2' })
  })

  it('calls deactivate when unloading', async () => {
    await writePlugin(
      'demo',
      `module.exports = {
        activate(api) { api.registerCommand('demo.run', () => ({ success: true })) },
        deactivate() { globalThis.__pluginDeactivated = true },
      }`
    )
    manager = createManager()
    manager.loadWorkspace(workspace)

    manager.disposeAll()

    expect((globalThis as Record<string, unknown>).__pluginDeactivated).toBe(true)
    expect(manager.loadedWorkspaces()).toEqual([])
  })
})
