import React, { useMemo } from 'react'
import type { Components } from 'streamdown'
import { toast } from '../store/toastStore'
import { useI18nStore } from '../store/i18nStore'
import { useWorkspaceScope } from '../workspace/WorkspaceScope'
import { useWorkspaceStore } from '../store/workspaceStore'
import { openFileInEditor } from '../workspace/openFileInEditor'
import { useMarkdownLinkScope } from '../workspace/MarkdownLinkScope'
import { openMarkdownLink, resolveMarkdownLink } from '../workspace/linkTarget'
import { looksLikePath, joinPath, splitPathLine } from '../utils/filePath'
import { useHostDocument } from '../panelHost/HostContext'
import { StreamdownView, defaultComponents } from './StreamdownView'

/** 点击文件路径打开编辑器（相对路径按当前工作区 / 工作树根解析） */
const PathCode: React.FC<{ value: string; children: React.ReactNode }> = ({ value, children }) => {
  const scopeWorkspace = useWorkspaceScope()
  const linkScope = useMarkdownLinkScope()
  const open = async () => {
    const workspace = linkScope.openRoot ?? scopeWorkspace ?? useWorkspaceStore.getState().workspacePath
    if (!workspace) return
    const { path: filePart, line } = splitPathLine(value)
    const target =
      /^[A-Za-z]:[\\/]/.test(filePart) || filePart.startsWith('/') ? filePart : joinPath(workspace, filePart)
    try {
      // 与文件树共用打开入口：带行号时滚动到该行并高亮（R-09）
      await openFileInEditor(workspace, target, { revealLine: line ?? undefined })
    } catch (error) {
      console.error('Failed to open referenced file:', error)
    }
  }

  return (
    <code
      role="button"
      tabIndex={0}
      className="cursor-pointer underline-offset-2 hover:text-accent hover:underline"
      title={value}
      onClick={() => void open()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          void open()
        }
      }}
    >
      {children}
    </code>
  )
}

/**
 * 链接：外链交系统浏览器，仓库内路径交编辑器，`#anchor` 站内滚动。
 *
 * 不用 `target="_blank"`：打包后主窗口的 `setWindowOpenHandler` 只放行辅助窗口，
 * `window.open` 会被静默拒绝（这正是"链接点不动"的成因）。
 */
const MarkdownAnchor: React.FC<{ href?: string; children: React.ReactNode }> = ({ href, children }) => {
  const { t } = useI18nStore()
  const scope = useMarkdownLinkScope()
  const scopeWorkspace = useWorkspaceScope()

  const handleClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    const workspaceDir = scopeWorkspace ?? useWorkspaceStore.getState().workspacePath
    const target = resolveMarkdownLink(href, { docDir: scope.docDir, workspaceDir })
    if (!target) return
    const opened = await openMarkdownLink(target, {
      docDir: scope.docDir,
      workspaceDir,
      openRoot: scope.openRoot ?? workspaceDir,
      anchorElement: event.currentTarget,
    })
    if (!opened) toast.error(t('linkOpenFailed', { target: href ?? '' }))
  }

  return (
    <a href={href} title={href} onClick={(event) => void handleClick(event)}>
      {children}
    </a>
  )
}

const DefaultCode = defaultComponents.code

const DESKTOP_COMPONENTS: Components = {
  a: ({ href, children }) => <MarkdownAnchor href={href}>{children}</MarkdownAnchor>,
  code: (props) => {
    // Streamdown 用 data-block 区分围栏代码块与行内代码；仅行内路径代码走 PathCode，其余交回 Streamdown 渲染 Shiki/Mermaid
    const isBlock = 'data-block' in props
    if (!isBlock && !props.className) {
      const text = typeof props.children === 'string' ? props.children : String(props.children ?? '')
      if (looksLikePath(text)) {
        return <PathCode value={text}>{props.children}</PathCode>
      }
    }
    return <DefaultCode {...props} />
  },
}

/** 流式消息：底层复用 Streamdown v2（Remend 语法自愈 + 块级冻结 + Shiki JS 引擎 + 公式/图表/CJK） */
export const StreamingMarkdown = React.memo(function StreamingMarkdown({
  content,
  showCursor = true,
  isStreaming = true,
  highlight = true,
}: {
  content: string
  showCursor?: boolean
  isStreaming?: boolean
  highlight?: boolean
}) {
  const language = useI18nStore((state) => state.language)
  const hostDocument = useHostDocument()
  const portal = useMemo(() => () => hostDocument.body, [hostDocument])

  return (
    <StreamdownView
      content={content}
      isStreaming={isStreaming}
      showCursor={showCursor}
      highlight={highlight}
      language={language}
      components={DESKTOP_COMPONENTS}
      portal={portal}
    />
  )
})

/** 已完成消息 / 静态 Markdown 文档：与 StreamingMarkdown 共用同一套 Streamdown 渲染内核，流式结束零闪烁 */
export const MarkdownBody = React.memo(function MarkdownBody({
  content,
  highlight,
}: {
  content: string
  highlight: boolean
}) {
  const language = useI18nStore((state) => state.language)
  const hostDocument = useHostDocument()
  const portal = useMemo(() => () => hostDocument.body, [hostDocument])

  return (
    <StreamdownView
      content={content}
      isStreaming={false}
      showCursor={false}
      highlight={highlight}
      language={language}
      components={DESKTOP_COMPONENTS}
      portal={portal}
    />
  )
})
