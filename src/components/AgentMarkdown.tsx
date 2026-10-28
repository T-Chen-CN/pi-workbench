import React, { useDeferredValue, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import { copyText } from '../utils/clipboard'
import { toast } from '../store/toastStore'
import { useI18nStore } from '../store/i18nStore'
import { useWorkspaceScope } from '../workspace/WorkspaceScope'
import { useWorkspaceStore } from '../store/workspaceStore'
import { openFileInEditor } from '../workspace/openFileInEditor'
import { useMarkdownLinkScope } from '../workspace/MarkdownLinkScope'
import { openMarkdownLink, resolveMarkdownLink } from '../workspace/linkTarget'
import { splitMarkdownBlocks } from '../utils/markdownBlocks'
import { looksLikePath, joinPath, splitPathLine } from '../utils/filePath'

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
      className="cursor-pointer underline-offset-2 hover:text-accent hover:underline"
      title={value}
      onClick={() => void open()}
    >
      {children}
    </code>
  )
}

/** 代码块：带复制按钮 */
const CodeBlock: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const { t } = useI18nStore()
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    const text = preRef.current?.textContent ?? ''
    if (!text) return
    if (await copyText(text)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else {
      toast.error(t('copyFailedPlain'))
    }
  }

  return (
    <div className="group/code relative">
      <pre ref={preRef}>{children}</pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={t('copyCode')}
        className="absolute right-2 top-2 flex items-center gap-1 rounded border border-rule-control bg-raised px-1.5 py-1 type-caption text-ink-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/code:opacity-100 group-focus-within/code:opacity-100"
      >
        {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
        {copied ? t('copied') : t('copyCode')}
      </button>
    </div>
  )
}

const REMARK_PLUGINS = [remarkGfm]
const HIGHLIGHT_PLUGINS = [rehypeHighlight]
const NO_PLUGINS: [] = []

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
      anchorElement: event.currentTarget
    })
    if (!opened) toast.error(t('linkOpenFailed', { target: href ?? '' }))
  }

  return (
    <a href={href} title={href} onClick={(event) => void handleClick(event)}>
      {children}
    </a>
  )
}

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => <MarkdownAnchor href={href}>{children}</MarkdownAnchor>,
  code: ({ className, children }) => {
    const text = typeof children === 'string' ? children : String(children ?? '')
    if (!className && looksLikePath(text)) {
      return <PathCode value={text}>{children}</PathCode>
    }
    return <code className={className}>{children}</code>
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
}

/**
 * 流式期间按顶层块拆分 Markdown，只有正在增长的尾块需要重新解析。
 * 引用式链接等跨块定义在流式阶段可能不完整，结束时整体重渲染一次即可恢复。
 */
const MarkdownBlock = React.memo(
  function MarkdownBlock({ content }: { content: string }) {
    return (
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={NO_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    )
  },
  (prev, next) => prev.content === next.content
)

const StreamingBlocks = React.memo(function StreamingBlocks({ content }: { content: string }) {
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content])
  return (
    <>
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} content={block} />
      ))}
    </>
  )
})

/** 流式消息：解析降到低优先级，点击/输入可以先被处理，长输出不会堵住整个面板 */
export const StreamingMarkdown = React.memo(function StreamingMarkdown({
  content,
  showCursor = true,
}: {
  content: string
  showCursor?: boolean
}) {
  const deferred = useDeferredValue(content)
  return (
    <>
      <StreamingBlocks content={deferred} />
      {showCursor && (
        <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-text-bottom" />
      )}
    </>
  )
})

/** 已完成消息：整段解析一次，保留完整 GFM 与代码高亮 */
export const MarkdownBody = React.memo(function MarkdownBody({
  content,
  highlight,
}: {
  content: string
  highlight: boolean
}) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={highlight ? HIGHLIGHT_PLUGINS : NO_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  )
})
