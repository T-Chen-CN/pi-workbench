import React, { useDeferredValue, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import { useI18nStore } from '../store/i18nStore'
import { useWorkspaceScope } from '../workspace/WorkspaceScope'
import { useWorkspaceStore } from '../store/workspaceStore'
import { editorStoreFor } from '../store/editorStore'
import { api } from '../api'
import { splitMarkdownBlocks } from '../utils/markdownBlocks'
import { looksLikePath, splitPathLine } from '../utils/filePath'

/** 点击文件路径打开编辑器（相对路径按当前工作区解析） */
const PathCode: React.FC<{ value: string; children: React.ReactNode }> = ({
  value,
  children,
}) => {
  const scopeWorkspace = useWorkspaceScope()
  const open = async () => {
    const workspace = scopeWorkspace ?? useWorkspaceStore.getState().workspacePath
    if (!workspace) return
    const { path: filePart, line } = splitPathLine(value)
    const target = /^[A-Za-z]:[\\/]/.test(filePart) || filePart.startsWith('/')
      ? filePart
      : `${workspace}/${filePart}`
    try {
      const exists = await api.exists(target)
      if (!exists.success || !exists.exists) return
      const file = await api.readFile(target)
      if (!file.success || typeof file.content !== 'string') return
      const store = editorStoreFor(workspace)
      store.getState().addOpenFile({
        path: target,
        name: target.split(/[\\/]/).pop() || target,
        content: file.content,
        isDirty: false,
        isSaving: false,
      })
      // 带行号时滚动到该行并高亮（R-09）
      if (line) store.getState().revealLine(target, line)
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
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      console.error('Failed to copy code:', error)
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

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
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
