/**
 * 三端共享的流式 Markdown 核心视图（Streamdown v2 + Remend 语法自愈 + Shiki 纯 JS 高亮 + CJK + KaTeX + Mermaid）。
 *
 * 刻意不引入 Electron / api / workspaceStore：
 * - 桌面端由 `AgentMarkdown.tsx` 包装，注入工作区路径跳转（PathCode）与主进程外链打开；
 * - 云端 Web 直接复用本组件，彻底避免把桌面端状态与 mock 层打进 Web 静态包。
 */

import React, { useEffect, useMemo, useState } from 'react'
import {
  Streamdown,
  defaultComponents,
  defaultRehypePlugins,
  type Components,
  type ControlsConfig,
  type MermaidOptions,
  type PluginConfig,
  type PortalTarget,
  type StreamdownTranslations,
} from 'streamdown'
import 'streamdown/styles.css'
import 'katex/dist/katex.min.css'
import { cjk } from '@streamdown/cjk'
import { createMathPlugin } from '@streamdown/math'
import { PI_SHIKI_THEMES, piShikiCodePlugin } from '../../utils/shikiHighlighter'

const mathPlugin = createMathPlugin({ singleDollarTextMath: true })

const CODE_PLUGINS: PluginConfig = {
  code: piShikiCodePlugin,
  cjk,
  math: mathPlugin,
}

const LIGHT_PLUGINS: PluginConfig = {
  cjk,
  math: mathPlugin,
}

const MERMAID_FENCE_RE = /(?:^|\n)[ \t]{0,3}(?:```+|~~~+)[ \t]*mermaid\b/i

let cachedMermaidPlugin: PluginConfig['mermaid'] | null = null
let mermaidLoadPromise: Promise<PluginConfig['mermaid'] | null> | null = null

/** 按需动态加载 @streamdown/mermaid（含 mermaid/cytoscape/d3 重依赖），非图表消息不进入首屏包 */
function loadMermaidPlugin(): Promise<PluginConfig['mermaid'] | null> {
  if (cachedMermaidPlugin) return Promise.resolve(cachedMermaidPlugin)
  if (!mermaidLoadPromise) {
    mermaidLoadPromise = import('@streamdown/mermaid')
      .then((mod) => {
        cachedMermaidPlugin = mod.createMermaidPlugin()
        return cachedMermaidPlugin
      })
      .catch((err) => {
        console.error('[StreamdownView] Failed to load @streamdown/mermaid:', err)
        mermaidLoadPromise = null
        return null
      })
  }
  return mermaidLoadPromise
}

/**
 * 保留 raw + sanitize + undoubleClobberPrefix，刻意跳过 rehype-harden：
 * 桌面端 Markdown 需要支持仓库相对路径链接（如 `[file](src/a.ts)`）与页内 `#anchor`，
 * rehype-harden 会把相对路径判成 Blocked URL；所有链接安全性由 rehype-sanitize 与自定义 Anchor 共同兜底。
 */
const SAFE_REHYPE_PLUGINS = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.undoubleClobberPrefix,
]

const SAFE_WEB_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function isSafeExternalHref(href: string | undefined): boolean {
  if (!href) return false
  try {
    const parsed = new URL(href, 'https://pi-cloud.invalid')
    return SAFE_WEB_PROTOCOLS.has(parsed.protocol)
  } catch {
    return false
  }
}

/** Web 模式默认链接组件：拒绝 javascript:/data: 等危险协议，安全外链新标签打开 */
const WebSafeAnchor: Components['a'] = ({ href, children }) => {
  if (!isSafeExternalHref(href)) {
    return <span>{children}</span>
  }
  return (
    <a href={href} title={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

const STREAMDOWN_ZH: Partial<StreamdownTranslations> = {
  close: '关闭',
  copied: '已复制',
  copyCode: '复制',
  copyLink: '复制链接',
  copyTable: '复制表格',
  copyTableAsCsv: '复制为 CSV',
  copyTableAsMarkdown: '复制为 Markdown',
  copyTableAsTsv: '复制为 TSV',
  downloadDiagram: '下载图表',
  downloadDiagramAsMmd: '下载 .mmd',
  downloadDiagramAsPng: '下载 PNG',
  downloadDiagramAsSvg: '下载 SVG',
  downloadFile: '下载文件',
  downloadImage: '下载图片',
  downloadTable: '下载表格',
  downloadTableAsCsv: '下载 CSV',
  downloadTableAsMarkdown: '下载 Markdown',
  errorMermaid: 'Mermaid 图表渲染失败',
  exitFullscreen: '退出全屏',
  externalLinkWarning: '即将打开外部链接',
  imageNotAvailable: '图片不可用',
  mermaidAriaLabel: 'Mermaid 图表',
  openExternalLink: '打开外部链接',
  openLink: '打开链接',
  resetView: '重置视图',
  viewFullscreen: '全屏查看',
  zoomIn: '放大',
  zoomOut: '缩小',
}

const DEFAULT_CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: false },
  mermaid: { copy: true, download: true, fullscreen: true, panZoom: true },
  image: { download: false },
}

const MERMAID_OPTIONS: MermaidOptions = {
  config: {
    securityLevel: 'strict',
    startOnLoad: false,
    theme: 'neutral',
  },
}

export interface StreamdownViewProps {
  content: string
  /** 是否处于流式输出中；为 true 时启用 remend 尾部语法自愈与块级冻结 */
  isStreaming?: boolean
  /** 流式期间是否展示末尾脉冲光标 */
  showCursor?: boolean
  /** 是否开启代码高亮与 Mermaid 图表（思考过程或超长只读文档可关闭） */
  highlight?: boolean
  /** 界面语言（用于内置复制/缩放/全屏控件本地化） */
  language?: 'zh' | 'en'
  /** 覆盖特定 Markdown 元素（桌面端注入 PathCode 与主进程链接处理） */
  components?: Components
  /** 弹层挂载目标（Electron 独立拆窗场景传入 hostDocument.body） */
  portal?: PortalTarget
  className?: string
}

export const StreamdownView = React.memo(function StreamdownView({
  content,
  isStreaming = false,
  showCursor = true,
  highlight = true,
  language = 'zh',
  components,
  portal,
  className,
}: StreamdownViewProps) {
  const mergedComponents = useMemo<Components>(
    () => ({
      a: WebSafeAnchor,
      // Streamdown 默认把 strong 渲染成 span；还原语义 <strong> 兼顾无障碍与既有排版选择器
      strong: ({ children }) => (
        <strong data-streamdown="strong" className="font-semibold">
          {children}
        </strong>
      ),
      ...components,
    }),
    [components]
  )

  const needsMermaid = highlight && MERMAID_FENCE_RE.test(content)
  const [mermaidPlugin, setMermaidPlugin] = useState<PluginConfig['mermaid'] | null>(() =>
    needsMermaid ? cachedMermaidPlugin : null
  )

  useEffect(() => {
    if (!needsMermaid) return
    if (cachedMermaidPlugin) {
      setMermaidPlugin((current) => current ?? cachedMermaidPlugin)
      return
    }
    let cancelled = false
    void loadMermaidPlugin().then((plugin) => {
      if (!cancelled && plugin) setMermaidPlugin(plugin)
    })
    return () => {
      cancelled = true
    }
  }, [needsMermaid])

  const plugins = useMemo<PluginConfig>(() => {
    if (!highlight) return LIGHT_PLUGINS
    if (needsMermaid && mermaidPlugin) {
      return {
        code: piShikiCodePlugin,
        cjk,
        math: mathPlugin,
        mermaid: mermaidPlugin,
      }
    }
    return CODE_PLUGINS
  }, [highlight, needsMermaid, mermaidPlugin])

  return (
    <div className={className}>
      <Streamdown
        mode={isStreaming ? 'streaming' : 'static'}
        isAnimating={isStreaming}
        parseIncompleteMarkdown={isStreaming}
        plugins={plugins}
        rehypePlugins={SAFE_REHYPE_PLUGINS}
        shikiTheme={PI_SHIKI_THEMES}
        mermaid={MERMAID_OPTIONS}
        controls={DEFAULT_CONTROLS}
        linkSafety={{ enabled: false }}
        lineNumbers={false}
        codeBlockMaxHeight={0}
        components={mergedComponents}
        translations={language === 'zh' ? STREAMDOWN_ZH : undefined}
        portal={portal}
      >
        {content}
      </Streamdown>
      {isStreaming && showCursor && (
        <span
          aria-hidden="true"
          className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-text-bottom"
        />
      )}
    </div>
  )
})

export { defaultComponents }
