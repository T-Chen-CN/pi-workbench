import { describe, expect, it } from 'vitest'
import { parseGitRefs } from '../src/utils/gitRefs'

describe('parseGitRefs', () => {
  it('把 HEAD、远端、tag 和普通分支分开', () => {
    const chips = parseGitRefs('HEAD -> main, origin/main, origin/HEAD, tag: v0.5.2, so-far')

    expect(chips).toEqual([
      { kind: 'head', label: 'main', title: 'main（HEAD）' },
      { kind: 'remote', label: 'origin', title: 'origin/main' },
      { kind: 'tag', label: 'v0.5.2', title: 'tag v0.5.2' },
      { kind: 'branch', label: 'so-far', title: 'so-far' },
    ])
  })

  it('同一远端只保留一个徽章', () => {
    const chips = parseGitRefs('origin/main, origin/feature, upstream/main', ['origin', 'upstream'])

    expect(chips.map((chip) => chip.title)).toEqual(['origin/main', 'upstream/main'])
  })

  it('空字符串返回空数组', () => {
    expect(parseGitRefs('')).toEqual([])
  })
})
