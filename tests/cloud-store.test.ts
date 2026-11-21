/** 云端页 store 的帧投影（轻量渲染的数据来源） */

// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

/** 发送只记账，不真的走 IPC；用例只用它拿到本端生成的 clientMessageId */
const sent: Array<{ type: string; clientMessageId?: string }> = []
vi.mock('../src/api', () => ({
  api: {
    cloudClientSend: vi.fn(async (frame: { type: string; clientMessageId?: string }) => {
      sent.push(frame)
      return { success: true }
    }),
  },
}))

import { useCloudStore } from '../src/store/cloudStore'

function reset(): void {
  useCloudStore.setState({
    link: { linked: true },
    messages: [],
    tasks: [],
    devices: [],
    authorizations: [],
    notices: [],
    lastSeq: 0,
    agentStatus: 'idle',
    canStopReply: false,
    units: [],
  })
  sent.length = 0
}

describe('snapshot', () => {
  it('整体替换消息、工单、设备与授权', () => {
    reset()
    useCloudStore.getState().applyFrame({
      v: 1,
      type: 'snapshot',
      seq: 7,
      snapshot: {
        lastSeq: 7,
        cloud: { status: 'idle', canStopReply: false },
        messages: [
          { id: 'm1', role: 'user', text: '你好', at: 1 },
          { id: 'm2', role: 'assistant', text: '在', at: 2 },
        ],
        tasks: [
          {
            id: 'T-1',
            status: 'running',
            createdAt: 10,
            updatedAt: 20,
            spec: {
              workUnitId: 'u1',
              deviceId: 'dev-1',
              repo: { workspacePath: 'E:/repo' },
              title: '构建',
            },
            progress: { step: 1, lastEventAt: 20, summary: '正在跑测试' },
          },
        ],
        devices: [
          {
            id: 'dev-1',
            name: '笔记本',
            platform: 'win32',
            online: true,
            workspaces: [{ path: 'E:/repo', name: 'repo', isGit: true }],
          },
        ],
        authorizations: [
          { id: 'auth-1', items: [], quota: 5, used: 1, confirmedAt: 1, expiresAt: 2, confirmedSummary: 'x' },
        ],
        units: [
          {
            unitId: 'u1',
            deviceId: 'dev-1',
            workspacePath: 'E:/repo',
            worktreePath: 'E:/repo/.pi-workbench/worktrees/wt-1',
            branch: 'pi/wt-1',
            createdAt: 5,
            closedAt: null,
            dirtyAt: 9,
          },
        ],
      },
    })

    const state = useCloudStore.getState()
    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]).toMatchObject({ role: 'user', text: '你好' })
    expect(state.tasks[0]).toMatchObject({ id: 'T-1', title: '构建', status: 'running', lastMilestone: '正在跑测试' })
    expect(state.devices[0]).toMatchObject({ id: 'dev-1', online: true })
    expect(state.authorizations[0].used).toBe(1)
    expect(state.units[0]).toMatchObject({
      unitId: 'u1',
      branch: 'pi/wt-1',
      closedAt: null,
      dirtyAt: 9,
    })
    expect(state.lastSeq).toBe(7)
  })

  it('unit 事件按 unitId 合并，不重复堆行（F-19a）', () => {
    reset()
    const store = useCloudStore.getState()
    const frame = (unit: Record<string, unknown>, seq: number) => ({
      v: 1,
      type: 'event',
      seq,
      event: { type: 'unit', unit },
    })
    store.applyFrame(
      frame(
        { unitId: 'u1', deviceId: 'd', workspacePath: 'E:/repo', createdAt: 1, closedAt: null },
        1
      )
    )
    store.applyFrame(
      frame({ unitId: 'u1', deviceId: 'd', workspacePath: 'E:/repo', createdAt: 1, closedAt: 8 }, 2)
    )
    expect(useCloudStore.getState().units).toHaveLength(1)
    expect(useCloudStore.getState().units[0].closedAt).toBe(8)
  })
})

describe('流式事件', () => {
  it('text_delta 追加到同一条助手消息', () => {
    reset()
    const store = useCloudStore.getState()
    store.applyFrame({ v: 1, type: 'event', seq: 1, event: { type: 'text_delta', delta: '你' } })
    store.applyFrame({ v: 1, type: 'event', seq: 2, event: { type: 'text_delta', delta: '好' } })
    const state = useCloudStore.getState()
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]).toMatchObject({ role: 'assistant', text: '你好', streaming: true })
  })

  it('message_end 收尾并带上错误', () => {
    reset()
    const store = useCloudStore.getState()
    store.applyFrame({ v: 1, type: 'event', seq: 1, event: { type: 'text_delta', delta: '半句' } })
    store.applyFrame({
      v: 1,
      type: 'event',
      seq: 2,
      event: { type: 'message_end', text: '完整一句', error: 'aborted' },
    })
    const state = useCloudStore.getState()
    expect(state.messages[0]).toMatchObject({ text: '完整一句', streaming: false, error: 'aborted' })
  })

  it('trace 投影成可折叠的工具块', () => {
    reset()
    const store = useCloudStore.getState()
    store.applyFrame({
      v: 1,
      type: 'event',
      seq: 1,
      event: { type: 'trace', trace: { type: 'tool_start', toolCallId: 't1', toolName: 'dispatch_task', argsSummary: 'T-1' } },
    })
    store.applyFrame({
      v: 1,
      type: 'event',
      seq: 2,
      event: { type: 'trace', trace: { type: 'tool_end', toolCallId: 't1', toolName: 'dispatch_task', status: 'success', resultPreview: 'ok' } },
    })
    const traces = useCloudStore.getState().messages[0].traces
    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({ toolName: 'dispatch_task', status: 'ok', summary: 'ok' })
  })

  it('task / device 事件按 id 合并而不是重复插入', () => {
    reset()
    const store = useCloudStore.getState()
    const task = (status: string) => ({
      v: 1,
      type: 'event',
      seq: 1,
      event: {
        type: 'task',
        task: {
          id: 'T-1',
          status,
          createdAt: 1,
          updatedAt: 2,
          spec: { workUnitId: 'u1', deviceId: 'dev-1', repo: { workspacePath: 'E:/repo' }, title: '构建' },
          progress: { step: 0, lastEventAt: 2 },
        },
      },
    })
    store.applyFrame(task('queued'))
    store.applyFrame(task('running'))
    expect(useCloudStore.getState().tasks).toHaveLength(1)
    expect(useCloudStore.getState().tasks[0].status).toBe('running')

    const device = (online: boolean) => ({
      v: 1,
      type: 'event',
      seq: 1,
      event: {
        type: 'device',
        device: { id: 'dev-1', name: '笔记本', platform: 'win32', online, workspaces: [] },
      },
    })
    store.applyFrame(device(true))
    store.applyFrame(device(false))
    expect(useCloudStore.getState().devices).toHaveLength(1)
    expect(useCloudStore.getState().devices[0].online).toBe(false)
  })

  it('notice 与 cloud_status 更新指示器', () => {
    reset()
    const store = useCloudStore.getState()
    store.applyFrame({
      v: 1,
      type: 'event',
      seq: 1,
      event: { type: 'cloud_status', status: 'replying' },
    })
    store.applyFrame({
      v: 1,
      type: 'event',
      seq: 2,
      event: { type: 'notice', level: 'warn', text: '终端离线', at: 5, key: 'offline' },
    })
    const state = useCloudStore.getState()
    expect(state.agentStatus).toBe('replying')
    expect(state.canStopReply).toBe(true)
    expect(state.notices[0]).toMatchObject({ level: 'warn', text: '终端离线' })
  })

  it('用户消息：服务端回显按 id 去重，本端乐观追加的不会被画两遍', () => {
    reset()
    // 本端发送时先乐观追加一条（id 与 clientMessageId 一致）
    useCloudStore.setState({
      messages: [{ id: 'c-abc', role: 'user', text: '你好', at: 1, traces: [] }],
    })
    useCloudStore.getState().applyFrame({
      v: 1,
      type: 'event',
      seq: 1,
      event: { type: 'message_start', messageId: 'c-abc', role: 'user', at: 2 },
    })
    useCloudStore.getState().applyFrame({
      v: 1,
      type: 'event',
      seq: 2,
      event: { type: 'message_end', messageId: 'c-abc', text: '你好', at: 3 },
    })
    const messages = useCloudStore.getState().messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'c-abc', role: 'user', text: '你好', streaming: false })
  })

  it('另一端的用户消息也会显示（之前只有 assistant 气泡）', () => {
    reset()
    useCloudStore.getState().applyFrame({
      v: 1,
      type: 'event',
      seq: 1,
      event: { type: 'message_start', messageId: 'u-c-1', role: 'user', at: 1 },
    })
    useCloudStore.getState().applyFrame({
      v: 1,
      type: 'event',
      seq: 2,
      event: { type: 'message_end', messageId: 'u-c-1', text: '在 Web 上说的话', at: 2 },
    })
    const messages = useCloudStore.getState().messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user', text: '在 Web 上说的话' })
  })

  it('协议版本不符的帧被忽略', () => {
    reset()
    useCloudStore.getState().applyFrame({ v: 2, type: 'snapshot', snapshot: { messages: [{ id: 'x' }] } })
    expect(useCloudStore.getState().messages).toHaveLength(0)
  })
})

describe('用户消息回显（多端同一份对话）', () => {
  it('本端乐观追加 + 服务端回显只留一条（不能变成两个 YOU 气泡）', async () => {
    reset()
    const store = useCloudStore.getState()
    await store.say('你列一下你可控的设备和工作区')

    // 本端先乐观追加一条，id 是本端生成的 clientMessageId
    expect(useCloudStore.getState().messages).toHaveLength(1)
    const clientMessageId = sent[0]?.clientMessageId ?? ''
    expect(clientMessageId).toMatch(/^c-/)
    expect(useCloudStore.getState().messages[0]).toMatchObject({ role: 'user', id: clientMessageId })

    // 服务端把这条消息广播回来（id 是 u-<clientMessageId>，两端都靠它渲染气泡）
    const echoId = `u-${clientMessageId}`
    store.applyFrame({
      v: 1,
      type: 'event',
      seq: 1,
      event: { type: 'message_start', messageId: echoId, role: 'user', at: 1 },
    })
    store.applyFrame({
      v: 1,
      type: 'event',
      seq: 2,
      event: { type: 'message_end', messageId: echoId, text: '你列一下你可控的设备和工作区', at: 2 },
    })

    const messages = useCloudStore.getState().messages
    expect(messages).toHaveLength(1)
    // 采纳服务端 id，后续 message_end / 重连快照都能对上
    expect(messages[0]).toMatchObject({
      id: echoId,
      role: 'user',
      text: '你列一下你可控的设备和工作区',
    })
  })

  it('别的端发的消息照常新增（本地没有对应乐观气泡）', () => {
    reset()
    useCloudStore.getState().applyFrame({
      v: 1,
      type: 'event',
      seq: 1,
      event: { type: 'message_start', messageId: 'u-c-from-web', role: 'user', at: 1 },
    })
    useCloudStore.getState().applyFrame({
      v: 1,
      type: 'event',
      seq: 2,
      event: { type: 'message_end', messageId: 'u-c-from-web', text: '来自 Web', at: 2 },
    })
    expect(useCloudStore.getState().messages).toEqual([
      expect.objectContaining({ id: 'u-c-from-web', role: 'user', text: '来自 Web' }),
    ])
  })
})
