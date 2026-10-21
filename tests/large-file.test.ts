import { describe, expect, it } from 'vitest'
import { detectLargeFile } from '../src/utils/largeFile'

const line = 'const value = 1\n'

describe('detectLargeFile', () => {
  it('treats ordinary files as normal', () => {
    expect(detectLargeFile('hello').mode).toBe('normal')
    expect(detectLargeFile(line.repeat(1000)).mode).toBe('normal')
  })

  it('switches to large mode above 2MB', () => {
    const content = 'x'.repeat(2 * 1024 * 1024 + 1)
    expect(detectLargeFile(content).mode).toBe('large')
  })

  it('switches to large mode above 50k lines', () => {
    expect(detectLargeFile(line.repeat(50_001)).mode).toBe('large')
  })

  it('switches to read-only above 10MB', () => {
    const content = 'x'.repeat(10 * 1024 * 1024 + 1)
    expect(detectLargeFile(content).mode).toBe('readonly')
  })

  it('switches to read-only above 200k lines', () => {
    expect(detectLargeFile(line.repeat(200_001)).mode).toBe('readonly')
  })

  it('counts lines and bytes', () => {
    const info = detectLargeFile('a\nb\nc')
    expect(info.lines).toBe(3)
    expect(info.bytes).toBe(5)
  })
})
