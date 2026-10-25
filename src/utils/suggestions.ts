import type { TranslationKey, TranslationParams } from '../i18n/translations'
import { basename } from './filePath'

export type WorkspaceType = 'node' | 'python' | 'rust' | 'go' | 'unknown'

export interface ChatSuggestion {
  id: string
  label: string
  prompt: string
}

export interface SuggestionInput {
  workspaceType: WorkspaceType
  /** 相对工作区的最近文件，最近的在前 */
  recentFiles: string[]
  translate: (key: TranslationKey, params?: TranslationParams) => string
}

const TEST_PROMPT_KEYS: Record<WorkspaceType, TranslationKey> = {
  node: 'suggestTestsNodePrompt',
  python: 'suggestTestsPythonPrompt',
  rust: 'suggestTestsRustPrompt',
  go: 'suggestTestsGoPrompt',
  unknown: 'suggestTestsPrompt',
}

function displayName(file: string): string {
  return basename(file) || file
}

/**
 * 空会话建议（R-15）：按最近文件与工作区类型给出的本地规则，不依赖模型。
 * 最多三条，点击后只填入输入框，不自动发送。
 */
export function buildChatSuggestions({
  workspaceType,
  recentFiles,
  translate: t,
}: SuggestionInput): ChatSuggestion[] {
  const suggestions: ChatSuggestion[] = []
  const file = recentFiles[0]
  if (file) {
    suggestions.push({
      id: 'explain-file',
      label: t('suggestExplainFileLabel', { file: displayName(file) }),
      prompt: t('suggestExplainFilePrompt', { file }),
    })
    suggestions.push({
      id: 'review-file',
      label: t('suggestReviewFileLabel', { file: displayName(file) }),
      prompt: t('suggestReviewFilePrompt', { file }),
    })
  }
  suggestions.push({
    id: 'run-tests',
    label: t('suggestTests'),
    prompt: t(TEST_PROMPT_KEYS[workspaceType]),
  })
  suggestions.push({
    id: 'todos',
    label: t('suggestTodos'),
    prompt: t('suggestTodosPrompt'),
  })
  return suggestions.slice(0, 3)
}
