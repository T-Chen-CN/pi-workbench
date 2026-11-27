import type { TranslationKey, TranslationParams } from './resources.js'

/**
 * 主进程 / 服务端返回的固定错误码与历史英文错误串映射表。
 * 未知错误原样返回，避免吞掉底层诊断信息。
 */
export const ERROR_CODE_MAP: Record<string, TranslationKey> = {
  // Structured error codes
  ERR_PATH_OUTSIDE_WORKSPACE: 'errPathOutsideWorkspace',
  ERR_FILE_ALREADY_EXISTS: 'errFileAlreadyExists',
  ERR_WORKSPACE_NOT_INITIALIZED: 'errWorkspaceNotInitialized',
  ERR_WORKSPACE_NOT_APPROVED: 'errWorkspaceNotApproved',
  ERR_AGENT_NOT_INITIALIZED: 'errAgentNotInitialized',
  ERR_AGENT_NO_ABORT: 'errAgentNoAbort',
  ERR_INVALID_API_URL: 'errInvalidApiUrl',
  ERR_API_URL_SCHEME: 'errApiUrlScheme',
  ERR_API_KEY_NOT_CONFIGURED: 'errApiKeyNotConfigured',
  ERR_UPDATE_NOT_PACKAGED: 'errUpdateNotPackaged',
  ERR_UPDATE_NO_RELEASE: 'errUpdateNoRelease',
  ERR_UPDATE_NETWORK: 'errUpdateNetwork',
  ERR_UPDATE_RATE_LIMIT: 'errUpdateRateLimit',
  ERR_UPDATE_MANUAL: 'errUpdateManual',
  ERR_UPDATE_NOT_DOWNLOADED: 'errUpdateNotDownloaded',
  // Legacy English error strings emitted by Electron main process
  'Path is outside the open workspace': 'errPathOutsideWorkspace',
  'File already exists': 'errFileAlreadyExists',
  'Workspace not initialized': 'errWorkspaceNotInitialized',
  'Workspace is not approved': 'errWorkspaceNotApproved',
  'Agent not initialized for this workspace': 'errAgentNotInitialized',
  'Agent does not support abort': 'errAgentNoAbort',
  'Please enter a valid API URL': 'errInvalidApiUrl',
  'API URL must start with http:// or https://': 'errApiUrlScheme',
  'API key not configured. Please set it in Settings.': 'errApiKeyNotConfigured',
  'Failed to switch the session worktree.': 'worktreeSwitchFailed',
  'Worktree is in use by a session': 'worktreeForgetInUse',
  'Worktree still exists': 'worktreeForgetStillLive',
  'The main worktree cannot be forgotten': 'worktreeForgetFailed',
  'Unknown worktree': 'worktreeForgetFailed',
}

export const ERROR_PREFIX_MAP: ReadonlyArray<readonly [string, TranslationKey]> = [
  ['Failed to initialize agent: ', 'agentInitFailedDetail'],
  ['Agent error: ', 'agentErrorDetail'],
]

export type TranslateFn = (key: TranslationKey, params?: TranslationParams) => string

export function localizeErrorMessage(
  message: string | null | undefined,
  translateFn: TranslateFn
): string {
  if (!message) return ''

  const exactKey = ERROR_CODE_MAP[message]
  if (exactKey) return translateFn(exactKey)

  for (const [prefix, key] of ERROR_PREFIX_MAP) {
    if (message.startsWith(prefix)) {
      return translateFn(key, { detail: message.slice(prefix.length) })
    }
  }

  return message
}
