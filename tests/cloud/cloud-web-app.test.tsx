/**
 * 云端 Web 控制台（React + Streamdown + CloudTraceSection + StreamingTranscript）界面回归。
 *
 * 覆盖全部既有回归场景并新增：
 * - Streamdown v2 安全渲染（含拒绝 javascript: 协议、残缺流式 Markdown 自愈、KaTeX 公式）
 * - 实时 thinking_delta / tool_start / tool_end 折叠思考过程块
 */

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudWebApp } from '../../apps/cloud/web-src/CloudWebApp'

type Route = (body: unknown) => unknown

const PAIR_CODE = '123456'
let routes: Record<string, Route> = {}

function jsonResult(payload: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => payload } as unknown as Response
}

const fetchMock = vi.fn(async (input: any, init?: any) => {
  const path = String(typeof input === 'string' ? input : input.url)
  const clean = path.split('?')[0]
  const key = `${init?.method ?? 'GET'} ${clean}`
  const handler = routes[key]
  if (!handler) return jsonResult({ error: `no stub for ${key}` }, false, 404)
  return handler(JSON.parse(String(init?.body ?? 'null')))
})

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeSocket[] = []

  readyState = FakeSocket.OPEN
  listeners: Record<string, Array<(event: any) => void>> = {}
  sent: string[] = []

  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }

  addEventListener(type: string, callback: (event: any) => void) {
    this.listeners[type] = [...(this.listeners[type] ?? []), callback]
  }

  emit(type: string, event: any = {}) {
    for (const callback of this.listeners[type] ?? []) callback(event)
  }

  close() {
    this.readyState = FakeSocket.CLOSED
  }

  send(data: any) {
    this.sent.push(String(data))
  }
}

function resetDefaultRoutes(): void {
  routes = {
    'GET /v1/me': () => jsonResult({ hasAccount: true, authenticated: true, version: '0.11.2' }),
    'GET /v1/devices': () => jsonResult({ devices: [] }),
    'GET /v1/authorizations': () => jsonResult({ authorizations: [] }),
    'GET /v1/cloud-config': () => jsonResult({ configured: false }),
    'POST /v1/pair/code': () => jsonResult({ code: PAIR_CODE, expiresAt: Date.now() + 300_000 }),
    'GET /v1/memories': () =>
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
      }),
    'GET /v1/cloud-docs': () =>
      jsonResult({
        docs: [{ name: 'AGENTS.md', content: '# 规则\n保持简洁', exists: true, updatedAt: Date.now() }],
      }),
    'GET /v1/dreams': () => jsonResult({ dreams: [] }),
    'PATCH /v1/memories/mem-1': (body: any) =>
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
      }),
    'GET /v1/cloud-config/catalog': () =>
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
      }),
  }
}

async function mountApp() {
  const result = render(<CloudWebApp />)
  await waitFor(() => {
    expect(document.querySelector('header.top')).not.toBeNull()
    expect(FakeSocket.instances.length).toBeGreaterThan(0)
  })
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1]
  return { ...result, socket }
}

function emitFrame(socket: FakeSocket, frame: Record<string, unknown>) {
  act(() => {
    socket.emit('message', { data: JSON.stringify(frame) })
  })
}

beforeEach(() => {
  FakeSocket.instances = []
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.classList.remove('dark')
  resetDefaultRoutes()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('云端 Web 控制台主界面', () => {
  it('登录后进入主界面，渲染右栏、松绿印面、主题切换与真实版本号（D-05）', async () => {
    await mountApp()

    const aside = document.querySelector('aside')
    expect(aside).not.toBeNull()
    expect(aside?.textContent).toContain('设备')
    expect(aside?.textContent).toContain('已确认的授权')
    expect(document.querySelector('header.top svg.brand-seal')).not.toBeNull()
    expect(document.querySelector('footer.bottom')?.textContent).toContain('v0.11.2')

    const themeBtn = screen.getByRole('button', { name: '切换 Paper / Ink 主题' })
    const before = themeBtn.textContent?.trim()
    fireEvent.click(themeBtn)
    const after = themeBtn.textContent?.trim()
    expect(after).not.toBe(before)
    expect(window.localStorage.getItem('pi-cloud-theme')).toMatch(/^(light|dark)$/)
    expect(document.documentElement.getAttribute('data-theme')).toBe(
      window.localStorage.getItem('pi-cloud-theme')
    )
    expect(document.documentElement.classList.contains('dark')).toBe(
      window.localStorage.getItem('pi-cloud-theme') === 'dark'
    )
  })

  it('首连不带 lastAckSeq，且点「生成配对码」当场显示 6 位码', async () => {
    const { socket } = await mountApp()
    const url = new URL(socket.url)
    expect(url.pathname).toBe('/client/ws')
    expect(url.searchParams.has('lastAckSeq')).toBe(false)

    fireEvent.click(screen.getByRole('tab', { name: '设备' }))
    expect(document.body.textContent).not.toContain(PAIR_CODE)

    fireEvent.click(screen.getByRole('button', { name: '生成配对码' }))
    expect(await screen.findByText(PAIR_CODE)).toBeTruthy()
    expect(document.body.textContent).toContain('在桌面端')
  })

  it('发送消息走 say 回显、Enter 发送 / Shift+Enter 与 IME 不误发，且流式帧到达保留草稿与配置', async () => {
    const { socket } = await mountApp()
    expect(document.querySelector('.composer')?.textContent).toContain('Enter 发送')

    const textarea = document.querySelector('.composer textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '帮我看看仓库结构' } })

    // Shift+Enter 与 IME 组合态不发送
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(socket.sent).toHaveLength(0)

    const imeEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    Object.defineProperty(imeEvent, 'isComposing', { value: true })
    act(() => {
      textarea.dispatchEvent(imeEvent)
    })
    expect(socket.sent).toHaveLength(0)

    // 普通 Enter 发送
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(socket.sent).toHaveLength(1)
    const sent = JSON.parse(socket.sent[0])
    expect(sent).toMatchObject({ type: 'say', text: '帮我看看仓库结构' })

    const messageId = `u-${sent.clientMessageId}`
    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 2,
      event: { type: 'message_start', messageId, role: 'user', at: Date.now() },
    })
    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 3,
      event: { type: 'message_end', messageId, text: '帮我看看仓库结构', at: Date.now() },
    })
    expect(await screen.findByText('帮我看看仓库结构')).toBeTruthy()

    // 在设置页输入 Key 并拉取目录，再切回会话输入草稿并收到流式帧，两者均不丢失
    fireEvent.click(screen.getByRole('tab', { name: '设置' }))
    const keyInput = (await screen.findByLabelText('API Key')) as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'sk-typed-in-test' } })
    fireEvent.click(screen.getByRole('button', { name: '刷新目录' }))
    await waitFor(() => expect(document.body.textContent).toContain('上下文 1M'))
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('sk-typed-in-test')

    fireEvent.click(screen.getByRole('tab', { name: '会话' }))
    const chatBox = document.querySelector('.composer textarea') as HTMLTextAreaElement
    fireEvent.change(chatBox, { target: { value: 'half-typed message' } })
    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 4,
      event: { type: 'message', message: { id: 'm1', role: 'assistant', text: 'hi', status: 'streaming' } },
    })
    expect((document.querySelector('.composer textarea') as HTMLTextAreaElement).value).toBe(
      'half-typed message'
    )

    fireEvent.click(screen.getByRole('tab', { name: '设置' }))
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('sk-typed-in-test')
    expect(document.body.textContent).toContain('DeepSeek Flash')
    expect(document.body.textContent).toContain('上下文 1M')

    // 保存后清空 draft 并保留「已保存，下一轮生效」反馈
    routes['PUT /v1/cloud-config'] = () =>
      jsonResult({ ok: true, apiKeyMasked: 'sk-****9999', takesEffect: 'next-turn' })
    routes['GET /v1/cloud-config'] = () =>
      jsonResult({
        configured: true,
        providerId: 'deepseek',
        model: 'deepseek-flash',
        apiKeyMasked: 'sk-****9999',
      })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('已保存，下一轮生效')).toBeTruthy()
  })

  it('收到 cloud_status / device / unit / notice 实时刷新，点击停止回复发 stop_reply', async () => {
    const { socket } = await mountApp()
    const beforeSent = socket.sent.length

    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 10,
      event: { type: 'cloud_status', status: 'replying' },
    })
    const stopBtn = screen.getByRole('button', { name: '停止回复' }) as HTMLButtonElement
    expect(stopBtn.disabled).toBe(false)
    expect(document.querySelector('header.top')?.textContent).toContain('回复中')

    fireEvent.click(stopBtn)
    expect(socket.sent.length).toBe(beforeSent + 1)
    expect(JSON.parse(socket.sent[socket.sent.length - 1])).toMatchObject({ type: 'stop_reply' })

    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 11,
      event: {
        type: 'device',
        device: { id: 'dev-live', name: '主力机', platform: 'win32', online: true, workspaces: [] },
      },
    })
    emitFrame(socket, {
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
    })
    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 13,
      event: { type: 'notice', level: 'info', text: '梦境整理已完成' },
    })

    const asideText = document.querySelector('aside')?.textContent ?? ''
    expect(asideText).toContain('主力机')
    expect(asideText).toContain('pi/feat-live')
    expect(asideText).toContain('梦境整理已完成')
    expect(document.querySelector('header.top')?.textContent).toContain('1/1 台设备在线')
  })

  it('Streamdown 安全渲染助手 Markdown、公式与残缺流式语法，并拒绝 javascript: 协议', async () => {
    const { socket } = await mountApp()
    const md = [
      '## 检查结果',
      '包含 **重点** 与 `npm test` 与公式 $E=mc^2$ 以及 [文档](https://example.com) 和 [危险](javascript:alert(1))',
      '- 第一条',
      '- 第二条',
      '```ts title="demo.ts"',
      'const ok = true',
      '```',
      '````md',
      '```',
      'nested',
      '```',
      '````',
    ].join('\n')

    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 20,
      event: { type: 'message_start', messageId: 'm-md', role: 'assistant', at: Date.now() },
    })
    // 先推一段未闭合的流式残缺语法，确认不会崩溃或卡死
    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 21,
      event: { type: 'text_delta', messageId: 'm-md', delta: '## \n**未闭合加粗' },
    })
    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 22,
      event: { type: 'message_end', messageId: 'm-md', text: md, at: Date.now() },
    })

    const body = document.querySelector('.chat-markdown')
    expect(body).not.toBeNull()
    expect(body?.querySelector('h2')?.textContent).toBe('检查结果')
    expect(body?.querySelector('strong')?.textContent).toBe('重点')
    expect(body?.textContent).toContain('npm test')
    expect(body?.querySelectorAll('ul li').length).toBe(2)
    expect(body?.textContent).toContain('const ok = true')
    expect(body?.textContent).toContain('nested')
    expect(body?.querySelector('.katex')).not.toBeNull()

    const anchors = [...(body?.querySelectorAll('a') ?? [])]
    expect(anchors.length).toBe(1)
    expect(anchors[0].getAttribute('href')).toBe('https://example.com')
    expect(body?.innerHTML).not.toContain('javascript:')
  })

  it('实时 thinking_delta 与工具轨迹合并到可折叠思考块，并在 message_end 时收敛 streaming', async () => {
    const { socket } = await mountApp()

    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 30,
      event: {
        type: 'trace',
        trace: { type: 'thinking_delta', delta: '先检查目标设备，再派发工单' },
      },
    })
    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 31,
      event: {
        type: 'trace',
        trace: { type: 'tool_start', toolCallId: 'tc-1', toolName: 'dispatch_task', argsSummary: 'run' },
      },
    })
    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 32,
      event: { type: 'message_start', messageId: 'm-after-trace', role: 'assistant', at: Date.now() },
    })
    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 33,
      event: {
        type: 'trace',
        messageId: 'm-after-trace',
        trace: {
          type: 'tool_end',
          toolCallId: 'tc-1',
          toolName: 'dispatch_task',
          status: 'success',
          resultPreview: '已派发',
        },
      },
    })
    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 34,
      event: { type: 'message_end', messageId: 'm-after-trace', text: '工具跑完了', at: Date.now() },
    })

    expect(document.body.textContent).toContain('工具跑完了')
    expect(document.querySelectorAll('.msg-streaming').length).toBe(0)

    const toggle = screen.getByRole('button', { name: /思考/ })
    fireEvent.click(toggle)
    expect(document.body.textContent).toContain('先检查目标设备，再派发工单')
    expect(document.body.textContent).toContain('dispatch_task')
  })

  it('折叠与展开右栏保留输入框实例，确认方案弹窗支持 Esc 关闭，低 seq snapshot 重置游标', async () => {
    const { socket } = await mountApp()

    const textarea = document.querySelector('.composer textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '收起运行态面板' }))
    expect(document.contains(textarea)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '展开运行态面板' }))
    expect(document.contains(textarea)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '确认方案…' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    emitFrame(socket, {
      v: 1,
      type: 'snapshot',
      seq: 1,
      snapshot: {
        lastSeq: 1,
        cloud: { status: 'idle', canStopReply: false },
        messages: [],
        tasks: [],
        devices: [],
        authorizations: [],
        units: [],
      },
    })
    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 2,
      event: { type: 'message_start', messageId: 'm-after-restart', role: 'assistant', at: Date.now() },
    })
    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 3,
      event: { type: 'message_end', messageId: 'm-after-restart', text: '重启后新回复', at: Date.now() },
    })
    expect(document.body.textContent).toContain('重启后新回复')
  })

  it('工单页长 Markdown 报告外层单行预览、展开后按 Streamdown 排版渲染', async () => {
    const { socket } = await mountApp()
    const longReport = '## 项目调研\n\n- **核心**：`InkBoard` 正常\n- 共 16 组测试'

    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 50,
      event: {
        type: 'task',
        task: {
          id: 'T-md-web',
          status: 'done',
          spec: { title: '只读检查项目现状', deviceId: 'dev-1', repo: { workspacePath: 'E:/Projects/画板开发' } },
          progress: { summary: longReport },
          result: { summary: longReport, changedFiles: [] },
        },
      },
    })

    fireEvent.click(screen.getByRole('tab', { name: '工单' }))
    expect(screen.getByText(/项目调研 · 核心：InkBoard 正常/)).toBeTruthy()
    expect(document.getElementById('task-result-T-md-web')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /结果与改动清单/ }))
    const panel = document.getElementById('task-result-T-md-web')
    expect(panel?.querySelector('h2')?.textContent).toBe('项目调研')
    expect(panel?.querySelector('strong')?.textContent).toBe('核心')
  })

  it('记忆页编辑 AGENTS.md 收到 WS 事件不丢焦点，并支持记忆内联编辑', async () => {
    const { socket } = await mountApp()

    fireEvent.click(screen.getByRole('tab', { name: '记忆' }))
    const docArea = (await screen.findByDisplayValue(/保持简洁/)) as HTMLTextAreaElement
    docArea.focus()
    expect(document.activeElement).toBe(docArea)

    emitFrame(socket, {
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
    })
    emitFrame(socket, {
      v: 1,
      type: 'event',
      seq: 31,
      event: { type: 'read_state', lastReadSeq: 30, unreadCount: 1 },
    })
    expect(document.contains(docArea)).toBe(true)
    expect(document.activeElement).toBe(docArea)

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const editBox = document.querySelector('.mem-edit-box')!
    const editArea = editBox.querySelector('textarea') as HTMLTextAreaElement
    const tagsInput = editBox.querySelector('input') as HTMLInputElement
    fireEvent.change(editArea, { target: { value: '更新后的长期规则' } })
    fireEvent.change(tagsInput, { target: { value: 'arch, cloud' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('更新后的长期规则')).toBeTruthy()
    expect(document.body.textContent).toContain('手工')
    expect(document.body.textContent).toContain('arch')
    expect(document.body.textContent).toContain('cloud')
  })

  it('登录态过期后关闭已打开弹窗并回登录页，不再无限重连', async () => {
    const { socket } = await mountApp()
    fireEvent.click(screen.getByRole('button', { name: '确认方案…' }))
    expect(screen.getByRole('dialog')).toBeTruthy()

    routes['GET /v1/me'] = () => jsonResult({ hasAccount: true, authenticated: false })
    act(() => {
      socket.emit('close')
    })

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(document.body.textContent).toContain('登录已过期，请重新登录')
        expect(document.body.textContent).toContain('登录云端控制台')
      },
      { timeout: 2500 }
    )
    expect(document.body.textContent).not.toContain('正在重连')
  })
})
