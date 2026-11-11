import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  // 设备身份会落 `data/cloud-agent/device.json`：指到临时目录，别写进仓库的 data/
  const dir = `${process.env.TMPDIR ?? process.env.TEMP ?? '/tmp'}/pi-cloud-remote-${process.pid}-${Date.now()}`
  return { fetch: vi.fn(), appDir: dir }
})

vi.mock('electron', () => ({
  net: { fetch: mocks.fetch },
  app: { isPackaged: false, getAppPath: () => mocks.appDir },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { createCloudClient } from '../electron/cloud/client'
import { createRemote, toRunStatus } from '../electron/cloud/remote'

function remote() {
  return createRemote(createCloudClient({ baseUrl: 'https://api.example.com', credential: 'k' }))
}

describe('run 状态映射', () => {
  it('keeps "unknown" distinct instead of pretending it is running', () => {
    expect(toRunStatus('unknown')).toBe('unknown')
    // queued 是真实状态：不能折叠成 started，否则界面会把「排队」显示成「执行中」
    expect(toRunStatus('queued')).toBe('queued')
    expect(toRunStatus('waiting_for_approval')).toBe('waiting_approval')
    // 没见过的新状态仍然按 running 处理（不误判成终态）
    expect(toRunStatus('brand_new_status')).toBe('running')
  })

  it('carries the admission pair so the UI can resolve a lost run', async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({
        run_id: 'run_1',
        status: 'unknown',
        session_id: 's1',
        admission_id: 'adm_1',
        execution_generation: 3,
      })
    )
    await expect(remote().runStatus('run_1')).resolves.toMatchObject({
      status: 'unknown',
      sessionId: 's1',
      admissionId: 'adm_1',
      executionGeneration: 3,
    })
  })
})

describe('resolve-unknown', () => {
  it('sends exactly the two fields the backend accepts', async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ run_id: 'run_1', status: 'cancelled', object: 'hermes.run.receipt' })
    )
    await expect(
      remote().resolveUnknownRun({ runId: 'run_1', admissionId: 'adm_1', executionGeneration: 3 })
    ).resolves.toEqual({ status: 'cancelled', sessionId: null })

    const [url, init] = mocks.fetch.mock.calls[mocks.fetch.mock.calls.length - 1]
    expect(String(url)).toBe('https://api.example.com/v1/runs/run_1/resolve-unknown')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      admission_id: 'adm_1',
      execution_generation: 3,
    })
  })
})

describe('clarify 应答', () => {
  it('posts exactly the three fields the backend accepts', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ status: 'resolved', prompt_id: 'cl_1' }))
    await remote().clarifyRun({
      runId: 'run_9',
      requestId: 'cl_1',
      generation: 3,
      answer: 'production',
    })
    const [url, init] = mocks.fetch.mock.calls[mocks.fetch.mock.calls.length - 1]
    expect(url).toBe('https://api.example.com/v1/runs/run_9/clarify')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      request_id: 'cl_1',
      execution_generation: 3,
      answer: 'production',
    })
  })
})

describe('startRun 的设备归属', () => {
  it('sends author on the body and leaves instructions out', async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ run_id: 'run_1', status: 'started' }, { status: 202 })
    )
    await remote().startRun({ input: 'hi', sessionId: 's1', idempotencyKey: 'key-1' })

    const [url, init] = mocks.fetch.mock.calls[mocks.fetch.mock.calls.length - 1]
    expect(String(url)).toBe('https://api.example.com/v1/runs')
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.input).toBe('hi')
    expect(body.session_id).toBe('s1')
    expect(body.author).toMatchObject({ is_bot: false })
    expect(String(body.author.id)).toMatch(/^pi-workbench\//)
    expect(body.author.name.length).toBeGreaterThan(0)
    // 设备身份刻意不走 prompt：instructions 会变成 ephemeral_system_prompt
    expect(body).not.toHaveProperty('instructions')
    expect((init as RequestInit).headers).toMatchObject({ 'Idempotency-Key': 'key-1' })
  })
})

describe('取历史：尾部而不是第一页', () => {
  /** 一次 fetch 的 URL（尾部逻辑全靠 offset 走位） */
  function fetchedUrls(): string[] {
    return mocks.fetch.mock.calls.map((call) => String(call[0]))
  }

  function messageRow(id: number, timestamp: number, content = `m${id}`) {
    return { id, role: 'assistant' as const, content, timestamp }
  }

  it('stops after one request when the session fits in a single page', async () => {
    mocks.fetch.mockReset()
    mocks.fetch.mockResolvedValueOnce(
      Response.json({
        data: [messageRow(1, 1_700_000_000), messageRow(2, 1_700_000_100)],
        pagination: { limit: 500, offset: 0, returned: 2 },
      })
    )

    const page = await remote().listMessageTail({ sessionId: 's1', limit: 500 })
    expect(page).toMatchObject({ hasMore: false, offset: 0 })
    expect(page.parts.map((part) => part.id)).toEqual(['h:1', 'h:2'])
    // 短会话不该为「问总数」多跑一趟
    expect(fetchedUrls()).toEqual([
      'https://api.example.com/api/sessions/s1/messages?inline_images=false&limit=500&offset=0',
    ])
  })

  it('jumps to the tail when the first page is full', async () => {
    mocks.fetch.mockReset()
    mocks.fetch
      .mockResolvedValueOnce(
        Response.json({
          data: [messageRow(1, 1_700_000_000)],
          pagination: { limit: 500, offset: 0, returned: 500 },
        })
      )
      .mockResolvedValueOnce(Response.json({ session: { id: 's1', message_count: 1200 } }))
      .mockResolvedValueOnce(
        Response.json({
          data: [messageRow(1199, 1_700_009_000), messageRow(1200, 1_700_009_100)],
          pagination: { limit: 500, offset: 700, returned: 2 },
        })
      )

    const page = await remote().listMessageTail({ sessionId: 's1', limit: 500 })
    // 1200 条里最新的一页 = offset 700
    expect(page).toMatchObject({ hasMore: true, offset: 700 })
    expect(page.parts.map((part) => part.id)).toEqual(['h:1199', 'h:1200'])
    expect(fetchedUrls()).toContain(
      'https://api.example.com/api/sessions/s1/messages?inline_images=false&limit=500&offset=700'
    )
  })

  it('falls back to the first page when the count cannot be read', async () => {
    mocks.fetch.mockReset()
    mocks.fetch
      .mockResolvedValueOnce(
        Response.json({
          data: [messageRow(1, 1_700_000_000)],
          pagination: { limit: 500, offset: 0, returned: 500 },
        })
      )
      .mockRejectedValueOnce(new Error('boom'))

    const page = await remote().listMessageTail({ sessionId: 's1', limit: 500 })
    expect(page).toMatchObject({ hasMore: true, offset: 0 })
    expect(page.parts.map((part) => part.id)).toEqual(['h:1'])
  })

  it('falls back to the first page when the tail page is empty', async () => {
    mocks.fetch.mockReset()
    mocks.fetch
      .mockResolvedValueOnce(
        Response.json({
          data: [messageRow(1, 1_700_000_000)],
          pagination: { limit: 500, offset: 0, returned: 500 },
        })
      )
      .mockResolvedValueOnce(Response.json({ session: { id: 's1', message_count: 900 } }))
      .mockResolvedValueOnce(
        Response.json({ data: [], pagination: { limit: 500, offset: 400, returned: 0 } })
      )

    const page = await remote().listMessageTail({ sessionId: 's1', limit: 500 })
    expect(page).toMatchObject({ offset: 0 })
    expect(page.parts.map((part) => part.id)).toEqual(['h:1'])
  })

  it('normalises descending rows so the timeline reads oldest first', async () => {
    mocks.fetch.mockReset()
    mocks.fetch.mockResolvedValueOnce(
      Response.json({
        data: [messageRow(3, 1_700_000_300), messageRow(2, 1_700_000_200)],
        pagination: { limit: 500, offset: 0, returned: 2 },
      })
    )

    const page = await remote().listMessageTail({ sessionId: 's1', limit: 500 })
    expect(page.parts.map((part) => part.id)).toEqual(['h:2', 'h:3'])
  })
})

describe('导出：全量历史', () => {
  it('pages until the last short page instead of stopping at 500', async () => {
    mocks.fetch.mockReset()
    const page = (offset: number, count: number, returned: number) =>
      Response.json({
        data: Array.from({ length: count }, (_, index) => ({
          id: offset + index + 1,
          role: 'assistant',
          content: `m${offset + index + 1}`,
          timestamp: 1_700_000_000 + offset + index,
        })),
        pagination: { limit: 500, offset, returned },
      })
    mocks.fetch
      .mockResolvedValueOnce(page(0, 3, 500))
      .mockResolvedValueOnce(page(500, 2, 120))

    const parts = await remote().listAllMessages({ sessionId: 's1' })
    // 两页拼齐（3 + 2 = 5 行），不是只剩最后一页
    expect(parts.length).toBe(5)
    expect(parts[0].id).toBe('h:1')
    expect(parts[parts.length - 1].id).toBe('h:502')
    const urls = mocks.fetch.mock.calls.map((call) => String(call[0]))
    expect(urls).toContain(
      'https://api.example.com/api/sessions/s1/messages?inline_images=false&limit=500&offset=500'
    )
  })
})

describe('取历史：降序部署', () => {
  it('treats offset 0 as the newest page and does not jump backwards', async () => {
    mocks.fetch.mockReset()
    // 降序部署：offset 0 就是最新 500 条（首 > 尾）
    mocks.fetch.mockResolvedValueOnce(
      Response.json({
        data: [
          { id: 1200, role: 'assistant', content: 'm1200', timestamp: 1_700_000_900 },
          { id: 1199, role: 'assistant', content: 'm1199', timestamp: 1_700_000_800 },
        ],
        pagination: { limit: 500, offset: 0, returned: 500 },
      })
    )

    const page = await remote().listMessageTail({ sessionId: 's1', limit: 500 })
    expect(page).toMatchObject({ hasMore: true, offset: 0 })
    // 翻成升序给界面
    expect(page.parts.map((part) => part.id)).toEqual(['h:1199', 'h:1200'])
    // 不该再去问总数、更不该拿 offset 700 那一页（那是更老的）
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })
})
