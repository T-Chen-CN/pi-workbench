import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  readJsonAsyncWithBackup,
  readJsonWithBackup,
  writeJsonAtomic,
  writeJsonAtomicAsync,
  writeJsonAtomicSync,
} from '../../electron/atomic-json'

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

  it('keeps a good backup when the primary file is already corrupted', async () => {
    const file = path.join(dir, 'settings.json')
    writeJsonAtomicSync(file, { version: 1 })
    writeJsonAtomicSync(file, { version: 2 })
    await fs.writeFile(file, '{ broken', 'utf-8')

    writeJsonAtomicSync(file, { version: 3 })

    expect(JSON.parse(await fs.readFile(`${file}.bak`, 'utf-8'))).toEqual({ version: 1 })
    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({ version: 3 })
  })

  it('does not leave temporary files behind', async () => {
    const file = path.join(dir, 'settings.json')
    writeJsonAtomicSync(file, { ok: true })

    const entries = await fs.readdir(dir)
    expect(entries).toEqual(['settings.json'])
  })

  it('supports async atomic writes, backup recovery, and backup: false option', async () => {
    const file = path.join(dir, 'async-settings.json')
    await writeJsonAtomic(file, { step: 1 })
    await writeJsonAtomic(file, { step: 2 })
    await fs.writeFile(file, '{ broken', 'utf-8')

    expect(await readJsonAsyncWithBackup(file)).toMatchObject({
      source: 'backup',
      data: { step: 1 },
    })

    const draftFile = path.join(dir, 'draft.json')
    await writeJsonAtomicAsync(draftFile, { text: 'v1' }, { backup: false, fsync: false })
    await writeJsonAtomicAsync(draftFile, { text: 'v2' }, { backup: false, fsync: false })
    expect(await fs.readdir(dir)).not.toContain('draft.json.bak')
    expect(await readJsonAsyncWithBackup(draftFile)).toMatchObject({
      source: 'primary',
      data: { text: 'v2' },
    })
  })
})
