/**
 * 解绑识别（F-08 / A-15）。
 *
 * 事故：服务端在 WS **升级阶段**回 `HTTP/1.1 401`（拿不到 WS 关闭码），客户端只认
 * `1008/4401`，于是解绑后两个通道都无限退避重连，「已被云端移除」永不出现。
 * 这里用真实 http 升级拒绝复现服务端口径：必须识别成终止态、只尝试一次。
 */

// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'http'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

const link = vi.hoisted(() => ({ baseUrl: '', attempts: 0 }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.env.TEMP ?? '/tmp',
  },
}))

vi.mock('../electron/cloud/link-store.js', () => ({
  readCloudLink: () => ({ baseUrl: link.baseUrl, deviceId: 'dev-unauthorized', linked: true }),
  readCloudToken: () => 'token-1',
  readCloudClientToken: () => 'client-token-1',
  touchCloudLink: async () => undefined,
  wsUrl: (baseUrl: string, pathname: string) => `${baseUrl.replace(/^http/, 'ws')}${pathname}`,
}))

const { CloudClientBridge } = await import('../electron/cloud/client-link')
const { DeviceAgent } = await import('../electron/cloud/device-agent')
import type { CloudClientState } from '../electron/cloud/client-link'
import type { DeviceLinkState } from '../electron/cloud/device-agent'

let httpServer: Server
let tmpRoot = ''

function waitFor<T>(probe: () => T | undefined, label: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const value = probe()
      if (value) return resolve(value)
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${label}`))
      setTimeout(tick, 20)
    }
    tick()
  })
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cloud-401-'))
  // 与服务端同口径：升级阶段直接写 401 再断开
  httpServer = createServer()
  httpServer.on('upgrade', (_req, socket) => {
    link.attempts += 1
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const port = (httpServer.address() as { port: number }).port
  link.baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe('解绑后停止重连', () => {
  it('设备通道：401 标记 revoked，等过最短退避也不再重试', async () => {
    link.attempts = 0
    const states: DeviceLinkState[] = []
    const agent = new DeviceAgent({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      dataDir: path.join(tmpRoot, 'cloud-device'),
      getWorkspaces: async () => [],
      getApiConfig: async () => null,
      getCoordinator: async () => null,
      onStateChange: (state) => states.push(state),
    })
    try {
      await agent.start()
      const revoked = await waitFor(() => states.find((state) => state.revoked), 'revoked state')
      expect(revoked.status).toBe('error')
      expect(revoked.revoked).toBe(true)
      // 最短退避 1s：等过它仍然是终止态，而且只尝试过一次
      await new Promise((resolve) => setTimeout(resolve, 1600))
      expect(link.attempts).toBe(1)
      expect(agent.getState().status).toBe('error')
    } finally {
      await agent.stop()
    }
  })

  it('客户端通道：401 标记 revoked，等过最短退避也不再重试', async () => {
    link.attempts = 0
    const states: CloudClientState[] = []
    const bridge = new CloudClientBridge({
      logger: { info: vi.fn(), warn: vi.fn() },
      onFrame: () => undefined,
      onState: (state) => states.push(state),
    })
    try {
      bridge.open()
      const revoked = await waitFor(
        () => states.find((state) => state.status === 'error' && state.revoked),
        'revoked client state'
      )
      expect(revoked.status).toBe('error')
      await new Promise((resolve) => setTimeout(resolve, 1600))
      expect(link.attempts).toBe(1)
      expect(bridge.getState()).toMatchObject({ status: 'error', revoked: true })
    } finally {
      bridge.close()
    }
  })
})
