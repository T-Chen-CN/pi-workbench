import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  createReadWithDocumentsDefinition,
  isDocumentPath,
  type DocumentReadHook,
} from '../pi-bridge/src/read-with-documents'
import {
  createReadToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { buildPdf } from './documents-fixtures'

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pi-read-'))
}

/** 直接调用工具定义，模拟 Agent 的调用方式 */
async function runTool(
  definition: ReturnType<typeof createReadWithDocumentsDefinition>,
  cwd: string,
  args: Record<string, unknown>
) {
  return definition.execute('call-1', args as never, undefined, undefined, { cwd } as never)
}

describe('isDocumentPath', () => {
  it('识别文档扩展名（大小写不敏感）', () => {
    expect(isDocumentPath('C:/a/报告.PDF')).toBe(true)
    expect(isDocumentPath('a.docx')).toBe(true)
    expect(isDocumentPath('a.xlsx')).toBe(true)
    expect(isDocumentPath('a.pptx')).toBe(true)
    expect(isDocumentPath('a.odt')).toBe(true)
    expect(isDocumentPath('a.epub')).toBe(true)
    expect(isDocumentPath('a.doc')).toBe(true)
  })

  it('普通源码 / 无扩展名 / 点开头文件不当文档', () => {
    expect(isDocumentPath('a.ts')).toBe(false)
    expect(isDocumentPath('Makefile')).toBe(false)
    expect(isDocumentPath('.gitignore')).toBe(false)
  })
})

describe('createReadWithDocumentsDefinition', () => {
  it('未注入 readDocument 时就是内置定义本身', () => {
    const builtin = createReadToolDefinition(process.cwd())
    const definition = createReadWithDocumentsDefinition({ cwd: process.cwd() })
    expect(definition.name).toBe(builtin.name)
    expect(definition.description).toBe(builtin.description)
  })

  it('注册名仍然是 read（覆盖内置，而不是新增工具）', () => {
    const definition = createReadWithDocumentsDefinition({
      cwd: process.cwd(),
      readDocument: async () => null,
    })
    expect(definition.name).toBe('read')
    expect(definition.label).toBe('read')
  })

  it('参数表在内置基础上追加 pages / sheet / slide，required 仍是 path', () => {
    const definition = createReadWithDocumentsDefinition({
      cwd: process.cwd(),
      readDocument: async () => null,
    })
    const schema = definition.parameters as {
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(Object.keys(schema.properties).sort()).toEqual([
      'limit',
      'offset',
      'pages',
      'path',
      'sheet',
      'slide',
    ])
    expect(schema.required).toEqual(['path'])
  })

  it('普通文本文件不经过文档回调，委托内置 read（行号与截断一致）', async () => {
    const dir = await tempDir()
    const target = path.join(dir, 'notes.ts')
    await fs.writeFile(target, 'const a = 1\nconst b = 2\n')
    const hook = vi.fn<DocumentReadHook>(async () => null)
    const definition = createReadWithDocumentsDefinition({ cwd: dir, readDocument: hook })

    const result = await runTool(definition, dir, { path: target })
    expect(hook).not.toHaveBeenCalled()
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect((result.content[0] as { text: string }).text).toContain('const a = 1')
  })

  it('文档路径回调主进程，返回文本 + 图片', async () => {
    const dir = await tempDir()
    const target = path.join(dir, '扫描件.pdf')
    await fs.writeFile(target, buildPdf())
    const hook = vi.fn<DocumentReadHook>(async (request) => {
      expect(request.path).toBe(target)
      expect(request.pages).toBe('1-2')
      return {
        text: '--- page 1 ---\n你好',
        images: [{ data: 'AAA', mimeType: 'image/png' }],
        format: 'pdf',
      }
    })
    const definition = createReadWithDocumentsDefinition({ cwd: dir, readDocument: hook })

    const result = await runTool(definition, dir, { path: target, pages: '1-2' })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(result.content[1]).toMatchObject({ type: 'image', data: 'AAA', mimeType: 'image/png' })
    expect(result.structuredContent).toMatchObject({ type: 'image', data: 'AAA' })
  })

  it('相对路径按会话 cwd 解析', async () => {
    const dir = await tempDir()
    const target = path.join(dir, 'sub', 'a.docx')
    await fs.mkdir(path.dirname(target))
    await fs.writeFile(target, 'x')
    const hook = vi.fn<DocumentReadHook>(async () => ({ text: 'doc', images: [] }))
    const definition = createReadWithDocumentsDefinition({ cwd: dir, readDocument: hook })
    await runTool(definition, dir, { path: 'sub/a.docx' })
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ path: target }))
  })

  it('回调返回 null 时交回内置 read（扩展名像文档但内容是文本）', async () => {
    const dir = await tempDir()
    const target = path.join(dir, 'fake.pdf')
    await fs.writeFile(target, 'actually plain text\n')
    const definition = createReadWithDocumentsDefinition({
      cwd: dir,
      readDocument: async () => null,
    })
    const result = await runTool(definition, dir, { path: target })
    expect((result.content[0] as { text: string }).text).toContain('actually plain text')
  })

  it('旧格式 / 加密等拒绝结果标记为 isError，模型能看到原因', async () => {
    const dir = await tempDir()
    const target = path.join(dir, '老文档.doc')
    await fs.writeFile(target, 'x')
    const definition = createReadWithDocumentsDefinition({
      cwd: dir,
      readDocument: async () => ({ text: '这是 Word 97-2003 文档，请另存为 .docx', images: [], rejected: true }),
    })
    const result = await runTool(definition, dir, { path: target })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('另存为 .docx')
  })

  it('超长文档按内置上限截断并给出收窄提示', async () => {
    const dir = await tempDir()
    const target = path.join(dir, 'long.docx')
    await fs.writeFile(target, 'x')
    const long = Array.from({ length: 5000 }, (_, index) => `line ${index}`).join('\n')
    const definition = createReadWithDocumentsDefinition({
      cwd: dir,
      readDocument: async () => ({ text: long, images: [] }),
    })
    const result = await runTool(definition, dir, { path: target })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Document truncated')
    expect(text).toContain('pages="1-20"')
    expect((result.details as { truncation?: unknown }).truncation).toBeTruthy()
  })

  it('回调抛错时把信息带给模型', async () => {
    const dir = await tempDir()
    const target = path.join(dir, 'bad.docx')
    await fs.writeFile(target, 'x')
    const definition = createReadWithDocumentsDefinition({
      cwd: dir,
      readDocument: async () => {
        throw new Error('容器损坏')
      },
    })
    await expect(runTool(definition, dir, { path: target })).rejects.toThrow(/容器损坏/)
  })
})
