import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SORT_OPTIONS,
  flattenVisibleTree,
  isExplorerSortBy,
  sortTreeEntries,
  sortTreeNodes,
  type SortTreeOptions,
  type TreeLike,
} from '../src/utils/fileTree'

interface Node extends TreeLike {
  name: string
  children?: Node[]
}

const entry = (name: string, isDirectory = false) => ({ name, isDirectory })
const names = (items: Array<{ name: string }>) => items.map((item) => item.name)
const options = (patch: Partial<SortTreeOptions> = {}): SortTreeOptions => ({
  ...DEFAULT_SORT_OPTIONS,
  ...patch,
})

describe('flattenVisibleTree', () => {
  const tree: Node[] = [
    {
      name: 'src',
      path: '/src',
      isDirectory: true,
      isExpanded: true,
      children: [
        { name: 'a.ts', path: '/src/a.ts' },
        {
          name: 'nested',
          path: '/src/nested',
          isDirectory: true,
          isExpanded: false,
          children: [{ name: 'hidden.ts', path: '/src/nested/hidden.ts' }],
        },
      ],
    },
    { name: 'README.md', path: '/README.md' },
  ]

  it('flattens expanded directories in pre-order', () => {
    expect(flattenVisibleTree(tree).map((row) => [row.node.name, row.depth])).toEqual([
      ['src', 0],
      ['a.ts', 1],
      ['nested', 1],
      ['README.md', 0],
    ])
  })

  it('skips children of collapsed directories', () => {
    const paths = flattenVisibleTree(tree).map((row) => row.node.path)
    expect(paths).not.toContain('/src/nested/hidden.ts')
  })

  it('returns an empty list for an empty tree', () => {
    expect(flattenVisibleTree([])).toEqual([])
  })
})

describe('sortTreeEntries', () => {
  it('keeps folders first and sorts names naturally', () => {
    const items = [
      entry('plan-check10.txt'),
      entry('AGENTS.md'),
      entry('bin', true),
      entry('plan-check2.txt'),
      entry('.git', true),
      entry('.gitignore'),
      entry('README.md'),
    ]

    expect(names(sortTreeEntries(items))).toEqual([
      '.git',
      'bin',
      '.gitignore',
      'AGENTS.md',
      'plan-check2.txt',
      'plan-check10.txt',
      'README.md',
    ])
  })

  it('compares digit runs by value rather than character by character', () => {
    expect(names(sortTreeEntries([entry('file10.txt'), entry('file2.txt')]))).toEqual([
      'file2.txt',
      'file10.txt',
    ])
  })

  it('orders names that differ only by case deterministically', () => {
    const forward = sortTreeEntries([entry('readme.md'), entry('README.md')])
    const backward = sortTreeEntries([entry('README.md'), entry('readme.md')])

    expect(names(forward)).toEqual(['README.md', 'readme.md'])
    expect(names(backward)).toEqual(['README.md', 'readme.md'])
  })

  it('interleaves files and folders when folders are not pinned', () => {
    const items = [entry('bin', true), entry('.git', true), entry('a.txt')]

    expect(names(sortTreeEntries(items, options({ foldersFirst: false })))).toEqual([
      '.git',
      'a.txt',
      'bin',
    ])
  })

  it('groups files by extension and leaves extensionless files last', () => {
    const items = [
      entry('z.txt'),
      entry('b.md'),
      entry('a.md'),
      entry('README'),
      entry('src', true),
      entry('a10.ts'),
      entry('a2.ts'),
    ]

    expect(names(sortTreeEntries(items, options({ by: 'type' })))).toEqual([
      'src',
      'a.md',
      'b.md',
      'a2.ts',
      'a10.ts',
      'z.txt',
      'README',
    ])
  })

  it('reverses order inside each group without moving folders', () => {
    const items = [entry('a.txt'), entry('b.txt'), entry('dir', true)]

    expect(names(sortTreeEntries(items, options({ reverse: true })))).toEqual([
      'dir',
      'b.txt',
      'a.txt',
    ])
  })

  it('sorts nested children when resorting an already loaded tree', () => {
    const tree: Node[] = [
      {
        name: 'src',
        path: '/src',
        isDirectory: true,
        isExpanded: true,
        children: [
          { name: 'b.ts', path: '/src/b.ts' },
          { name: 'a.ts', path: '/src/a.ts' },
        ],
      },
      { name: 'readme.md', path: '/readme.md' },
    ]

    const sorted = sortTreeNodes(tree, options({ by: 'name' }))

    expect(names(sorted)).toEqual(['src', 'readme.md'])
    expect(names(sorted[0].children ?? [])).toEqual(['a.ts', 'b.ts'])
  })

  it('accepts only known sort keys', () => {
    expect(isExplorerSortBy('name')).toBe(true)
    expect(isExplorerSortBy('type')).toBe(true)
    expect(isExplorerSortBy('modified')).toBe(false)
    expect(isExplorerSortBy(undefined)).toBe(false)
  })
})
