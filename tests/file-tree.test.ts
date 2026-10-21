import { describe, expect, it } from 'vitest'
import { flattenVisibleTree, type TreeLike } from '../src/utils/fileTree'

interface Node extends TreeLike {
  name: string
  children?: Node[]
}

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
