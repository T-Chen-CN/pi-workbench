/**
 * 预加载脚本必须把每个 `cloud:*` 通道都暴露出来。
 *
 * 这条用例是为了防一类"类型绿但运行时炸"的事故：`src/types/electron.d.ts` 声明了
 * `cloudPair`，渲染层就敢调用；preload 没转发的话，表现是
 * `window.electronAPI.cloudPair is not a function`，tsc 与单测都发现不了。
 */

// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import * as path from 'path'

const root = path.resolve(__dirname, '../..')
const preload = readFileSync(path.join(root, 'electron', 'preload.cts'), 'utf-8')
const cloudIpc = readFileSync(path.join(root, 'electron', 'ipc', 'cloud.ts'), 'utf-8')

function channels(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]).sort()
}

describe('preload 与 cloud IPC 通道一一对应', () => {
  it('每个注册的 cloud 通道都在 preload 里转发', () => {
    const registered = channels(cloudIpc, /handleIpc\(\s*'(cloud:[A-Za-z]+)'/g)
    const forwarded = channels(preload, /invoke\(\s*'(cloud:[A-Za-z]+)'/g)
    expect(registered.length).toBeGreaterThan(5)
    expect(registered.filter((name) => !forwarded.includes(name))).toEqual([])
  })

  it('主进程推送的三个 cloud 事件都有订阅入口', () => {
    for (const event of ['cloud:state', 'cloud:client-frame', 'cloud:client-state']) {
      expect(preload.includes(`ipcRenderer.on('${event}'`)).toBe(true)
    }
  })

  it('渲染层类型声明里的 cloud 方法都能在 preload 找到', () => {
    const types = readFileSync(path.join(root, 'src', 'types', 'electron.d.ts'), 'utf-8')
    const declared = [...types.matchAll(/^\s{2}(cloud[A-Za-z]+|onCloud[A-Za-z]+):/gm)].map(
      (match) => match[1]
    )
    expect(declared.length).toBeGreaterThan(10)
    const missing = declared.filter((name) => !new RegExp(`\\b${name}:`).test(preload))
    expect(missing).toEqual([])
  })
})
