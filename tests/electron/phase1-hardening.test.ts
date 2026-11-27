/**
 * Phase 1 架构优化、前端性能、Cloud SQLite 持久化与共享 cloud-ui 回归测试。
 */

// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { CLOUD_PROTOCOL_VERSION } from 'pi-bridge'
import { applyCloudFrame, INITIAL_CLOUD_SESSION_STATE } from '@pi-workbench/cloud-ui'
import { detectDocument } from '../../electron/documents/detect'
import { readPresentation, readSpreadsheet } from '../../electron/documents/ooxml'
import { ZipArchive } from '../../electron/documents/zip'
import { AutoFetcher } from '../../electron/repo-autofetch'
import { createSystemProxyFetch, parseFirstHttpProxy } from '../../electron/system-proxy'
import { CloudStore } from '../../apps/cloud/src/store/store'
import { TaskDispatcher } from '../../apps/cloud/src/tasks/dispatcher'

/** 构造最小合法 ZIP 缓冲区（STORE / DEFLATE 均可）供 OOXML 单测使用 */
function makeZip(entries: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  const crcTable = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    crcTable[i] = c >>> 0
  }
  const crc32 = (buf: Buffer): number => {
    let crc = 0xffffffff
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }

  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf-8')
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8')
    const compressed = deflateRawSync(raw)
    const crc = crc32(raw)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    locals.push(local, compressed)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)

    offset += local.length + compressed.length
  }

  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(centrals.length, 8)
  eocd.writeUInt16LE(centrals.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralDir, eocd])
}

describe('Phase 1: 文档管线加固（detect / ooxml）', () => {
  it('源码文件含 %PDF- 字面量不会被误判为 PDF，合法 PDF 魔数正常识别', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-phase1-detect-'))
    try {
      const tsFile = path.join(tmp, 'detect.ts')
      await fs.writeFile(tsFile, "const MAGIC = '%PDF-1.7'\nexport function isPdf() { return MAGIC }\n")
      expect((await detectDocument(tsFile)).isDocument).toBe(false)

      const pdfFile = path.join(tmp, 'real.pdf')
      await fs.writeFile(pdfFile, '%PDF-1.7\n%binary\n')
      expect((await detectDocument(pdfFile)).format).toBe('pdf')

      const bomPdf = path.join(tmp, 'bom.pdf')
      await fs.writeFile(bomPdf, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('%PDF-1.4\n')]))
      expect((await detectDocument(bomPdf)).format).toBe('pdf')
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('PPTX readPresentation 支持 includeImages=false 跳过图片解压且记录真实 sourcePath', () => {
    const zipBuf = makeZip({
      'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId10"/></p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId10" Target="slides/slide10.xml"/></Relationships>`,
      'ppt/slides/slide10.xml': `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Reordered Slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      'ppt/slides/_rels/slide10.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/img1.png"/></Relationships>`,
      'ppt/media/img1.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    })
    const zip = ZipArchive.open(zipBuf)
    const fast = readPresentation(zip, { includeImages: false })
    expect(fast.slides).toHaveLength(1)
    expect(fast.slides[0].sourcePath).toBe('ppt/slides/slide10.xml')
    expect(fast.slides[0].lines).toContain('Reordered Slide')
    expect(fast.images).toHaveLength(0)
    expect(fast.imageCount).toBe(1)

    const full = readPresentation(zip, { includeImages: true })
    expect(full.images).toHaveLength(1)
    expect(full.images[0].name).toBe('ppt/media/img1.png')
  })

  it('XLSX 稀疏大坐标工作簿受全局单元格预算约束，不会发生 OOM', () => {
    const zipBuf = makeZip({
      'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c><c r="ZZ1" t="inlineStr"><is><t>far</t></is></c></row></sheetData></worksheet>`,
    })
    const zip = ZipArchive.open(zipBuf)
    const wb = readSpreadsheet(zip)
    expect(wb.sheets[0].rows[0][0]).toBe('ok')
    expect(wb.sheets[0].rows[0].length).toBeLessThanOrEqual(1024)
  })
})

describe('Phase 1: repo-autofetch 与 system-proxy 回归', () => {
  it('AutoFetcher 正确匹配带括号的 Permission denied (publickey) 并进入退避', async () => {
    const fetch = vi.fn(async () => ({ ok: false, stderr: 'git@github.com: Permission denied (publickey).' }))
    const fetcher = new AutoFetcher({
      repoRoot: '/repo',
      fetch,
      minGapMs: 0,
      authBackoffMs: 60_000,
    })
    const outcome = await fetcher.fetchNow({ force: true, interactive: false })
    expect(outcome.success).toBe(false)
    expect(outcome.authFailed).toBe(true)
    // 退避期间 touch() 不会重复拉取
    fetcher.touch()
    expect(fetch).toHaveBeenCalledTimes(1)
    fetcher.dispose()
  })

  it('system-proxy 解析 HTTP/HTTPS 代理并绕过回环地址', async () => {
    expect(parseFirstHttpProxy('DIRECT')).toBeNull()
    expect(parseFirstHttpProxy('SOCKS5 127.0.0.1:1080; PROXY 127.0.0.1:7890')).toEqual({
      host: '127.0.0.1',
      port: 7890,
    })
    expect(parseFirstHttpProxy('HTTPS proxy.corp.local:8443')).toEqual({
      host: 'proxy.corp.local',
      port: 8443,
    })

    const baseFetch = vi.fn(async () => new Response('local'))
    const netFetch = vi.fn(async () => new Response('proxied'))
    const fetchFn = createSystemProxyFetch({
      isEnabled: () => true,
      isAppReady: () => true,
      baseFetch,
      netFetch,
    })

    await fetchFn('http://127.0.0.1:8787/v1/health')
    await fetchFn('http://localhost:5173/index.html')
    await fetchFn('http://[::1]:3000/api')
    expect(baseFetch).toHaveBeenCalledTimes(3)
    expect(netFetch).toHaveBeenCalledTimes(0)

    await fetchFn('https://api.example.com/v1/models')
    expect(netFetch).toHaveBeenCalledTimes(1)
  })
})

describe('Phase 1: CloudStore node:sqlite 自动迁移、单调时间戳与僵尸工单收敛', () => {
  it('旧目录 JSON 与 task-diffs 自动一次性迁移进 cloud.db 且保留原文件', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-phase1-sqlite-'))
    let store: CloudStore | null = null
    let reopened: CloudStore | null = null
    try {
      await fs.writeFile(
        path.join(tmp, 'accounts.json'),
        JSON.stringify({
          account: { passwordHash: 'h', salt: 's', createdAt: 1, updatedAt: 2, sessionVersion: 3 },
        })
      )
      await fs.writeFile(
        path.join(tmp, 'devices.json'),
        JSON.stringify({
          devices: [
            {
              id: 'dev-legacy',
              name: 'Legacy Box',
              platform: 'linux',
              token: { hash: 'th', salt: 'ts' },
              createdAt: 10,
              lastSeenAt: 20,
              workspaces: [],
              revokedAt: null,
            },
          ],
        })
      )
      await fs.writeFile(
        path.join(tmp, 'tasks.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'T-001',
              status: 'done',
              idempotencyKey: 'k-1',
              createdAt: 100,
              dispatchedAt: 101,
              updatedAt: 102,
              spec: {
                workUnitId: 'u-1',
                deviceId: 'dev-legacy',
                repo: { workspacePath: '/repo' },
                title: 'Legacy task',
                background: 'b',
                goal: 'g',
                acceptance: 'a',
                output: { summary: true, changeList: true, testResult: true },
                commit: false,
                authorizationId: 'auth-1',
              },
              progress: { step: 1, lastEventAt: 102, summary: 'done' },
            },
          ],
        })
      )
      await fs.mkdir(path.join(tmp, 'task-diffs'), { recursive: true })
      await fs.writeFile(
        path.join(tmp, 'task-diffs', 'T-001.json'),
        JSON.stringify({ bytes: 18, excerpt: '+migrated diff line' })
      )

      store = await CloudStore.open(tmp)
      expect(store.getAccount()?.sessionVersion).toBe(3)
      expect(store.findDevice('dev-legacy')?.name).toBe('Legacy Box')
      expect(store.findTask('T-001')?.spec.title).toBe('Legacy task')
      expect(await store.loadTaskDiff('T-001')).toEqual({ bytes: 18, excerpt: '+migrated diff line' })

      // 相同毫秒连续保存云端配置，updatedAt 严格单调递增
      const sameTs = 5_000_000
      await store.saveCloudConfig({ providerId: 'deepseek', model: 'm1', credentialCipher: 'c1', updatedAt: sameTs })
      await store.saveCloudConfig({ providerId: 'deepseek', model: 'm2', credentialCipher: 'c2', updatedAt: sameTs })
      expect(store.getCloudConfig()?.updatedAt).toBe(sameTs + 1)

      store.close()
      store = null

      // 重开后数据完整持久，且原 JSON 文件仍保留作备份
      reopened = await CloudStore.open(tmp)
      expect(reopened.findTask('T-001')?.spec.title).toBe('Legacy task')
      expect(reopened.getCloudConfig()?.model).toBe('m2')
      expect(await reopened.loadTaskDiff('T-001')).toEqual({ bytes: 18, excerpt: '+migrated diff line' })
      await expect(fs.access(path.join(tmp, 'tasks.json'))).resolves.toBeUndefined()
    } finally {
      store?.close()
      reopened?.close()
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('服务重启宽限期后，未重连设备的僵尸 running 工单自动取消并释放槽位', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-phase1-zombie-'))
    let store: CloudStore | null = null
    try {
      store = await CloudStore.open(tmp)
      const nowRef = { value: 1_000_000 }
      await store.saveTask({
        id: 'T-ZOMBIE',
        status: 'running',
        idempotencyKey: 'k-z',
        createdAt: 900_000,
        dispatchedAt: 900_100,
        startedAt: 900_200,
        updatedAt: 900_200,
        spec: {
          workUnitId: 'u-z',
          deviceId: 'dev-offline',
          repo: { workspacePath: '/repo' },
          title: 'Stuck after restart',
          background: 'b',
          goal: 'g',
          acceptance: 'a',
          output: { summary: true, changeList: true, testResult: true },
          commit: false,
          authorizationId: 'auth-z',
        },
        progress: { step: 1, lastEventAt: 900_200 },
      })

      const wakes: any[] = []
      const dispatcher = new TaskDispatcher({
        store,
        hub: {
          isDeviceOnline: () => false,
          publish: () => 0,
          sendToDevice: () => false,
          dropDeviceTask: () => undefined,
        } as never,
        wake: (payload) => {
          wakes.push(payload)
        },
        logger: { info: () => undefined, warn: () => undefined },
        offlineRecoveryGraceMs: 60_000,
        now: () => nowRef.value,
      })

      // 宽限期内保留给设备重连机会
      nowRef.value = 1_030_000
      await dispatcher.sweepTimeouts()
      expect(store.findTask('T-ZOMBIE')?.status).toBe('running')

      // 超过 60s 宽限期仍离线 → 自动取消(device-offline)
      nowRef.value = 1_061_000
      await dispatcher.sweepTimeouts()
      expect(store.findTask('T-ZOMBIE')?.status).toBe('cancelled')
      expect(store.findTask('T-ZOMBIE')?.terminalReason).toBe('device-offline')
      expect(wakes.some((item) => item.taskId === 'T-ZOMBIE' && item.kind === 'device-offline')).toBe(true)
    } finally {
      store?.close()
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('Phase 1: @pi-workbench/cloud-ui 共享边界与帧归并契约', () => {
  it('packages/cloud-ui 源码零桌面 store / i18n / Electron 耦合', async () => {
    const dir = path.resolve(__dirname, '../../packages/cloud-ui/src')
    const files = await fs.readdir(dir)
    for (const file of files) {
      if (!/\.(ts|tsx)$/.test(file)) continue
      const content = await fs.readFile(path.join(dir, file), 'utf-8')
      expect(content).not.toMatch(/\bfrom\s+['"]zustand['"]/)
      expect(content).not.toMatch(
        /\bfrom\s+['"][^'"]*(?:i18nStore|translations|panelStore|HostContext|electron)[^'"]*['"]/
      )
    }
  })

  it('applyCloudFrame 统一处理快照游标重置、乐观回显去重与 read_state 防风暴', () => {
    const seeded = {
      ...INITIAL_CLOUD_SESSION_STATE,
      lastSeq: 50,
      messages: [{ id: 'c-1', role: 'user' as const, text: 'hello', at: 1, traces: [] }],
    }
    const echoed = applyCloudFrame(
      seeded,
      {
        v: CLOUD_PROTOCOL_VERSION,
        type: 'event',
        seq: 51,
        event: { type: 'message_start', messageId: 'u-c-1', role: 'user', at: 2 },
      },
      { matchOptimisticUserEcho: true }
    )
    expect(echoed.state.messages).toHaveLength(1)
    expect(echoed.state.messages[0].id).toBe('u-c-1')

    // 服务端重启 seq 归零回快照：lastSeq 必须重置而不是保留 51
    const resetSnap = applyCloudFrame(echoed.state, {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'snapshot',
      seq: 3,
      snapshot: { lastSeq: 3, cloud: { status: 'idle', canStopReply: false }, messages: [] },
    })
    expect(resetSnap.state.lastSeq).toBe(3)

    // read_state unreadCount === 0 时将 lastReadSeq 推进到 frame.seq，杜绝死循环风暴
    const read = applyCloudFrame(resetSnap.state, {
      v: CLOUD_PROTOCOL_VERSION,
      type: 'event',
      seq: 8,
      event: { type: 'read_state', lastReadSeq: 7, unreadCount: 0 },
    })
    expect(read.state.lastReadSeq).toBe(8)
    expect(read.state.unreadCount).toBe(0)
  })
})
