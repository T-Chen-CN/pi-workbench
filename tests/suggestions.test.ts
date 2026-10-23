import { describe, expect, it } from 'vitest'
import { buildChatSuggestions } from '../src/utils/suggestions'
import type { TranslationKey, TranslationParams } from '../src/i18n/translations'

const translate = (key: TranslationKey, params?: TranslationParams): string =>
  params ? `${key}|${Object.values(params).join(',')}` : key

describe('buildChatSuggestions', () => {
  it('falls back to tests and todos without recent files', () => {
    const suggestions = buildChatSuggestions({
      workspaceType: 'unknown',
      recentFiles: [],
      translate,
    })

    expect(suggestions.map((item) => item.id)).toEqual(['run-tests', 'todos'])
    expect(suggestions[0].prompt).toBe('suggestTestsPrompt')
  })

  it('suggests explaining and reviewing the most recent file', () => {
    const suggestions = buildChatSuggestions({
      workspaceType: 'node',
      recentFiles: ['src/a.ts', 'src/b.ts'],
      translate,
    })

    expect(suggestions.map((item) => item.id)).toEqual([
      'explain-file',
      'review-file',
      'run-tests',
    ])
    expect(suggestions[0].label).toBe('suggestExplainFileLabel|a.ts')
    expect(suggestions[0].prompt).toBe('suggestExplainFilePrompt|src/a.ts')
    expect(suggestions[2].prompt).toBe('suggestTestsNodePrompt')
  })

  it('uses the workspace type for the test prompt', () => {
    const suggestions = buildChatSuggestions({
      workspaceType: 'python',
      recentFiles: ['app/main.py'],
      translate,
    })

    expect(suggestions[2].prompt).toBe('suggestTestsPythonPrompt')
  })

  it('returns at most three suggestions', () => {
    const suggestions = buildChatSuggestions({
      workspaceType: 'rust',
      recentFiles: ['src/main.rs'],
      translate,
    })

    expect(suggestions).toHaveLength(3)
  })
})
