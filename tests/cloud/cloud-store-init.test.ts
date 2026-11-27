/**
 * 云端页初始化必须重新打开客户端通道。
 *
 * 事故：重启应用后 `init()` 只刷了配对状态，没开 `/client/ws`，于是拿不到快照，
 * 表现是「历史对话全没了」（其实服务端一直有）。这条用例钉住 init 的行为。
 */

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const openClient = vi.fn(async () => ({
  success: true,
  state: { status: 'open', lastSeq: 12 },
}))
const linkStatus = vi.fn(async () => ({
  success: true,
  link: { linked: true, baseUrl: 'https://cloud.test', deviceId: 'dev-1' },
  state: { status: 'online', pending: 0 },
}))

vi.mock('../../src/api', () => ({
  api: {
    cloudClientOpen: () => openClient(),
    cloudLinkStatus: () => linkStatus(),
    onCloudState: () => () => {},
    onCloudClientState: () => () => {},
    onCloudClientFrame: () => () => {},
  },
}))

const { useCloudStore } = await import('../../src/store/cloudStore')

beforeEach(() => {
  openClient.mockClear()
  useCloudStore.setState({
    link: { linked: false, baseUrl: '', deviceId: '' },
    clientState: { status: 'closed' },
    messages: [],
    initialized: false,
  })
})

describe('云端页初始化', () => {
  it('已配对时 init 会重新打开客户端通道（否则重启后没有快照与历史）', async () => {
    await useCloudStore.getState().init()
    expect(openClient).toHaveBeenCalledTimes(1)
    expect(useCloudStore.getState().clientState).toMatchObject({ status: 'open', lastSeq: 12 })
    expect(useCloudStore.getState().initialized).toBe(true)
  })

  it('未配对时不尝试开通道', async () => {
    linkStatus.mockResolvedValueOnce({
      success: true,
      link: { linked: false, baseUrl: '', deviceId: '' },
      state: { status: 'unlinked', pending: 0 },
    })
    useCloudStore.setState({ link: { linked: false, baseUrl: '', deviceId: '' } })
    await useCloudStore.getState().init()
    expect(openClient).not.toHaveBeenCalled()
  })
})
