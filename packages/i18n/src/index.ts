import i18next, { type i18n as I18nInstance } from 'i18next'
import {
  translations,
  type Language,
  type TranslationKey,
  type TranslationParams,
} from './resources.js'
import {
  ERROR_CODE_MAP,
  ERROR_PREFIX_MAP,
  localizeErrorMessage,
  type TranslateFn,
} from './errors.js'

export function normalizeLanguage(value: unknown): Language {
  return value === 'en' ? 'en' : 'zh'
}

/**
 * 创建同步就绪的 i18next 实例：
 * - `initAsync: false` 保证构造后立刻可翻译，无异步首帧闪烁；
 * - 单花括号 `{param}` 插值，与既有全量中英文词条及占位符校验完全一致；
 * - 禁用 `keySeparator` / `nsSeparator`，避免词条键被意外拆分。
 */
export function createWorkbenchI18n(initialLang: Language = 'zh'): I18nInstance {
  const instance = i18next.createInstance()
  void instance.init({
    lng: normalizeLanguage(initialLang),
    fallbackLng: 'zh',
    initAsync: false,
    returnNull: false,
    defaultNS: 'translation',
    ns: ['translation'],
    keySeparator: false,
    nsSeparator: false,
    resources: {
      zh: { translation: translations.zh },
      en: { translation: translations.en },
    },
    interpolation: {
      prefix: '{',
      suffix: '}',
      escapeValue: false,
    },
  })
  return instance
}

/** 跨三端（桌面渲染层 / Electron 主进程 / 云端 Web）共享的默认 i18next 单例 */
export const i18n: I18nInstance = createWorkbenchI18n('zh')

/** 按显式语言同步翻译（使用 `replace` 传递插值参数，避免 `count` 等键触发 i18next 保留语义） */
export function translate(
  lang: Language,
  key: TranslationKey,
  params?: TranslationParams
): string {
  const resolvedLang = normalizeLanguage(lang)
  const options = params ? { lng: resolvedLang, replace: params } : { lng: resolvedLang }
  return i18n.t(key, options)
}

/** 按共享单例当前语言翻译 */
export function t(key: TranslationKey, params?: TranslationParams): string {
  return translate(normalizeLanguage(i18n.language), key, params)
}

export {
  translations,
  ERROR_CODE_MAP,
  ERROR_PREFIX_MAP,
  localizeErrorMessage,
  type Language,
  type TranslationKey,
  type TranslationParams,
  type TranslateFn,
  type I18nInstance,
}
