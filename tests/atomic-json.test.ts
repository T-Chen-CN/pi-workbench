import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { readJsonWithBackup, writeJsonAtomicSync } from '../electron/atomic-json'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-atomic-json-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('atomic JSON persistence', () => {
  it('writes and reads a JSON file', async () => {
    const file = path.join(dir, 'config', 'settings.json')
    writeJsonAtomicSync(file, { language: 'zh', nested: { value: 1 } })

    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({
      language: 'zh',
      nested: { value: 1 },
    })
    expect(readJsonWithBackup(file)).toMatchObject({
      source: 'primary',
      data: { language: 'zh' },
    })
  })

  it('keeps the previous content as a backup', async () => {
    const file = path.join(dir, 'settings.json')
    writeJsonAtomicSync(file, { version: 1 })
    writeJsonAtomicSync(file, { version: 2 })

    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({ version: 2 })
    expect(JSON.parse(await fs.readFile(`${file}.bak`, 'utf-8'))).toEqual({ version: 1 })
  })

  it('falls back to the backup when the primary file is corrupted', async () => {
    const file = path.join(dir, 'settings.json')
    writeJsonAtomicSync(file, { version: 1 })
    writeJsonAtomicSync(file, { version: 2 })
    await fs.writeFile(file, '{ truncated', 'utf-8')

    expect(readJsonWithBackup(file)).toMatchObject({
      source: 'backup',
      data: { version: 1 },
    })
  })

  it('returns null data when neither file is readable', () => {
    const file = path.join(dir, 'missing.json')
    const result = readJsonWithBackup(file)
    expect(result.data).toBeNull()
    expect(result.source).toBeUndefined()
  })

  it('does not leave temporary files behind', async () => {
    const file = path.join(dir, 'settings.json')
    writeJsonAtomicSync(file, { ok: true })

    const entries = await fs.readdir(dir)
    expect(entries).toEqual(['settings.json'])
  })
})
