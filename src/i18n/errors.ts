import { useI18nStore } from '../store/i18nStore'
import type { TranslationKey } from './translations'

/**
 * 主进程返回的错误文案是固定的英文串（IPC 结果里的 `error` 字段）。
 * 这里把已知错误映射到当前语言的翻译；未知错误原样返回，避免吞掉诊断信息。
 */
const EXACT: Record<string, TranslationKey> = {
  'Path is outside the open workspace': 'errPathOutsideWorkspace',
  'Workspace not initialized': 'errWorkspaceNotInitialized',
  'Workspace is not approved': 'errWorkspaceNotApproved',
  'Agent not initialized for this workspace': 'errAgentNotInitialized',
  'Agent does not support abort': 'errAgentNoAbort',
  'Please enter a valid API URL': 'errInvalidApiUrl',
  'API URL must start with http:// or https://': 'errApiUrlScheme',
  'API key not configured. Please set it in Settings.': 'errApiKeyNotConfigured',
  ERR_UPDATE_NOT_PACKAGED: 'errUpdateNotPackaged',
  ERR_UPDATE_NO_RELEASE: 'errUpdateNoRelease',
  ERR_UPDATE_NETWORK: 'errUpdateNetwork',
  ERR_UPDATE_RATE_LIMIT: 'errUpdateRateLimit',
  ERR_UPDATE_MANUAL: 'errUpdateManual',
  ERR_UPDATE_NOT_DOWNLOADED: 'errUpdateNotDownloaded',
  'Failed to switch the session worktree.': 'worktreeSwitchFailed',
  'Worktree is in use by a session': 'worktreeForgetInUse',
  'Worktree still exists': 'worktreeForgetStillLive',
  'The main worktree cannot be forgotten': 'worktreeForgetFailed',
  'Unknown worktree': 'worktreeForgetFailed',
}

const PREFIXES: Array<[string, TranslationKey]> = [
  ['Failed to initialize agent: ', 'agentInitFailedDetail'],
  ['Agent error: ', 'agentErrorDetail'],
]

export function localizeError(message: string | null | undefined): string {
  if (!message) return ''
  const { t } = useI18nStore.getState()

  const exactKey = EXACT[message]
  if (exactKey) return t(exactKey)

  for (const [prefix, key] of PREFIXES) {
    if (message.startsWith(prefix)) {
      return t(key, { detail: message.slice(prefix.length) })
    }
  }

  return message
}
