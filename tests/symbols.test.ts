import { describe, expect, it } from 'vitest'
import { extractSymbols, sliceSymbol } from '../src/utils/symbols'

describe('extractSymbols', () => {
  it('finds TypeScript declarations with line ranges', () => {
    const content = [
      'const top = 1',
      'export function alpha() {',
      '  return 1',
      '}',
      '',
      'export class Beta {',
      '  method() {}',
      '}',
      'export interface Gamma {',
      '  value: string',
      '}',
    ].join('\n')

    const symbols = extractSymbols(content, 'sample.ts').filter((symbol) =>
      ['alpha', 'Beta', 'Gamma'].includes(symbol.name)
    )
    expect(symbols.map((symbol) => symbol.name)).toEqual(['alpha', 'Beta', 'Gamma'])
    expect(symbols[0].startLine).toBe(2)
    expect(symbols[0].endLine).toBe(4)
  })

  it('finds Python defs and classes', () => {
    const content = ['class A:', '    pass', '', 'def run():', '    return 1'].join('\n')
    const symbols = extractSymbols(content, 'sample.py')
    expect(symbols.map((symbol) => symbol.name)).toEqual(['A', 'run'])
    expect(symbols[1].kind).toBe('function')
  })

  it('ignores unsupported file types', () => {
    expect(extractSymbols('anything', 'notes.txt')).toEqual([])
  })

  it('slices the source of a symbol', () => {
    const content = ['line1', 'function a() {', '  return 1', '}', 'line5'].join('\n')
    const symbol = { name: 'a', kind: 'function' as const, startLine: 2, endLine: 4 }
    expect(sliceSymbol(content, symbol)).toBe('function a() {\n  return 1\n}')
  })
})
