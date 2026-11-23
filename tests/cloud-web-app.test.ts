/**
 * Web 客户端的界面回归（jsdom + 打桩 fetch / WebSocket）。
 *
 * 目前钉住三条真实事故：
 * 1. 点「生成配对码」当场就要显示，不能等切页面 —— 根因是 renderAside() 去
 *    querySelector('aside') 却没这个元素、而且没有返回值，整个右栏根本没渲染。
 * 2. 拉模型不能抹掉输入框里的 Key / URL（值必须存 state.configDraft）。
 * 3. 会话流式帧到达时重渲染，聊天草稿与配置输入都要保留。
 */

// @vitest-environment jsdom

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type Route = (body: unknown) => unknown

const PAIR_CODE = '123456'
const routes: Record<string, Route> = {}

function jsonResult(payload: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => payload } as unknown as Response
}

const fetchMock = vi.fn(async (input: any, init?: any) => {
  const path = String(typeof input === 'string' ? input : input.url)
  const key = `${init?.method ?? 'GET'} ${path}`
  const handler = routes[key]
  if (!handler) return jsonResult({ error: `no stub for ${key}` }, false, 404)
  return handler(JSON.parse(String(init?.body ?? 'null')))
})

class FakeSocket {
  static instances: FakeSocket[] = []
  listeners: Record<string, Array<(event: any) => void>> = {}
  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }
  addEventListener(type: string, callback: (event: any) => void) {
    this.listeners[type] = [...(this.listeners[type] ?? []), callback]
  }
  emit(type: string, event: any = {}) {
    for (const callback of this.listeners[type] ?? []) callback(event)
  }
  sent: string[] = []
  close() {}
  send(data: any) {
    this.sent.push(String(data))
  }
}

let buttonByText: (text: string) => HTMLElement
let tick: (ms?: number) => Promise<void>

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>'
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket)

  routes['GET /v1/me'] = () => jsonResult({ hasAccount: true, authenticated: true })
  routes['GET /v1/devices'] = () => jsonResult({ devices: [] })
  routes['GET /v1/authorizations'] = () => jsonResult({ authorizations: [] })
  routes['GET /v1/cloud-config'] = () => jsonResult({ configured: false })
  routes['POST /v1/pair/code'] = () => jsonResult({ code: PAIR_CODE, expiresAt: Date.now() + 300_000 })
  routes['POST /v1/cloud-config/models'] = () =>
    jsonResult({ models: ['model-a', 'model-b'], provider: 'custom', apiUrl: 'https://x/v1' })

  // Web 客户端是零构建的 .js，没有类型声明，用相对路径让 vite 直接转译
  // @ts-expect-error 该模块是纯 JS（无 .d.ts）
  await import('../apps/cloud/web/app.js')
  await new Promise((resolve) => setTimeout(resolve, 30))

  buttonByText = (text: string) => {
    const found = [...document.querySelectorAll('button')].find((node) =>
      (node.textContent ?? '').includes(text)
    )
    if (!found) throw new Error(`button not found: ${text}`)
    return found as HTMLElement
  }
  tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('Web 客户端主界面', () => {
  it('登录后进入主界面，右栏（工单/设备/授权/提示）真的渲染出来', () => {
    const aside = document.querySelector('aside')
    expect(aside).not.toBeNull()
    expect(aside?.textContent).toContain('设备')
    expect(aside?.textContent).toContain('已确认的授权')
  })

  it('点「生成配对码」当场显示，不需要切页面', async () => {
    buttonByText('设备').click()
    await tick()
    expect(document.body.textContent).not.toContain(PAIR_CODE)

    buttonByText('生成配对码').click()
    await tick(50)
    expect(document.body.textContent).toContain(PAIR_CODE)
    expect(document.body.textContent).toContain('在桌面端')
  })

  it('拉模型后输入框里的值仍在（Key / URL 不被重渲染抹掉）', async () => {
    buttonByText('设置').click()
    await tick()
    const inputs = [...document.querySelectorAll('input')] as HTMLInputElement[]
    const url = inputs.find((node) => node.placeholder.includes('api.example.com'))
    const key = inputs.find((node) => node.type === 'password')
    expect(url).toBeTruthy()
    expect(key).toBeTruthy()

    url!.value = 'https://provider.test/v1'
    url!.dispatchEvent(new Event('input'))
    key!.value = 'sk-typed-in-test'
    key!.dispatchEvent(new Event('input'))

    buttonByText('获取可用模型').click()
    await tick(50)

    const after = [...document.querySelectorAll('input')] as HTMLInputElement[]
    expect(after.find((node) => node.placeholder.includes('api.example.com'))?.value).toBe(
      'https://provider.test/v1'
    )
    expect(after.find((node) => node.type === 'password')?.value).toBe('sk-typed-in-test')
    expect(document.body.textContent).toContain('model-a')
  })

  it('首连不带 lastAckSeq：带 0 会让服务端走续传，历史就没了', async () => {
    buttonByText('会话').click()
    await tick()
    const url = new URL(FakeSocket.instances[0].url)
    expect(url.pathname).toBe('/client/ws')
    expect(url.searchParams.has('lastAckSeq')).toBe(false)
  })

  it('发出去的消息立刻以用户气泡出现（服务端 message_start/message_end 回显）', async () => {
    buttonByText('会话').click()
    await tick()
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = '帮我看看仓库结构'
    textarea.dispatchEvent(new Event('input'))
    buttonByText('发送').click()
    await tick(30)

    const socket = FakeSocket.instances[0]
    const sent = JSON.parse(String((socket as any).sent?.[0] ?? 'null'))
    expect(sent?.type).toBe('say')

    // 服务端按 clientMessageId 回显这一对帧
    const messageId = `u-${sent.clientMessageId}`
    socket.emit('message', {
      data: JSON.stringify({ v: 1, type: 'event', seq: 2, event: { type: 'message_start', messageId, role: 'user', at: Date.now() } }),
    })
    socket.emit('message', {
      data: JSON.stringify({ v: 1, type: 'event', seq: 3, event: { type: 'message_end', messageId, text: '帮我看看仓库结构', at: Date.now() } }),
    })
    await tick(30)
    expect(document.body.textContent).toContain('帮我看看仓库结构')
  })

  it('流式帧到达触发重渲染时，聊天草稿与配置输入都保留', async () => {
    buttonByText('会话').click()
    await tick()
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'half-typed message'
    textarea.dispatchEvent(new Event('input'))

    // 一帧 event 推下来 → render() 全页重建
    FakeSocket.instances[0]?.emit('message', {
      data: JSON.stringify({
        v: 1,
        type: 'event',
        seq: 1,
        event: { type: 'message', message: { id: 'm1', role: 'assistant', text: 'hi', status: 'streaming' } },
      }),
    })
    await tick(30)

    const nextTextarea = document.querySelector('textarea') as HTMLTextAreaElement
    expect(nextTextarea.value).toBe('half-typed message')

    buttonByText('设置').click()
    await tick()
    const after = [...document.querySelectorAll('input')] as HTMLInputElement[]
    expect(after.find((node) => node.type === 'password')?.value).toBe('sk-typed-in-test')
  })

  it('登录态过期后不再无限“正在重连”，回登录页并说明原因', async () => {
    // 升级阶段就被 401 拒：浏览器只给 1006，只能靠 /v1/me 反查
    routes['GET /v1/me'] = () => jsonResult({ hasAccount: true, authenticated: false })
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1]
    // 没经过 open 就 close = 握手就被拒
    socket.emit('close')
    await tick(1300)
    expect(document.body.textContent).toContain('登录已过期，请重新登录')
    expect(document.body.textContent).toContain('登录云端控制台')
    expect(document.body.textContent).not.toContain('正在重连')
  })
})
