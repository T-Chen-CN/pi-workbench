import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { PluginManager } from '../electron/plugin-manager'

let workspace: string
let manager: PluginManager | null = null

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

  // 插件默认禁用：除显式关闭外，测试里把插件写进启用白名单
  if (options.enabled !== false) {
    await enablePlugin(id)
  }
  return directory
}

async function enablePlugin(id: string): Promise<void> {
  const configPath = path.join(workspace, '.pi-workbench', 'config.json')
  let config: { enabledPlugins?: string[] } = {}
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf-8'))
  } catch {
    config = {}
  }
  const enabled = new Set([...(config.enabledPlugins ?? []), id])
  await fs.writeFile(
    configPath,
    JSON.stringify({ ...config, enabledPlugins: [...enabled], pluginsConfigured: true }),
    'utf-8'
  )
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-plugins-test-'))
  await fs.mkdir(path.join(workspace, '.pi-workbench', 'plugins'), { recursive: true })
  ;(globalThis as Record<string, unknown>).__pluginHook = undefined
  ;(globalThis as Record<string, unknown>).__pluginDeactivated = false
})

afterEach(async () => {
  manager?.disposeAll()
  manager = null
  await fs.rm(workspace, { recursive: true, force: true })
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

    manager = new PluginManager({ watch: false })
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

    manager = new PluginManager({ watch: false })
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
    manager = new PluginManager({ watch: false })
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
    manager = new PluginManager({ watch: false })
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
    manager = new PluginManager({ watch: false })
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

    manager = new PluginManager({ watch: false })
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

    manager = new PluginManager({ watch: false })
    const plugins = manager.loadWorkspace(workspace)

    expect(plugins[0].error).toContain('inside its own directory')
  })

  it('respects explicit enabled plugin lists', async () => {
    await writePlugin(
      'demo',
      `module.exports = { activate(api) { api.registerCommand('demo.run', () => ({ success: true })) } }`
    )
    await fs.writeFile(
      path.join(workspace, '.pi-workbench', 'config.json'),
      JSON.stringify({ enabledPlugins: [], pluginsConfigured: true }),
      'utf-8'
    )

    manager = new PluginManager({ watch: false })
    let plugins = manager.loadWorkspace(workspace)

    expect(plugins[0].enabled).toBe(false)
    expect(plugins[0].commands).toEqual([])
    await expect(manager.invoke(workspace, 'demo.run')).resolves.toMatchObject({ success: false })

    plugins = manager.setEnabled(workspace, 'demo', true)
    expect(plugins[0].enabled).toBe(true)

    const config = JSON.parse(
      await fs.readFile(path.join(workspace, '.pi-workbench', 'config.json'), 'utf-8')
    )
    expect(config.pluginsConfigured).toBe(true)
    expect(config.enabledPlugins).toEqual(['demo'])
  })

  it('reloads changed plugin code', async () => {
    await writePlugin(
      'demo',
      `module.exports = { activate(api) { api.registerCommand('demo.run', () => ({ success: true, output: 'v1' })) } }`
    )
    manager = new PluginManager({ watch: false })
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
    manager = new PluginManager({ watch: false })
    manager.loadWorkspace(workspace)

    manager.disposeAll()

    expect((globalThis as Record<string, unknown>).__pluginDeactivated).toBe(true)
    expect(manager.loadedWorkspaces()).toEqual([])
  })
})
