import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { createWorkspaceStore, importRecentWorkspaces } from '../electron/workspace-store'

let tmpRoot = ''

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-store-'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('workspace store', () => {
  it('records opens and orders by most recent', () => {
    const store = createWorkspaceStore(path.join(tmpRoot, 'workspaces.db'))
    store.recordOpen('F:/a', 1000)
    store.recordOpen('F:/b', 2000)
    store.recordOpen('F:/a', 3000)

    expect(store.listRecent()).toEqual(['F:/a', 'F:/b'])
    const records = store.list()
    expect(records[0]).toMatchObject({ path: 'F:/a', openedAt: 3000, openCount: 2 })
    store.close()
  })

  it('respects the recent limit and removal', () => {
    const store = createWorkspaceStore(path.join(tmpRoot, 'workspaces.db'))
    store.recordOpen('F:/a', 1)
    store.recordOpen('F:/b', 2)
    store.recordOpen('F:/c', 3)

    expect(store.listRecent(2)).toEqual(['F:/c', 'F:/b'])
    store.remove('F:/c')
    expect(store.listRecent()).toEqual(['F:/b', 'F:/a'])
    store.close()
  })

  it('persists records across re-open', () => {
    const dbPath = path.join(tmpRoot, 'workspaces.db')
    const first = createWorkspaceStore(dbPath)
    first.recordOpen('F:/a', 1000)
    first.close()

    const second = createWorkspaceStore(dbPath)
    expect(second.listRecent()).toEqual(['F:/a'])
    second.close()
  })

  it('imports a legacy recent list without overwriting an existing database', () => {
    const store = createWorkspaceStore(path.join(tmpRoot, 'workspaces.db'))
    importRecentWorkspaces(store, ['F:/new', 'F:/mid', 'F:/old'], 10_000)
    expect(store.listRecent()).toEqual(['F:/new', 'F:/mid', 'F:/old'])

    store.recordOpen('F:/other', 20_000)
    importRecentWorkspaces(store, ['F:/ignored'], 30_000)
    expect(store.listRecent()).toEqual(['F:/other', 'F:/new', 'F:/mid', 'F:/old'])
    store.close()
  })
})
