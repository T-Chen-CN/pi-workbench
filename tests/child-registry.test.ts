import { describe, expect, it, vi } from 'vitest'
import { ChildRegistry, childRegistry, killProcessTree } from '../electron/child-registry'

describe('killProcessTree', () => {
  it('Windows 上用 taskkill /T /F 收整棵进程树', () => {
    const execFileSync = vi.fn()
    expect(killProcessTree(4321, { platform: 'win32', execFileSync })).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4321', '/T', '/F'],
      expect.objectContaining({ windowsHide: true, stdio: 'ignore' })
    )
  })

  it('taskkill 失败时返回 false 而不抛错', () => {
    const execFileSync = vi.fn(() => {
      throw new Error('not found')
    })
    expect(killProcessTree(4321, { platform: 'win32', execFileSync })).toBe(false)
  })

  it('非 Windows 平台直接 SIGKILL', () => {
    const kill = vi.fn()
    expect(killProcessTree(4321, { platform: 'linux', kill })).toBe(true)
    expect(kill).toHaveBeenCalledWith(4321, 'SIGKILL')
  })

  it('非法 pid 不做任何事', () => {
    const kill = vi.fn()
    expect(killProcessTree(0, { platform: 'linux', kill })).toBe(false)
    expect(killProcessTree(Number.NaN, { platform: 'linux', kill })).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })
})

describe('ChildRegistry', () => {
  it('登记与注销', () => {
    const registry = new ChildRegistry()
    const unregister = registry.register({ pid: 11, group: 'pty' })
    registry.register({ pid: 12, group: 'install' })

    expect(registry.size()).toBe(2)
    expect(registry.list().map((child) => child.pid)).toEqual([11, 12])

    unregister()
    unregister() // 重复注销是空操作
    expect(registry.size()).toBe(1)
  })

  it('killAll 先优雅终止再收进程树，并清空登记表', () => {
    const registry = new ChildRegistry()
    const graceful = vi.fn()
    registry.register({ pid: 21, group: 'pty', kill: graceful })
    registry.register({ pid: 22, group: 'install' })

    const execFileSync = vi.fn()
    const result = registry.killAll({ platform: 'win32', execFileSync })

    expect(graceful).toHaveBeenCalledTimes(1)
    expect(execFileSync).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ killed: 2, failed: 0 })
    expect(registry.size()).toBe(0)
  })

  it('单个进程终止失败不影响其它进程，并计入失败数', () => {
    const registry = new ChildRegistry()
    registry.register({ pid: 31, group: 'pty' })
    registry.register({ pid: 32, group: 'pty' })

    const execFileSync = vi.fn((_file: string, args: string[]) => {
      if (args[1] === '31') throw new Error('access denied')
    })
    expect(registry.killAll({ platform: 'win32', execFileSync })).toEqual({ killed: 1, failed: 1 })
    expect(registry.size()).toBe(0)
  })
})

describe('childRegistry 单例', () => {
  it('是一个共享实例', () => {
    expect(childRegistry).toBeInstanceOf(ChildRegistry)
  })
})
