/**
 * 云端会话必须把用户消息也广播出去。
 *
 * 事故：`say()` 只开轮次，不发布 user 帧 —— Web 端只有 Agent 的气泡，
 * 换台设备看更是完全看不到用户说了什么。这条用例钉住回显的两帧
 * （`message_start(role:user)` + `message_end(text)`，id 用 clientMessageId）。
 */

// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { CloudSession } from '../apps/cloud/src/agent/cloud-session'

function buildSession(options: { busy: boolean }) {
  const published: any[] = []
  const hub = { publish: (frame: any) => published.push(frame) } as any
  const agent = {
    isSessionBusy: () => options.busy,
    steer: async () => ({ success: true }),
    chat: async () => ({ success: true }),
    subscribeTrace: () => () => {},
  } as any
  const session = new CloudSession({
    agent,
    hub,
    store: { getCloudConfig: () => null } as any,
    dispatcher: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    now: () => 1000,
  })
  // 会话 id 只能通过 open() 拿，这里直接打桩，避免依赖 SDK
  ;(session as unknown as { sessionId: string | null }).sessionId = 'sess-1'
  return { session, published }
}

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('用户消息回显', () => {
  it('空闲轮次：先广播 message_start(user) 再广播 message_end(正文)', async () => {
    const { session, published } = buildSession({ busy: false })
    await session.say('帮我看下仓库结构', 'c-1')
    await flushPromises()

    const start = published.find((frame) => frame.type === 'message_start')
    const end = published.find((frame) => frame.type === 'message_end')
    expect(start).toMatchObject({ type: 'message_start', messageId: 'u-c-1', role: 'user' })
    expect(end).toMatchObject({ type: 'message_end', messageId: 'u-c-1', text: '帮我看下仓库结构' })
    // 顺序：先开头再正文，否则客户端无处落文本
    expect(published.indexOf(start)).toBeLessThan(published.indexOf(end))
  })

  it('轮次进行中（steer 插话）也要回显，否则插话内容对其它端不可见', async () => {
    const { session, published } = buildSession({ busy: true })
    await session.say('顺便看下 README', 'c-2')
    expect(published.find((frame) => frame.type === 'message_end')).toMatchObject({
      messageId: 'u-c-2',
      text: '顺便看下 README',
    })
    expect(published.some((frame) => frame.type === 'notice')).toBe(true)
  })

  it('空消息不广播', async () => {
    const { session, published } = buildSession({ busy: false })
    const result = await session.say('   ', 'c-3')
    expect(result.success).toBe(false)
    expect(published).toHaveLength(0)
  })
})

describe('云端流式合帧与思考过程投影', () => {
  it('高频 thinking_delta + text_delta 合帧发送，工具事件前自动冲刷保持顺序，轮次结束无遗漏', async () => {
    const published: any[] = []
    const hooks: {
      traceListener?: (event: any) => void
      resolveChat?: (value: { success: boolean }) => void
    } = {}

    const session = new CloudSession({
      agent: {
        isSessionBusy: () => false,
        openSession: async () => ({ success: true, session: { id: 'sess-stream' }, history: [] }),
        subscribeTrace: async (_id: string, cb: (event: any) => void) => {
          hooks.traceListener = cb
          return () => {}
        },
        chat: () =>
          new Promise<{ success: boolean }>((resolve) => {
            hooks.resolveChat = resolve
          }),
      } as any,
      hub: { publish: (frame: any) => published.push(frame) } as any,
      store: { getCloudConfig: () => null } as any,
      dispatcher: {} as any,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      now: () => 2000,
      traceFlushMs: 50,
    })

    await session.open()
    await session.say('分析仓库并派活', 'c-stream')

    // 连续推送 80 段 thinking_delta → 工具事件 → 80 段 text_delta
    for (let i = 0; i < 80; i += 1) {
      hooks.traceListener?.({ type: 'thinking_delta', delta: `思${i}` })
    }
    hooks.traceListener?.({ type: 'tool_start', toolCallId: 'tc-1', toolName: 'list_devices', argsSummary: '{}' })
    hooks.traceListener?.({
      type: 'tool_end',
      toolCallId: 'tc-1',
      toolName: 'list_devices',
      status: 'success',
      resultPreview: '1 device',
    })
    for (let i = 0; i < 80; i += 1) {
      hooks.traceListener?.({ type: 'text_delta', delta: `文${i}` })
    }

    // 结束轮次应自动冲刷合帧缓冲
    hooks.resolveChat?.({ success: true })
    await flushPromises()

    const thinkingFrames = published.filter(
      (f) => f.type === 'trace' && f.trace?.type === 'thinking_delta'
    )
    const textFrames = published.filter((f) => f.type === 'text_delta')
    const toolStartIdx = published.findIndex(
      (f) => f.type === 'trace' && f.trace?.type === 'tool_start'
    )
    const firstThinkingIdx = published.findIndex(
      (f) => f.type === 'trace' && f.trace?.type === 'thinking_delta'
    )
    const firstTextIdx = published.findIndex((f) => f.type === 'text_delta')
    const endFrame = published.find(
      (f) => f.type === 'message_end' && f.messageId !== 'u-c-stream'
    )

    // 80 + 80 条高频增量被合并成极少数帧（保护 2000 条 BoundedLog）
    expect(thinkingFrames.length).toBeGreaterThanOrEqual(1)
    expect(thinkingFrames.length).toBeLessThan(10)
    expect(textFrames.length).toBeGreaterThanOrEqual(1)
    expect(textFrames.length).toBeLessThan(10)

    // 拼接后的完整文本一字不丢
    expect(thinkingFrames.map((f) => f.trace.delta).join('')).toBe(
      Array.from({ length: 80 }, (_, i) => `思${i}`).join('')
    )
    expect(textFrames.map((f) => f.delta).join('')).toBe(
      Array.from({ length: 80 }, (_, i) => `文${i}`).join('')
    )
    expect(endFrame?.text).toBe(Array.from({ length: 80 }, (_, i) => `文${i}`).join(''))

    // 顺序边界：thinking 先于 tool_start，tool_start 先于后续 text_delta
    expect(firstThinkingIdx).toBeLessThan(toolStartIdx)
    expect(toolStartIdx).toBeLessThan(firstTextIdx)
  })

  it('history() 将持久化会话中的 thinking 与 tool 轨迹投影到快照消息', async () => {
    const session = new CloudSession({
      agent: {
        isSessionBusy: () => false,
        openSession: async () => ({
          success: true,
          session: { id: 'sess-hist' },
          history: [
            {
              role: 'assistant',
              content: '已经查完设备。',
              timestamp: 3000,
              parts: [
                { type: 'thinking', text: '先查在线设备再决定', durationMs: 1200 },
                {
                  type: 'tool',
                  toolCallId: 'tc-h1',
                  toolName: 'list_devices',
                  argsSummary: '{}',
                  resultPreview: '主力机在线',
                  status: 'success',
                  durationMs: 80,
                },
              ],
            },
          ],
        }),
        subscribeTrace: async () => () => {},
      } as any,
      hub: { publish: () => {} } as any,
      store: { getCloudConfig: () => null } as any,
      dispatcher: {} as any,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      now: () => 3000,
    })

    await session.open()
    const history = await session.history()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      role: 'assistant',
      text: '已经查完设备。',
      thinking: '先查在线设备再决定',
      thinkingDurationMs: 1200,
    })
    expect(history[0].traces).toEqual([
      expect.objectContaining({
        id: 'tc-h1',
        toolName: 'list_devices',
        summary: '主力机在线',
        status: 'ok',
        durationMs: 80,
      }),
    ])
  })
})
