import { create } from 'zustand'
import {
  Language,
  translations,
  TranslationKey,
  TranslationParams,
} from '../i18n/translations'

interface I18nState {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: TranslationKey, params?: TranslationParams) => string
}

/** 把 `{name}` 占位符替换为调用方传入的参数 */
function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match
  )
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

  t: (key: TranslationKey, params?: TranslationParams): string => {
    const { language } = get()
    return interpolate(translations[language]?.[key] || key, params)
  },
}))
