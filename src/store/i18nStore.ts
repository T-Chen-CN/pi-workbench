import { create } from 'zustand'
import { Language, translations, TranslationKey } from '../i18n/translations'

interface I18nState {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: TranslationKey) => string
}

/**
 * 语言状态。
 *
 * 语言偏好的持久化由 App/Settings 通过 `{appDir}/config/settings.json` 完成，
 * 不在渲染进程使用 localStorage（它会落到 Chromium 的 userData 目录）。
 */
export const useI18nStore = create<I18nState>()((set, get) => ({
  language: 'zh',

  setLanguage: (lang: Language) => {
    set({ language: lang })
  },

  t: (key: TranslationKey): string => {
    const { language } = get()
    return translations[language]?.[key] || key
  },
}))
