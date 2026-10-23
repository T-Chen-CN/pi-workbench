import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildInstallerManifest,
  MANIFEST_DIRS,
  MANIFEST_FILES,
  validateManifestEntry,
  writeInstallerManifest,
} from '../scripts/lib/installer-manifest.js'

const tempDirs: string[] = []

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-manifest-'))
  tempDirs.push(root)
  const write = (relative: string, content = 'x') => {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }

  write('Pi Workbench.exe')
  write('resources/app.asar')
  write('resources/app-update.yml', 'provider: github')
  write(`resources/${MANIFEST_FILES}`, 'old')
  write(`resources/${MANIFEST_DIRS}`, 'old')
  write('resources/app.asar.unpacked/node_modules/node-pty/build/Release/conpty.node')
  write('locales/en-US.pak')
  write('empty-dir/keep.txt')
  fs.rmSync(path.join(root, 'empty-dir', 'keep.txt'))
  write('config/settings.json')
  write('data/agent/sessions/a.jsonl')
  write('logs/main.log')
  write('cache/pi-workbench-updater/pending/Setup.exe')
  return root
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('buildInstallerManifest', () => {
  it('records only installer-owned program files', () => {
    const { files } = buildInstallerManifest(makeFixture())

    expect(files).toContain('Pi Workbench.exe')
    expect(files).toContain('resources\\app.asar')
    expect(files).toContain('locales\\en-US.pak')
    expect(files).toContain(
      'resources\\app.asar.unpacked\\node_modules\\node-pty\\build\\Release\\conpty.node'
    )
  })

  it('never records runtime data or protected directories', () => {
    const { files, dirs } = buildInstallerManifest(makeFixture())
    const all = [...files, ...dirs]

    for (const protectedName of ['config', 'data', 'logs', 'cache']) {
      expect(all.some((entry) => entry.split('\\')[0] === protectedName)).toBe(false)
    }
  })

  it('excludes app-update.yml and the manifest files themselves', () => {
    const { files } = buildInstallerManifest(makeFixture())

    expect(files).not.toContain('resources\\app-update.yml')
    expect(files).not.toContain(`resources\\${MANIFEST_FILES}`)
    expect(files).not.toContain(`resources\\${MANIFEST_DIRS}`)
  })

  it('sorts files and orders directories deepest-first', () => {
    const { files, dirs } = buildInstallerManifest(makeFixture())
    const sorted = [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    expect(files).toEqual(sorted)

    const deepIndex = dirs.indexOf(
      'resources\\app.asar.unpacked\\node_modules\\node-pty\\build\\Release'
    )
    const shallowIndex = dirs.indexOf('resources')
    expect(deepIndex).toBeGreaterThanOrEqual(0)
    expect(shallowIndex).toBeGreaterThan(deepIndex)
  })

  it('is deterministic', () => {
    const root = makeFixture()
    expect(buildInstallerManifest(root)).toEqual(buildInstallerManifest(root))
  })
})

describe('writeInstallerManifest', () => {
  it('writes both manifests into resources with one entry per line', () => {
    const root = makeFixture()
    const result = writeInstallerManifest(root)
    const { files, dirs } = buildInstallerManifest(root)

    expect(result.files).toBe(files.length)
    expect(result.dirs).toBe(dirs.length)
    expect(fs.readFileSync(path.join(root, 'resources', MANIFEST_FILES), 'utf8')).toBe(
      `${files.join('\r\n')}\r\n`
    )
    expect(fs.readFileSync(path.join(root, 'resources', MANIFEST_DIRS), 'utf8')).toBe(
      `${dirs.join('\r\n')}\r\n`
    )
  })
})

describe('validateManifestEntry', () => {
  it('accepts relative printable ASCII paths', () => {
    expect(() => validateManifestEntry('resources\\app.asar')).not.toThrow()
    expect(() => validateManifestEntry('Pi Workbench.exe')).not.toThrow()
  })

  it.each([
    '',
    '..\\escape.txt',
    'C:\\Windows\\system32\\evil.dll',
    '\\\\server\\share\\evil.dll',
    '\\absolute\\path',
    'folder\\..\\escape.txt',
    'new\nline',
    '中文.txt',
  ])('rejects unsafe entry %j', (entry) => {
    expect(() => validateManifestEntry(entry)).toThrow()
  })
})
