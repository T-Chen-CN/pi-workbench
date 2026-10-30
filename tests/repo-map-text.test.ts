import { describe, expect, it } from 'vitest'
import {
  describeRepoMapFile,
  repoMapBaseName,
  repoMapGroupKey,
  repoMapRoleKey,
} from '../src/utils/repoMapText'
import { translations } from '../src/i18n/translations'
import type { RepoMapFile } from '../src/types/electron'

const zh = translations.zh
const en = translations.en

function translate(language: 'zh' | 'en') {
  return (key: keyof typeof zh, params?: Record<string, string | number>) => {
    const template = (language === 'zh' ? zh : en)[key] as string
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match
    )
  }
}

const tZh = translate('zh') as never
const tEn = translate('en') as never

function file(overrides: Partial<RepoMapFile>): RepoMapFile {
  return {
    path: 'src/components/WorkspacePanel.tsx',
    role: 'component',
    binary: false,
    size: 100,
    mtimeMs: 1,
    described: true,
    ...overrides,
  }
}

describe('repoMapRoleKey', () => {
  it('maps every role to an i18n key', () => {
    expect(repoMapRoleKey('ipc')).toBe('repoMapRoleIpc')
    expect(repoMapRoleKey('other')).toBe('repoMapRoleOther')
  })
})

describe('repoMapGroupKey / repoMapBaseName', () => {
  it('groups by the first path segment and keeps root files empty', () => {
    expect(repoMapGroupKey('src/components/App.tsx')).toBe('src')
    expect(repoMapGroupKey('package.json')).toBe('')
  })

  it('derives the base name', () => {
    expect(repoMapBaseName('a/b/c.ts')).toBe('c.ts')
    expect(repoMapBaseName('LICENSE')).toBe('LICENSE')
  })
})

describe('describeRepoMapFile', () => {
  it('prefers the head comment with the leading export as the subject', () => {
    const text = describeRepoMapFile(
      file({ headComment: '编辑区的默认视图', symbol: 'WorkspacePanel' }),
      tZh,
      'zh'
    )
    expect(text).toBe('WorkspacePanel：编辑区的默认视图')
  })

  it('falls back to exports and then to role + name', () => {
    expect(
      describeRepoMapFile(file({ exports: ['a', 'b'], symbol: undefined }), tZh, 'zh')
    ).toBe('导出 a、b')
    expect(describeRepoMapFile(file({}), tZh, 'zh')).toBe('组件：WorkspacePanel.tsx')
  })

  it('marks binary assets', () => {
    expect(
      describeRepoMapFile(file({ path: 'build/icon.ico', role: 'asset', binary: true }), tZh, 'zh')
    ).toBe('资源：icon.ico（二进制）')
  })

  it('truncates long descriptions per language', () => {
    const long = '很长的一句描述'.repeat(10)
    const zhText = describeRepoMapFile(file({ headComment: long }), tZh, 'zh')
    expect(Array.from(zhText)).toHaveLength(26)
    expect(zhText.endsWith('…')).toBe(true)

    const enText = describeRepoMapFile(file({ headComment: long }), tEn, 'en')
    expect(Array.from(enText)).toHaveLength(56)
  })

  it('keeps English templates in sync with the same facts', () => {
    expect(
      describeRepoMapFile(file({ headComment: 'Panel default view', symbol: 'WorkspacePanel' }), tEn, 'en')
    ).toBe('WorkspacePanel: Panel default view')
    expect(describeRepoMapFile(file({}), tEn, 'en')).toBe('Component: WorkspacePanel.tsx')
  })
})
