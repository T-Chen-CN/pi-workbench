import {
  ERROR_CODE_MAP,
  ERROR_PREFIX_MAP,
  localizeErrorMessage,
} from '@pi-workbench/i18n'
import { useI18nStore } from '../store/i18nStore'

export { ERROR_CODE_MAP, ERROR_PREFIX_MAP, localizeErrorMessage }

/**
 * 主进程返回的错误文案是固定的英文串或错误码（IPC 结果里的 `error` 字段）。
 * 统一委派 `@pi-workbench/i18n` 的 `localizeErrorMessage` 按当前语言本地化。
 */
export function localizeError(message: string | null | undefined): string {
  return localizeErrorMessage(message, useI18nStore.getState().t)
}
