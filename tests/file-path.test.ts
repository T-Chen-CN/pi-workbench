import { describe, expect, it } from 'vitest'
import { looksLikePath, splitPathLine } from '../src/utils/filePath'

describe('looksLikePath', () => {
  it('accepts relative and absolute file paths with optional line numbers', () => {
    expect(looksLikePath('src/a.ts')).toBe(true)
    expect(looksLikePath('src/components/ChatPanel.tsx:42')).toBe(true)
    expect(looksLikePath('F:/work/a.ts')).toBe(true)
    expect(looksLikePath('a.ts')).toBe(true)
  })

  it('rejects urls, prose and code', () => {
    expect(looksLikePath('https://example.com/a.ts')).toBe(false)
    expect(looksLikePath('npm run build')).toBe(false)
    expect(looksLikePath('const a = 1')).toBe(false)
    expect(looksLikePath('folder/')).toBe(false)
    expect(looksLikePath('')).toBe(false)
  })
})

describe('splitPathLine', () => {
  it('splits the line suffix', () => {
    expect(splitPathLine('src/a.ts:42')).toEqual({ path: 'src/a.ts', line: 42 })
    expect(splitPathLine('src/a.ts')).toEqual({ path: 'src/a.ts', line: null })
  })
})
