import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
}))

import { readDocumentForAgent } from '../electron/documents/agent-read'
import { buildDocx, buildOle, buildXlsx, paragraph } from './documents-fixtures'

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-read-'))
}

function rowXml(cell: string, value: string): string {
  return `<sheetData><row r="1"><c r="${cell}" t="inlineStr"><is><t>${value}</t></is></c></row></sheetData>`
}

describe('readDocumentForAgent', () => {
  it('纯文本不是文档，交回内置 read', async () => {
    const dir = await tempDir()
    const target = path.join(dir, 'notes.txt')
    await fs.writeFile(target, 'hello')
    expect(await readDocumentForAgent({ path: target })).toBeNull()
  })

  it('docx 走文档管线返回正文', async () => {
    const dir = await tempDir()
    const target = path.join(dir, '报告.docx')
    await fs.writeFile(target, buildDocx(paragraph('年度总结')))
    const result = await readDocumentForAgent({ path: target })
    expect(result?.text).toContain('年度总结')
    expect(result?.format).toBe('docx')
  })

  it('xlsx 支持按表名收窄', async () => {
    const dir = await tempDir()
    const target = path.join(dir, '预算.xlsx')
    await fs.writeFile(
      target,
      buildXlsx({
        sheets: [
          { name: '汇总', xml: rowXml('A1', '第一表') },
          { name: '明细', xml: rowXml('A1', '第二表') },
        ],
      })
    )
    const all = await readDocumentForAgent({ path: target })
    expect(all?.text).toContain('第一表')
    expect(all?.text).toContain('第二表')
    const one = await readDocumentForAgent({ path: target, sheet: '明细' })
    expect(one?.text).toContain('第二表')
    expect(one?.text).not.toContain('第一表')
    expect(one?.text).not.toContain('--- sheet: 汇总')
  })

  it('旧格式给另存为提示并标记为拒绝', async () => {
    const dir = await tempDir()
    const target = path.join(dir, '旧报告.doc')
    await fs.writeFile(target, buildOle('doc'))
    const result = await readDocumentForAgent({ path: target })
    expect(result?.rejected).toBe(true)
    expect(result?.text).toMatch(/docx/i)
  })

  it('文件不存在时返回 null（让内置 read 报标准错误）', async () => {
    const dir = await tempDir()
    expect(await readDocumentForAgent({ path: path.join(dir, 'missing.docx') })).toBeNull()
  })
})
