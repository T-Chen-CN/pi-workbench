import { afterEach, describe, expect, it } from 'vitest'
import {
  extractSymbols,
  extractSymbolsAsync,
  preloadSymbolParser,
  resetSymbolParsersForTest,
  sliceSymbol,
} from '../../src/utils/symbols'

afterEach(() => {
  resetSymbolParsersForTest()
})

describe('extractSymbols (sync)', () => {
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

  it('switches to cached AST immediately once parser is preloaded', async () => {
    const content = [
      '/*',
      'export function fakeInComment() {}',
      '*/',
      'export function realFn() {',
      '  return 42',
      '}',
    ].join('\n')

    const loaded = await preloadSymbolParser('demo.ts')
    expect(loaded).toBe(true)

    const symbols = extractSymbols(content, 'demo.ts')
    expect(symbols).toEqual([{ name: 'realFn', kind: 'function', startLine: 4, endLine: 6 }])
  })
})

describe('extractSymbolsAsync (web-tree-sitter AST)', () => {
  it('skips fake TypeScript declarations inside comments, strings, and template literals', async () => {
    const content = [
      '/*',
      'export function fakeBlock() {}',
      'export class FakeClass {}',
      '*/',
      '// export interface FakeLine {}',
      'const doc = `',
      'export function fakeTemplate() {}',
      'export const fakeArrow = () => 1',
      '`',
      'const str = "export type FakeString = number"',
      'export function realAlpha() {',
      '  return 1',
      '}',
      'export class RealBeta {',
      '  async run() {',
      '    return 2',
      '  }',
      '}',
      'export interface RealGamma {',
      '  id: string',
      '}',
      'export type RealDelta = string | number',
      'export const realHandler = async (x: number) => {',
      '  return x + 1',
      '}',
    ].join('\n')

    const symbols = await extractSymbolsAsync(content, 'module.ts')
    expect(symbols).toEqual([
      { name: 'realAlpha', kind: 'function', startLine: 11, endLine: 13 },
      { name: 'RealBeta', kind: 'class', startLine: 14, endLine: 18 },
      { name: 'run', kind: 'method', startLine: 15, endLine: 17 },
      { name: 'RealGamma', kind: 'interface', startLine: 19, endLine: 21 },
      { name: 'RealDelta', kind: 'type', startLine: 22, endLine: 22 },
      { name: 'realHandler', kind: 'const', startLine: 23, endLine: 25 },
    ])
  })

  it('extracts Python symbols and ignores comments and docstrings', async () => {
    const content = [
      '# def fake_comment(): pass',
      '"""',
      'class FakeDocstring:',
      '    def fake_method(self):',
      '        pass',
      '"""',
      'class Worker:',
      '    def execute(self):',
      '        return True',
      '',
      'async def top_task():',
      '    return 1',
    ].join('\n')

    const symbols = await extractSymbolsAsync(content, 'worker.py')
    expect(symbols).toEqual([
      { name: 'Worker', kind: 'class', startLine: 7, endLine: 9 },
      { name: 'execute', kind: 'method', startLine: 8, endLine: 9 },
      { name: 'top_task', kind: 'function', startLine: 11, endLine: 12 },
    ])
  })

  it('extracts Go symbols and ignores comments and raw string literals', async () => {
    const content = [
      'package main',
      '/*',
      'func FakeBlock() {}',
      '*/',
      '// type FakeType struct {}',
      'const tpl = `',
      'func FakeRaw() {}',
      '`',
      'type Engine struct {',
      '  id int',
      '}',
      'type Runner interface {',
      '  Run()',
      '}',
      'func Start() {}',
      'func (e *Engine) Stop() {}',
    ].join('\n')

    const symbols = await extractSymbolsAsync(content, 'main.go')
    expect(symbols).toEqual([
      { name: 'Engine', kind: 'type', startLine: 9, endLine: 11 },
      { name: 'Runner', kind: 'interface', startLine: 12, endLine: 14 },
      { name: 'Start', kind: 'function', startLine: 15, endLine: 15 },
      { name: 'Stop', kind: 'method', startLine: 16, endLine: 16 },
    ])
  })

  it('extracts Rust symbols and ignores comments and string literals', async () => {
    const content = [
      '/* pub fn fake_block() {} */',
      '// pub struct FakeLine {}',
      'const S: &str = "pub enum FakeStr { A }";',
      'pub struct Config {',
      '    port: u16,',
      '}',
      'pub enum State { Ready, Busy }',
      'pub trait Service {',
      '    fn name(&self);',
      '}',
      'impl Config {',
      '    pub fn new() -> Self {',
      '        Self { port: 80 }',
      '    }',
      '}',
      'pub async fn boot() {}',
    ].join('\n')

    const symbols = await extractSymbolsAsync(content, 'lib.rs')
    expect(symbols).toEqual([
      { name: 'Config', kind: 'class', startLine: 4, endLine: 6 },
      { name: 'State', kind: 'interface', startLine: 7, endLine: 7 },
      { name: 'Service', kind: 'interface', startLine: 8, endLine: 10 },
      { name: 'new', kind: 'method', startLine: 12, endLine: 14 },
      { name: 'boot', kind: 'function', startLine: 16, endLine: 16 },
    ])
  })

  it('extracts C++ symbols and ignores comments and raw strings', async () => {
    const content = [
      '/*',
      'class FakeBlock {};',
      'int fake_fn() { return 0; }',
      '*/',
      '// struct FakeLine {};',
      'const char* s = "int fake_str() { return 0; }";',
      'class Engine {',
      'public:',
      '  void start() {}',
      '};',
      'struct Point {',
      '  int x;',
      '};',
      'int* create_buffer(int size) {',
      '  return nullptr;',
      '}',
    ].join('\n')

    const symbols = await extractSymbolsAsync(content, 'engine.cpp')
    expect(symbols).toEqual([
      { name: 'Engine', kind: 'class', startLine: 7, endLine: 10 },
      { name: 'start', kind: 'method', startLine: 9, endLine: 9 },
      { name: 'Point', kind: 'class', startLine: 11, endLine: 13 },
      { name: 'create_buffer', kind: 'function', startLine: 14, endLine: 16 },
    ])
  })

  it('falls back to regex cleanly for unsupported WASM languages like Kotlin', async () => {
    const content = ['class Service {', '  fun run() {}', '}', 'interface Repo {}'].join('\n')
    const symbols = await extractSymbolsAsync(content, 'App.kt')
    expect(symbols.map((s) => ({ name: s.name, kind: s.kind }))).toEqual([
      { name: 'Service', kind: 'class' },
      { name: 'Repo', kind: 'interface' },
    ])
  })
})
