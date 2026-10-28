import type { TranslationKey } from '../i18n/translations'
import type { PanelId } from './types'

/** 面板在标题栏 / 辅助窗口标题里显示的名字 */
export const PANEL_TITLE_KEY: Record<PanelId, TranslationKey> = {
  files: 'files',
  git: 'gitView',
  chat: 'agentChatTitle',
  terminal: 'terminal',
}
