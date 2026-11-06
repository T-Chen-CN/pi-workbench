import { describe, expect, it, vi } from 'vitest'
import {
  collectImagePaths,
  collectMediaPaths,
  isImagePath,
  stripImageDirectives,
  stripMediaTags,
  withImageDirectives,
} from '../src/utils/cloudImages'
// media 模块只依赖 `electron.net`，测试里用桩替掉主进程 can
vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { createMediaClient, extractImagePaths, parseImageDataUrl } from '../electron/cloud/media'
import { net } from 'electron'

describe('图片指令', () => {
  it('collects every /image line and leaves other text alone', () => {
    const text = ['/image /a/one.png', '看图说话', '/image /a/two.jpg'].join('\n')
    expect(collectImagePaths(text)).toEqual(['/a/one.png', '/a/two.jpg'])
    expect(extractImagePaths(text)).toEqual(['/a/one.png', '/a/two.jpg'])
  })

  it('ignores inline mentions that are not their own line', () => {
    expect(collectImagePaths('这个 /image /a/one.png 是行内的')).toEqual([])
  })

  it('strips the directives so the body stays readable', () => {
    const text = ['/image /a/one.png', '', '这两张', '/image /a/two.png'].join('\n')
    expect(stripImageDirectives(text)).toBe('这两张')
    expect(stripImageDirectives('/image /a/one.png')).toBe('')
  })

  it('prepends one directive per attachment', () => {
    expect(withImageDirectives('看图', ['/a/1.png', '/a/2.png'])).toBe(
      ['/image /a/1.png', '/image /a/2.png', '看图'].join('\n')
    )
    expect(withImageDirectives('看图', [])).toBe('看图')
    expect(withImageDirectives('', ['/a/1.png'])).toBe('/image /a/1.png')
  })

})

describe('Agent 的 MEDIA 标签', () => {
  it('collects MEDIA paths that are images', () => {
    const text = ['页面已打开。', '', 'MEDIA:/home/u/.config/browser-harness/tmp/shot.png'].join('\n')
    expect(collectMediaPaths(text)).toEqual(['/home/u/.config/browser-harness/tmp/shot.png'])
  })

  it('also picks up tags that share a line with the caption', () => {
    // Hermes 允许「说明文字 MEDIA:/path」写在一起（`hermes send` 的用法）
    expect(collectMediaPaths('截图已附上 MEDIA:/tmp/a.jpg')).toEqual(['/tmp/a.jpg'])
    expect(collectMediaPaths('[[as_document]] MEDIA:/tmp/a.webp')).toEqual(['/tmp/a.webp'])
  })

  it('skips non-image media and keeps them visible as text', () => {
    const text = ['报告生成了', 'MEDIA:/tmp/report.pdf'].join('\n')
    expect(collectMediaPaths(text)).toEqual([])
    // 非图片标签不该被默默吞掉
    expect(stripMediaTags(text)).toBe(['报告生成了', 'MEDIA:/tmp/report.pdf'].join('\n'))
  })

  it('dedupes repeated paths', () => {
    expect(collectMediaPaths('MEDIA:/tmp/a.png MEDIA:/tmp/a.png')).toEqual(['/tmp/a.png'])
  })

  it('strips image tags so the caption stays readable', () => {
    const text = ['截图已附上', '', 'MEDIA:/tmp/a.png', '', ''].join('\n')
    expect(stripMediaTags(text)).toBe('截图已附上')
    expect(stripMediaTags('MEDIA:/tmp/a.png')).toBe('')
    expect(stripMediaTags('截图 MEDIA:/tmp/a.png')).toBe('截图')
  })

  it('knows which extensions are images', () => {
    expect(isImagePath('/a/b.PNG')).toBe(true)
    expect(isImagePath('/a/b.jpeg?v=2')).toBe(true)
    expect(isImagePath('/a/b.pdf')).toBe(false)
    expect(isImagePath('/a/b')).toBe(false)
  })
})

describe('图片数据校验', () => {
  it('accepts the server whitelist and rejects everything else', () => {
    expect(parseImageDataUrl('data:image/png;base64,AAAA').mimeType).toBe('image/png')
    expect(() => parseImageDataUrl('data:image/svg+xml;base64,AAAA')).toThrow(/不支持/)
    expect(() => parseImageDataUrl('data:image/png,AAAA')).toThrow(/base64/)
    expect(() => parseImageDataUrl('http://example.com/a.png')).toThrow(/格式/)
  })

  it('refuses bodies over the 25MB cap before hitting the network', () => {
    const huge = 'A'.repeat(35 * 1024 * 1024)
    expect(() => parseImageDataUrl(`data:image/png;base64,${huge}`)).toThrow(/25MB/)
  })
})

describe('控制台旁路客户端', () => {
  const fetchMock = net.fetch as unknown as ReturnType<typeof vi.fn>

  it('uploads with a Bearer token and returns the server path', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ ok: true, path: '/srv/img/a.png', name: 'a.png', bytes: 12, mime_type: 'image/png' })
    )
    const client = createMediaClient({ baseUrl: 'https://hub.example.com', credential: 'tk' })
    const image = await client.uploadImage({ dataUrl: 'data:image/png;base64,AAAA', filename: 'a.png' })
    expect(image).toMatchObject({ path: '/srv/img/a.png', mimeType: 'image/png' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://hub.example.com/api/chat/image-upload')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tk' })
  })

  it('reads bytes back as a data URL', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ dataUrl: 'data:image/png;base64,BBBB' }))
    const client = createMediaClient({ baseUrl: 'https://hub.example.com/', credential: 'tk' })
    await expect(client.readImageDataUrl('/srv/img/a.png')).resolves.toBe(
      'data:image/png;base64,BBBB'
    )
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
    // 路径必须编码，否则带空格的路径会打歪
    expect(String(lastCall[0])).toBe(
      'https://hub.example.com/api/fs/read-data-url?path=%2Fsrv%2Fimg%2Fa.png'
    )
  })

  it('explains a rejected token instead of leaking a bare 401', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }))
    const client = createMediaClient({ baseUrl: 'https://hub.example.com', credential: 'bad' })
    await expect(client.uploadImage({ dataUrl: 'data:image/png;base64,AAAA' })).rejects.toThrow(
      /设备凭据无效/
    )
  })

  it('refuses to build a client without a token', () => {
    expect(() => createMediaClient({ baseUrl: 'https://hub.example.com', credential: '' })).toThrow(
      /这台设备还没有配对/
    )
  })
})
