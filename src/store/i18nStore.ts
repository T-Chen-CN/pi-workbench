import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { Language, translations, TranslationKey } from '../i18n/translations'

interface I18nState {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: TranslationKey) => string
}

export const useI18nStore = create<I18nState>()(
  persist(
    (set, get) => ({
      language: 'zh', // 默认中文

      setLanguage: (lang: Language) => {
        set({ language: lang })
      },

      t: (key: TranslationKey): string => {
        const { language } = get()
        return translations[language]?.[key] || key
      },
    }),
    {
      name: 'pi-workbench-language',
    }
  )
)
