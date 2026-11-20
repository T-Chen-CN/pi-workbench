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
