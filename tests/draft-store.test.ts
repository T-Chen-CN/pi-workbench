import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { DraftStore } from '../electron/draft-store'

let dir: string
let store: DraftStore

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-draft-test-'))
  store = new DraftStore(path.join(dir, 'drafts'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('DraftStore', () => {
  it('saves and lists drafts for a workspace', () => {
    store.save('/ws/a', '/ws/a/src/index.ts', 'unsaved content')

    expect(store.list('/ws/a')).toMatchObject([
      { workspace: '/ws/a', path: '/ws/a/src/index.ts', content: 'unsaved content' },
    ])
    expect(store.list('/ws/b')).toEqual([])
  })

  it('keeps one draft per file and removes it on delete', () => {
    store.save('/ws/a', '/ws/a/a.ts', 'first')
    store.save('/ws/a', '/ws/a/a.ts', 'second')

    expect(store.list('/ws/a')).toHaveLength(1)
    expect(store.list('/ws/a')[0].content).toBe('second')

    store.remove('/ws/a', '/ws/a/a.ts')
    expect(store.list('/ws/a')).toEqual([])
  })

  it('clears drafts for one workspace only', () => {
    store.save('/ws/a', '/ws/a/a.ts', 'a')
    store.save('/ws/b', '/ws/b/b.ts', 'b')

    store.clear('/ws/a')

    expect(store.list('/ws/a')).toEqual([])
    expect(store.list('/ws/b')).toHaveLength(1)
  })

  it('recovers a draft from its backup when the primary file is corrupted', async () => {
    store.save('/ws/a', '/ws/a/a.ts', 'recover me')
    const files = await fs.readdir(path.join(dir, 'drafts'))
    const primary = path.join(dir, 'drafts', files[0])
    await fs.copyFile(primary, `${primary}.bak`)
    await fs.writeFile(primary, '{ broken', 'utf-8')

    expect(store.list('/ws/a')).toMatchObject([{ content: 'recover me' }])
  })

  it('does not persist oversized drafts', () => {
    const huge = 'x'.repeat(2_000_010)
    store.save('/ws/a', '/ws/a/huge.txt', huge)

    expect(store.list('/ws/a')).toEqual([])
  })

  it('clears every draft even beyond the list cap', () => {
    for (let index = 0; index < 105; index++) {
      store.save('/ws/a', `/ws/a/file-${index}.ts`, `content-${index}`)
    }
    expect(store.list('/ws/a')).toHaveLength(100)

    store.clear('/ws/a')
    expect(store.list('/ws/a')).toEqual([])
  })
})
