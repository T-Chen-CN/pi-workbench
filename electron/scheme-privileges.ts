import { protocol } from 'electron'
import { APP_SCHEME } from './app-protocol.js'
import { FILE_SCHEME } from './file-protocol.js'

/**
 * 自定义 scheme 的特权声明。
 *
 * 必须在 `app ready` 之前**一次**完成：Electron 只保留最后一次
 * `registerSchemesAsPrivileged()` 的调用，分两次注册（外壳一次、只读文件一次）
 * 会让先注册的那个 scheme 丢掉 standard / secure / supportFetchAPI / stream /
 * corsEnabled —— 症状是 iframe 里的相对路径失效、媒体无法按 Range 流式取流、
 * `fetch()` 直接报 "URL scheme is not supported"（XHR 仍能侥幸工作，容易漏测）。
 *
 * 新增自定义 scheme 时只往这个数组里加，不要再单独调用注册函数。
 */
export const SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  corsEnabled: true,
  bypassCSP: false
} as const

export const PRIVILEGED_SCHEMES: readonly string[] = [APP_SCHEME, FILE_SCHEME]

export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged(
    PRIVILEGED_SCHEMES.map((scheme) => ({ scheme, privileges: { ...SCHEME_PRIVILEGES } }))
  )
}
