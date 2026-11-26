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
  // 目录接口带 query，按 pathname 匹配替身
  const clean = path.split('?')[0]
  const key = `${init?.method ?? 'GET'} ${clean}`
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

  routes['GET /v1/me'] = () => jsonResult({ hasAccount: true, authenticated: true, version: '0.11.2' })
  routes['GET /v1/devices'] = () => jsonResult({ devices: [] })
  routes['GET /v1/authorizations'] = () => jsonResult({ authorizations: [] })
  routes['GET /v1/cloud-config'] = () => jsonResult({ configured: false })
  routes['POST /v1/pair/code'] = () => jsonResult({ code: PAIR_CODE, expiresAt: Date.now() + 300_000 })
  routes['GET /v1/memories'] = () =>
    jsonResult({
      memories: [
        {
          id: 'mem-1',
          kind: 'fact',
          content: '旧记忆内容',
          tags: ['initial'],
          source: 'auto',
          pinned: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    })
  routes['GET /v1/cloud-docs'] = () =>
    jsonResult({
      docs: [{ name: 'AGENTS.md', content: '# 规则\n保持简洁', exists: true, updatedAt: Date.now() }],
    })
  routes['GET /v1/dreams'] = () => jsonResult({ dreams: [] })
  routes['PATCH /v1/memories/mem-1'] = (body: any) =>
    jsonResult({
      memory: {
        id: 'mem-1',
        kind: body.kind ?? 'fact',
        content: body.content ?? '旧记忆内容',
        tags: body.tags ?? [],
        source: 'manual',
        pinned: Boolean(body.pinned),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
  routes['GET /v1/cloud-config/catalog'] = () =>
    jsonResult({
      providerId: 'deepseek',
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek Flash',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoning: true,
          vision: true,
        },
        {
          id: 'deepseek-v4-pro',
          name: 'DeepSeek V4 Pro',
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          reasoning: true,
          vision: false,
        },
      ],
    })

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

  it('刷新目录后输入框里的 Key 仍在（不被重渲染抹掉）', async () => {
    buttonByText('设置').click()
    await tick()
    const key = [...document.querySelectorAll('input')].find(
      (node) => node.type === 'password'
    ) as HTMLInputElement
    expect(key).toBeTruthy()

    key.value = 'sk-typed-in-test'
    key.dispatchEvent(new Event('input'))

    buttonByText('刷新目录').click()
    await tick(50)

    const after = [...document.querySelectorAll('input')].find(
      (node) => node.type === 'password'
    ) as HTMLInputElement
    expect(after.value).toBe('sk-typed-in-test')
    // 模型下拉来自 catalog，能力字段直接展示
    expect(document.body.textContent).toContain('DeepSeek Flash')
    expect(document.body.textContent).toContain('上下文 1M')
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
    // 已有目录缓存时切回或 WS 重渲染必须把模型下拉与能力摘要一起重画出来
    expect(document.querySelectorAll('select').length).toBeGreaterThanOrEqual(2)
    expect(document.body.textContent).toContain('DeepSeek Flash')
    expect(document.body.textContent).toContain('上下文 1M')
  })

  it('顶栏带松绿印面与 Paper/Ink 主题切换，底栏显示真实版本号（D-05）', () => {
    expect(document.querySelector('header.top svg.brand-seal')).not.toBeNull()
    expect(document.querySelector('footer.bottom')?.textContent).toContain('v0.11.2')

    const themeBtn = [...document.querySelectorAll('header.top button')].find((node) =>
      ['Paper', 'Ink'].includes((node.textContent ?? '').trim())
    ) as HTMLButtonElement | undefined
    expect(themeBtn).toBeTruthy()
    const before = themeBtn!.textContent?.trim()
    themeBtn!.click()
    const after = themeBtn!.textContent?.trim()
    expect(after).not.toBe(before)
    expect(localStorage.getItem('pi-cloud-theme')).toMatch(/^(light|dark)$/)
    expect(document.documentElement.getAttribute('data-theme')).toBe(
      localStorage.getItem('pi-cloud-theme')
    )
  })

  it('收到 cloud_status / device / unit / notice 实时刷新 DOM，点击停止回复发 stop_reply（F-02 / F-03）', async () => {
    buttonByText('会话').click()
    await tick()
    const socket = FakeSocket.instances[0]
    const beforeSent = socket.sent.length

    socket.emit('message', {
      data: JSON.stringify({ v: 1, type: 'event', seq: 10, event: { type: 'cloud_status', status: 'replying' } }),
    })
    await tick()
    const stopBtn = buttonByText('停止回复') as HTMLButtonElement
    expect(stopBtn.disabled).toBe(false)
    expect(document.querySelector('header.top')?.textContent).toContain('回复中')
    stopBtn.click()
    expect(socket.sent.length).toBe(beforeSent + 1)
    expect(JSON.parse(socket.sent[socket.sent.length - 1])).toMatchObject({ type: 'stop_reply' })

    socket.emit('message', {
      data: JSON.stringify({
        v: 1,
        type: 'event',
        seq: 11,
        event: {
          type: 'device',
          device: { id: 'dev-live', name: '主力机', platform: 'win32', online: true, workspaces: [] },
        },
      }),
    })
    socket.emit('message', {
      data: JSON.stringify({
        v: 1,
        type: 'event',
        seq: 12,
        event: {
          type: 'unit',
          unit: {
            unitId: 'u-live',
            deviceId: 'dev-live',
            workspacePath: '/repo',
            branch: 'pi/feat-live',
            closedAt: null,
          },
        },
      }),
    })
    socket.emit('message', {
      data: JSON.stringify({
        v: 1,
        type: 'event',
        seq: 13,
        event: { type: 'notice', level: 'info', text: '梦境整理已完成' },
      }),
    })
    await tick()

    const asideText = document.querySelector('aside')?.textContent ?? ''
    expect(asideText).toContain('主力机')
    expect(asideText).toContain('pi/feat-live')
    expect(asideText).toContain('梦境整理已完成')
    expect(document.querySelector('header.top')?.textContent).toContain('1/1 台设备在线')
  })

  it('助手回复按安全 DOM Markdown 渲染，且拒绝 javascript: 协议链接（U-01）', async () => {
    buttonByText('会话').click()
    await tick()
    const socket = FakeSocket.instances[0]
    const md = [
      '## 检查结果',
      '包含 **重点** 与 `npm test` 以及 [文档](https://example.com) 和 [危险](javascript:alert(1))',
      '- 第一条',
      '- 第二条',
      '```ts',
      'const ok = true',
      '```',
    ].join('\n')

    socket.emit('message', {
      data: JSON.stringify({
        v: 1,
        type: 'event',
        seq: 20,
        event: { type: 'message_start', messageId: 'm-md', role: 'assistant', at: Date.now() },
      }),
    })
    socket.emit('message', {
      data: JSON.stringify({
        v: 1,
        type: 'event',
        seq: 21,
        event: { type: 'message_end', messageId: 'm-md', text: md, at: Date.now() },
      }),
    })
    await tick()

    const body = document.querySelector('.md-body')
    expect(body).not.toBeNull()
    expect(body?.querySelector('h2')?.textContent).toBe('检查结果')
    expect(body?.querySelector('strong')?.textContent).toBe('重点')
    expect(body?.querySelector('code.md-inline-code')?.textContent).toBe('npm test')
    expect(body?.querySelectorAll('ul li').length).toBe(2)
    expect(body?.querySelector('.md-code-block pre code')?.textContent).toBe('const ok = true')
    expect(body?.querySelector('.md-code-head button')?.textContent).toBe('复制')
    const anchors = [...(body?.querySelectorAll('a') ?? [])]
    expect(anchors.length).toBe(1)
    expect(anchors[0].getAttribute('href')).toBe('https://example.com')
  })

  it('Enter 发送、Shift+Enter 与输入法组合态不误发，并显示快捷键提示（U-02）', async () => {
    buttonByText('会话').click()
    await tick()
    expect(document.querySelector('.composer')?.textContent).toContain('Enter 发送')

    const socket = FakeSocket.instances[0]
    const textarea = document.querySelector('.composer textarea') as HTMLTextAreaElement

    textarea.value = '先换行'
    textarea.dispatchEvent(new Event('input'))
    const beforeShift = socket.sent.length
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    expect(socket.sent.length).toBe(beforeShift)

    // 组合输入中按 Enter 不应发送
    const imeEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    Object.defineProperty(imeEvent, 'isComposing', { value: true })
    textarea.dispatchEvent(imeEvent)
    expect(socket.sent.length).toBe(beforeShift)

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(socket.sent.length).toBe(beforeShift + 1)
    expect(JSON.parse(socket.sent[socket.sent.length - 1])).toMatchObject({ type: 'say', text: '先换行' })
  })

  it('确认方案弹窗使用遮罩并支持 Esc 关闭（D-04）', async () => {
    buttonByText('会话').click()
    await tick()
    buttonByText('确认方案…').click()
    await tick()
    expect(document.querySelector('.modal-backdrop .panel')).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('记忆页编辑 AGENTS.md 时收到 task / read_state 不重建 DOM 不丢焦点，且支持记忆内联编辑（F-04 / U-03）', async () => {
    buttonByText('记忆').click()
    await tick(60)
    const docArea = document.querySelector('textarea') as HTMLTextAreaElement
    expect(docArea).not.toBeNull()
    docArea.focus()
    expect(document.activeElement).toBe(docArea)

    const socket = FakeSocket.instances[0]
    socket.emit('message', {
      data: JSON.stringify({
        v: 1,
        type: 'event',
        seq: 30,
        event: {
          type: 'task',
          task: {
            id: 'T-focus',
            status: 'running',
            spec: { title: '后台跑单', deviceId: 'dev-live', repo: { workspacePath: '/repo' } },
          },
        },
      }),
    })
    socket.emit('message', {
      data: JSON.stringify({
        v: 1,
        type: 'event',
        seq: 31,
        event: { type: 'read_state', lastReadSeq: 30, unreadCount: 1 },
      }),
    })
    await tick()

    // 同一个 textarea 实例仍在文档中且保持焦点
    expect(document.contains(docArea)).toBe(true)
    expect(document.activeElement).toBe(docArea)

    // 内联编辑记忆条目
    buttonByText('编辑').click()
    await tick()
    const editArea = document.querySelector('.mem-edit-box textarea') as HTMLTextAreaElement
    const tagsInput = document.querySelector('.mem-edit-box input') as HTMLInputElement
    expect(editArea).not.toBeNull()
    editArea.value = '更新后的长期规则'
    editArea.dispatchEvent(new Event('input'))
    tagsInput.value = 'arch, cloud'
    tagsInput.dispatchEvent(new Event('input'))

    const saveBtn = document.querySelector('.mem-edit-box button.primary') as HTMLButtonElement
    saveBtn.click()
    await tick(50)

    expect(document.body.textContent).toContain('更新后的长期规则')
    expect(document.body.textContent).toContain('手工')
    expect(document.body.textContent).toContain('arch')
    expect(document.body.textContent).toContain('cloud')
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
