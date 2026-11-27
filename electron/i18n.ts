/**
 * Electron 主进程 i18n 适配层：共享 `@pi-workbench/i18n` 词条与插值引擎，
 * 供托盘菜单、气泡提示与系统菜单统一取词，零主进程硬编码文案副本。
 */

import {
  normalizeLanguage,
  translate,
  type Language,
  type TranslateFn,
  type TranslationKey,
  type TranslationParams,
} from '@pi-workbench/i18n'

export type MainTranslator = TranslateFn

export function normalizeMainLanguage(value: unknown): Language {
  return normalizeLanguage(value)
}

export function getMainTranslator(language: unknown): MainTranslator {
  const lang = normalizeMainLanguage(language)
  return (key: TranslationKey, params?: TranslationParams): string => translate(lang, key, params)
}
