/**
 * Markdown 链接的解析基准。
 *
 * 阅读视图里的相对链接以「所在文档的目录」为基准，聊天回复里的相对链接以
 * 「当前会话绑定的工作树根」为基准。链接组件通过这个 Context 取基准，
 * 不把路径知识塞进 Markdown 渲染器本身。
 */

import React, { createContext, useContext } from 'react'

export interface MarkdownLinkScope {
  /** 所在文档的目录；null 表示相对路径按 openRoot 解析 */
  docDir: string | null
  /** 打开目标文件用的根（工作树或工作区）；null 时回落到当前工作区 */
  openRoot: string | null
}

const DEFAULT_SCOPE: MarkdownLinkScope = { docDir: null, openRoot: null }

const LinkScopeContext = createContext<MarkdownLinkScope>(DEFAULT_SCOPE)

export const MarkdownLinkScopeProvider: React.FC<{
  value: MarkdownLinkScope
  children: React.ReactNode
}> = ({ value, children }) => <LinkScopeContext.Provider value={value}>{children}</LinkScopeContext.Provider>

export function useMarkdownLinkScope(): MarkdownLinkScope {
  return useContext(LinkScopeContext)
}
