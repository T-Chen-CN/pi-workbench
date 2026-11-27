import { create } from 'zustand'
import {
  i18n,
  translate,
  type Language,
  type TranslationKey,
  type TranslationParams,
} from '@pi-workbench/i18n'

interface I18nState {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: TranslationKey, params?: TranslationParams) => string
}

/**
 * 按当前 store 状态生成新的翻译函数引用：
 * - `setLanguage` 切换时换发新引用，触发只订阅 `s.t` 或 `useMemo(..., [t])` 的组件刷新；
 * - 调用时仍动态读取 `get().language`，兼容测试直接 `useI18nStore.setState({ language })`。
 */
function makeTranslator(get: () => I18nState): I18nState['t'] {
  return (key: TranslationKey, params?: TranslationParams): string =>
    translate(get().language, key, params)
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
    void i18n.changeLanguage(lang)
    set({ language: lang, t: makeTranslator(get) })
  },

  t: makeTranslator(get),
}))
