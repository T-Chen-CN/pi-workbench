/**
 * 仓库地图的文案生成。
 *
 * 缓存里只存与语言无关的事实（角色、首部注释、导出名），这里按当前语言拼一句话，
 * 所以切中英文不需要重新扫描。纯函数，方便单测。
 */

import type { RepoMapFile, RepoMapRole } from '../types/electron'
import type { TranslationKey, TranslationParams } from '../i18n/translations'

export type Translate = (key: TranslationKey, params?: TranslationParams) => string

const ROLE_KEYS: Record<RepoMapRole, TranslationKey> = {
  component: 'repoMapRoleComponent',
  state: 'repoMapRoleState',
  ipc: 'repoMapRoleIpc',
  util: 'repoMapRoleUtil',
  type: 'repoMapRoleType',
  style: 'repoMapRoleStyle',
  test: 'repoMapRoleTest',
  doc: 'repoMapRoleDoc',
  config: 'repoMapRoleConfig',
  asset: 'repoMapRoleAsset',
  other: 'repoMapRoleOther',
}

/** 一句话描述的长度上限：中文按字算，英文按字符算 */
const LIMIT_ZH = 26
const LIMIT_EN = 56

export function repoMapRoleKey(role: RepoMapRole): TranslationKey {
  return ROLE_KEYS[role] ?? 'repoMapRoleOther'
}

export function repoMapBaseName(path: string): string {
  const index = path.lastIndexOf('/')
  return index >= 0 ? path.slice(index + 1) : path
}

function truncate(text: string, limit: number): string {
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  return `${chars.slice(0, limit - 1).join('')}…`
}

/** 目录分组键：顶层目录名；仓库根下的文件归到空串 */
export function repoMapGroupKey(path: string): string {
  const index = path.indexOf('/')
  return index > 0 ? path.slice(0, index) : ''
}

/**
 * 一行功能描述。
 * 优先级：首部注释（带导出名做主语）> 导出名 > 「角色：文件名」。
 */
export function describeRepoMapFile(
  file: RepoMapFile,
  t: Translate,
  language: 'zh' | 'en'
): string {
  const limit = language === 'en' ? LIMIT_EN : LIMIT_ZH
  const role = t(repoMapRoleKey(file.role))
  const name = repoMapBaseName(file.path)

  if (file.binary) return truncate(t('repoMapDescribeBinary', { role, name }), limit)

  if (file.headComment) {
    const colon = language === 'en' ? ': ' : '：'
    const text = file.symbol ? `${file.symbol}${colon}${file.headComment}` : file.headComment
    return truncate(text, limit)
  }

  const exports = file.exports ?? []
  if (exports.length > 0) {
    const names = exports.join(language === 'en' ? ', ' : '、')
    return truncate(t('repoMapDescribeExports', { names }), limit)
  }

  return truncate(t('repoMapDescribeFallback', { role, name }), limit)
}
