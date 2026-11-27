import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Columns2, Rows3, X } from 'lucide-react'
import type * as MonacoNS from 'monaco-editor'
import { useDiffStore } from '../../store/diffStore'
import { useI18nStore } from '../../store/i18nStore'
import { useResolvedTheme } from '../../store/themeStore'
import { toast } from '../../store/toastStore'
import { computeDiff, DiffLineType, type DiffResult } from '../../api/diff'
import { useRevertEdits } from '../../hooks/useRevertEdits'
import { readThemeTokens, tokenHex } from '../../theme/tokens'
import { Button, IconButton, Spinner } from '../ui/ui'

type MonacoModule = typeof MonacoNS

const DIFF_LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  dockerfile: 'dockerfile',
  c: 'cpp',
  h: 'cpp',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  java: 'java',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  php: 'php',
  cs: 'csharp',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  toml: 'ini',
  properties: 'ini',
}

/** 与 MonacoEditor 保持一致的 25 种语言映射（独立维护以避免静态拉入 Monaco 主包） */
function detectDiffLanguage(filePath: string): string {
  const baseName = (filePath.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (!baseName) return 'plaintext'
  if (baseName === 'dockerfile' || baseName.startsWith('dockerfile.')) return 'dockerfile'
  if (baseName === '.env' || baseName.startsWith('.env.')) return 'ini'
  if (baseName === '.bashrc' || baseName === '.zshrc' || baseName === '.profile') return 'shell'
  const dotIndex = baseName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) return 'plaintext'
  return DIFF_LANGUAGE_BY_EXT[baseName.slice(dotIndex + 1)] || 'plaintext'
}

const DIFF_EDITOR_THEME = {
  paper: 'pi-paper',
  ink: 'pi-ink',
} as const

function buildDiffTheme(isDark: boolean): MonacoNS.editor.IStandaloneThemeData {
  const tokens = readThemeTokens(isDark)
  const color = (name: Parameters<typeof tokenHex>[1], alpha?: number): string =>
    tokenHex(tokens, name, alpha)

  return {
    base: isDark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: color('hl-comment').slice(1), fontStyle: 'italic' },
      { token: 'keyword', foreground: color('hl-keyword').slice(1) },
      { token: 'string', foreground: color('hl-string').slice(1) },
      { token: 'number', foreground: color('hl-number').slice(1) },
      { token: 'type', foreground: color('hl-type').slice(1) },
      { token: 'type.identifier', foreground: color('hl-type').slice(1) },
      { token: 'identifier', foreground: color('ink').slice(1) },
      { token: 'function', foreground: color('hl-function').slice(1) },
      { token: 'delimiter', foreground: color('ink-muted').slice(1) },
      { token: 'tag', foreground: color('hl-keyword').slice(1) },
      { token: 'attribute.name', foreground: color('hl-attr').slice(1) },
    ],
    colors: {
      'editor.background': color('surface'),
      'editor.foreground': color('ink'),
      'editorLineNumber.foreground': color('ink-subtle'),
      'editorLineNumber.activeForeground': color('ink-muted'),
      'editor.selectionBackground': color('accent', 0x24),
      'editor.inactiveSelectionBackground': color('ink', 0x12),
      'editor.lineHighlightBackground': color('ink', 0x09),
      'editorCursor.foreground': color('accent'),
      'editorIndentGuide.background1': color('ink', 0x14),
      'editorIndentGuide.activeBackground1': color('ink', 0x33),
      'editorWidget.background': color('panel'),
      'editorWidget.border': color('ink', 0x29),
      'scrollbarSlider.background': color('ink-subtle', 0x55),
      'scrollbarSlider.hoverBackground': color('ink-subtle', 0x88),
      'diffEditor.insertedTextBackground': color('success', isDark ? 0x2c : 0x24),
      'diffEditor.removedTextBackground': color('danger', isDark ? 0x2c : 0x24),
      'diffEditor.insertedLineBackground': color('success', isDark ? 0x18 : 0x14),
      'diffEditor.removedLineBackground': color('danger', isDark ? 0x18 : 0x14),
      'diffEditor.diagonalFill': color('ink', 0x10),
      'diffEditor.border': color('ink', 0x1f),
    },
  }
}

function defineDiffEditorThemes(monaco: MonacoModule): void {
  monaco.editor?.defineTheme?.(DIFF_EDITOR_THEME.paper, buildDiffTheme(false))
  monaco.editor?.defineTheme?.(DIFF_EDITOR_THEME.ink, buildDiffTheme(true))
}

async function loadMonaco(): Promise<MonacoModule> {
  // 确保语言 worker 在 DiffViewer 先于 MonacoEditor 打开时也能就绪
  await import('../../monacoEnvironment').catch(() => undefined)
  return import('monaco-editor')
}

export const DiffViewer: React.FC<{ workspacePath: string; active?: boolean }> = ({
  workspacePath,
  active = true,
}) => {
  const t = useI18nStore((state) => state.t)
  const resolvedTheme = useResolvedTheme()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const monacoRef = useRef<MonacoModule | null>(null)
  const diffEditorRef = useRef<MonacoNS.editor.IStandaloneDiffEditor | null>(null)
  const modelsRef = useRef<{
    original: MonacoNS.editor.ITextModel
    modified: MonacoNS.editor.ITextModel
  } | null>(null)

  const {
    edits,
    currentIndex,
    isOpen,
    clearDiff,
    setCurrentIndex,
    removeEdit,
  } = useDiffStore(workspacePath)
  const { busy, handleRevert, handleRevertAll } = useRevertEdits({
    workspacePath,
    onReverted: (target) => removeEdit(target.path),
  })

  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split')
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  const themeRef = useRef(resolvedTheme)
  themeRef.current = resolvedTheme

  const [editorStatus, setEditorStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  const edit = edits[currentIndex]
  const editPath = edit?.path
  const editOldContent = edit?.oldContent
  const editNewContent = edit?.newContent
  const diff = useMemo(
    () =>
      edit
        ? computeDiff(edit.oldContent, edit.newContent, `${edit.path}${t('diffBefore')}`, edit.path)
        : null,
    [edit, t]
  )

  const shouldRender = Boolean(isOpen && edit && diff)

  // 弹窗焦点管理与 Escape / Tab 键盘循环
  useEffect(() => {
    if (!isOpen || !active) return
    const previousFocus = document.activeElement as HTMLElement | null
    const raf = window.requestAnimationFrame(() => {
      const container = dialogRef.current
      if (!container || container.contains(document.activeElement)) return
      const first = container.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      ;(first ?? container).focus()
    })
    const onKeyDown = (event: KeyboardEvent) => {
      // 若确认撤销弹窗（DialogHost）等上层模态框已打开，不抢占其按键
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-diff-viewer])')) return
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        clearDiff()
        return
      }
      if (event.key === 'Tab') {
        const container = dialogRef.current
        if (!container) return
        const focusables = Array.from(
          container.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        )
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const activeEl = document.activeElement as HTMLElement | null
        if (event.shiftKey) {
          if (!activeEl || activeEl === first || !container.contains(activeEl)) {
            event.preventDefault()
            last.focus()
          }
        } else if (!activeEl || activeEl === last || !container.contains(activeEl)) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus()
      }
    }
  }, [isOpen, clearDiff, active])

  // 打开审阅弹窗时懒加载 Monaco 并创建 DiffEditor；关闭或卸载时先 setModel(null) 再释放 model 与实例
  useEffect(() => {
    if (!shouldRender) {
      setEditorStatus('loading')
      return
    }

    let cancelled = false
    setEditorStatus('loading')

    const detachAndDisposeModels = (editor: MonacoNS.editor.IStandaloneDiffEditor | null) => {
      const pair = modelsRef.current
      if (!pair) return
      modelsRef.current = null
      // 必须先解除 diffEditor 对 model 的引用，再 dispose，否则 Monaco 会抛出已释放 model 异常
      try {
        editor?.setModel(null)
      } catch {
        // 编辑器已释放时忽略
      }
      if (!pair.original.isDisposed?.()) pair.original.dispose()
      if (!pair.modified.isDisposed?.()) pair.modified.dispose()
    }

    void loadMonaco()
      .then((monaco) => {
        if (cancelled) return
        const container = containerRef.current
        if (!container || typeof monaco.editor?.createDiffEditor !== 'function') {
          setEditorStatus('error')
          return
        }
        defineDiffEditorThemes(monaco)
        const themeName =
          themeRef.current === 'dark' ? DIFF_EDITOR_THEME.ink : DIFF_EDITOR_THEME.paper
        monaco.editor.setTheme?.(themeName)

        const diffEditor = monaco.editor.createDiffEditor(container, {
          readOnly: true,
          originalEditable: false,
          renderSideBySide: viewModeRef.current === 'split',
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          renderIndicators: true,
          fontSize: 13.5,
          lineHeight: 22,
          fontFamily: '"Geist Mono Variable", "Geist Mono", "Noto Sans SC Variable", Consolas, monospace',
          unicodeHighlight: { ambiguousCharacters: false },
          padding: { top: 8 },
          theme: themeName,
        })
        monacoRef.current = monaco
        diffEditorRef.current = diffEditor
        setEditorStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setEditorStatus('error')
      })

    return () => {
      cancelled = true
      const editor = diffEditorRef.current
      detachAndDisposeModels(editor)
      diffEditorRef.current = null
      monacoRef.current = null
      editor?.dispose()
    }
  }, [shouldRender])

  // 切换审阅文件或内容变化时重建 original/modified model，先 setModel(null) 避免泄露
  useEffect(() => {
    if (
      editorStatus !== 'ready' ||
      editPath === undefined ||
      editOldContent === undefined ||
      editNewContent === undefined
    ) {
      return
    }
    const editor = diffEditorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return

    const prev = modelsRef.current
    if (prev) {
      modelsRef.current = null
      try {
        editor.setModel(null)
      } catch {
        // 忽略已释放场景
      }
      if (!prev.original.isDisposed?.()) prev.original.dispose()
      if (!prev.modified.isDisposed?.()) prev.modified.dispose()
    }

    const language = detectDiffLanguage(editPath)
    const original = monaco.editor.createModel(editOldContent, language)
    const modified = monaco.editor.createModel(editNewContent, language)
    modelsRef.current = { original, modified }
    editor.setModel({ original, modified })
  }, [editorStatus, editPath, editOldContent, editNewContent])

  // 同步并排 / 内联模式
  useEffect(() => {
    if (editorStatus !== 'ready') return
    diffEditorRef.current?.updateOptions({ renderSideBySide: viewMode === 'split' })
  }, [editorStatus, viewMode])

  // 同步 Paper & Ink 主题
  useEffect(() => {
    if (editorStatus !== 'ready' || !monacoRef.current) return
    defineDiffEditorThemes(monacoRef.current)
    monacoRef.current.editor.setTheme?.(
      resolvedTheme === 'dark' ? DIFF_EDITOR_THEME.ink : DIFF_EDITOR_THEME.paper
    )
  }, [editorStatus, resolvedTheme])

  if (!shouldRender || !edit || !diff) {
    return null
  }

  const canGoPrev = currentIndex > 0
  const canGoNext = currentIndex < edits.length - 1

  const handleKeep = () => {
    removeEdit(edit.path)
    toast.info(t('keptChanges'))
  }

  const handleClose = () => {
    clearDiff()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('reviewChanges')}
      data-diff-viewer="true"
      className="fixed inset-0 z-40 flex items-center justify-center p-6"
    >
      <div aria-hidden="true" className="absolute inset-0 bg-overlay/50" onClick={handleClose} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative flex h-[85vh] w-full max-w-6xl flex-col overflow-hidden border border-line bg-raised shadow-print focus:outline-none"
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-rule-divide px-4 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <h3 className="m-0 whitespace-nowrap type-label text-ink">
              {t('reviewChanges')}
            </h3>
            <span className="whitespace-nowrap border border-success/30 px-2 py-0.5 type-data text-success">
              +{diff.addedCount}
            </span>
            <span className="whitespace-nowrap border border-danger/30 px-2 py-0.5 type-data text-danger">
              -{diff.removedCount}
            </span>
            {edits.length > 1 && (
              <div className="flex items-center gap-1 type-caption text-ink-muted">
                <IconButton
                  icon={ChevronLeft}
                  label={t('previousFile')}
                  size="sm"
                  disabled={!canGoPrev || busy}
                  onClick={() => setCurrentIndex(currentIndex - 1)}
                />
                <span className="whitespace-nowrap">
                  {currentIndex + 1} / {edits.length}
                </span>
                <IconButton
                  icon={ChevronRight}
                  label={t('nextFile')}
                  size="sm"
                  disabled={!canGoNext || busy}
                  onClick={() => setCurrentIndex(currentIndex + 1)}
                />
              </div>
            )}
          </div>

          <div className="flex flex-shrink-0 items-center gap-2">
            <div className="flex items-center gap-0.5 border border-rule-control bg-sunken p-0.5">
              <button
                type="button"
                onClick={() => setViewMode('split')}
                title={t('splitView')}
                aria-pressed={viewMode === 'split'}
                className={`flex items-center gap-1.5 px-2 py-1 type-label font-normal transition-colors ${
                  viewMode === 'split'
                    ? 'bg-raised text-ink'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                <Columns2 size={13} />
                {t('splitView')}
              </button>
              <button
                type="button"
                onClick={() => setViewMode('unified')}
                title={t('unifiedView')}
                aria-pressed={viewMode === 'unified'}
                className={`flex items-center gap-1.5 px-2 py-1 type-label font-normal transition-colors ${
                  viewMode === 'unified'
                    ? 'bg-raised text-ink'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                <Rows3 size={13} />
                {t('unifiedView')}
              </button>
            </div>

            <Button size="sm" icon={Check} disabled={busy} onClick={handleKeep}>
              {t('keepChanges')}
            </Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void handleRevert(edit)}>
              {t('revertFile')}
            </Button>
            {edits.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                className="text-danger hover:bg-danger/10 hover:text-danger"
                onClick={() => void handleRevertAll(edits)}
              >
                {t('revertAll')}
              </Button>
            )}

            <IconButton icon={X} label={t('close')} size="sm" onClick={handleClose} />
          </div>
        </div>

        {/* Hint */}
        <div className="flex-shrink-0 border-b border-rule-divide px-4 py-1.5 type-caption text-ink-muted">
          {t('reviewHint')}
        </div>

        {/* File Path Subheader */}
        {viewMode === 'split' ? (
          <div className="flex flex-shrink-0 divide-x divide-rule-divide border-b border-rule-divide bg-panel">
            <div className="flex min-w-0 flex-1 items-center justify-between px-3 py-1.5">
              <span className="truncate type-data text-ink">{diff.originalFile}</span>
              <span className="px-1.5 py-0.5 type-data text-danger">-{diff.removedCount}</span>
            </div>
            <div className="flex min-w-0 flex-1 items-center justify-between px-3 py-1.5">
              <span className="truncate type-data text-ink">{diff.modifiedFile}</span>
              <span className="px-1.5 py-0.5 type-data text-success">+{diff.addedCount}</span>
            </div>
          </div>
        ) : (
          <div className="flex flex-shrink-0 items-center justify-center gap-2 border-b border-rule-divide bg-panel px-3 py-1.5">
            <span className="truncate type-data text-ink-muted">{diff.originalFile}</span>
            <span className="text-ink-muted">→</span>
            <span className="truncate type-data text-ink">{diff.modifiedFile}</span>
          </div>
        )}

        {/* Monaco DiffEditor Surface */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-surface">
          {editorStatus === 'error' ? (
            <FallbackDiffView diff={diff} />
          ) : (
            <>
              <div
                ref={containerRef}
                data-testid="monaco-diff-container"
                className="min-h-0 min-w-0 flex-1"
              />
              {editorStatus === 'loading' && (
                <div
                  data-testid="monaco-diff-loading"
                  className="absolute inset-0 flex items-center justify-center bg-surface"
                >
                  <Spinner />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Monaco 无法初始化时的轻量只读 Paper & Ink 文本回退视图 */
const FallbackDiffView: React.FC<{ diff: DiffResult }> = ({ diff }) => {
  return (
    <div data-testid="diff-fallback-view" className="min-h-0 flex-1 overflow-auto bg-surface">
      {diff.lines.map((line, index) => {
        const bgClass =
          line.type === DiffLineType.Added
            ? 'bg-success/10'
            : line.type === DiffLineType.Removed
              ? 'bg-danger/10'
              : 'bg-surface'
        const prefix =
          line.type === DiffLineType.Added
            ? '+'
            : line.type === DiffLineType.Removed
              ? '-'
              : ' '
        const prefixClass =
          line.type === DiffLineType.Added
            ? 'text-success'
            : line.type === DiffLineType.Removed
              ? 'text-danger'
              : 'text-ink-muted'
        const lineNumber =
          line.type === DiffLineType.Added ? line.modifiedLineNumber : line.originalLineNumber

        return (
          <div
            key={index}
            className={`flex items-center border-b border-rule-divide py-0.5 type-code ${bgClass}`}
          >
            <span className={`w-6 flex-shrink-0 select-none text-center ${prefixClass}`}>
              {prefix}
            </span>
            <span className="w-10 flex-shrink-0 select-none pr-2 text-right text-ink-muted">
              {lineNumber ?? '-'}
            </span>
            <span className="flex-1 whitespace-pre px-2 text-ink">{line.content}</span>
          </div>
        )
      })}
    </div>
  )
}
