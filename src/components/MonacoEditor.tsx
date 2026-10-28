import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import '../monacoEnvironment'
import * as monaco from 'monaco-editor'
import { X } from 'lucide-react'
import { useEditorStore, editorStoreFor } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { useSelectionStore } from '../store/selectionStore'
import { useResolvedTheme } from '../store/themeStore'
import type { OpenFile } from '../types'
import { readThemeTokens, tokenHex } from '../theme/tokens'
import { detectLargeFile, type LargeFileInfo } from '../utils/largeFile'

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
}

function detectLanguage(fileName: string): string {
  const extension = fileName.split('.').pop() || 'txt'
  return LANGUAGE_BY_EXTENSION[extension] || 'plaintext'
}

const EDITOR_THEME = {
  paper: 'pi-paper',
  ink: 'pi-ink',
} as const

function buildEditorTheme(isDark: boolean): monaco.editor.IStandaloneThemeData {
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
      'editorSuggestWidget.background': color('panel'),
      'editorSuggestWidget.border': color('ink', 0x29),
      'editorSuggestWidget.selectedBackground': color('hover'),
      'scrollbarSlider.background': color('ink-subtle', 0x55),
      'scrollbarSlider.hoverBackground': color('ink-subtle', 0x88),
    },
  }
}

function defineEditorThemes(): void {
  monaco.editor.defineTheme(EDITOR_THEME.paper, buildEditorTheme(false))
  monaco.editor.defineTheme(EDITOR_THEME.ink, buildEditorTheme(true))
}

/**
 * 源码视图（Monaco）。
 *
 * 保存、自动保存、草稿与外部变更同步由 `useFileDocument` 统一负责：
 * 这里只维护 model 缓存（切换标签保留撤销栈、光标与滚动）、主题、选区上报
 * 与大文件模式。Markdown / HTML 的阅读视图由 FileView 叠加在上层。
 */
export const MonacoEditor: React.FC<{
  workspacePath: string
  viewRoot?: string
  active?: boolean
}> = ({ workspacePath, viewRoot, active = true }) => {
  const root = viewRoot ?? workspacePath
  const store = editorStoreFor(root)
  const { t } = useI18nStore()
  const resolvedTheme = useResolvedTheme()
  const editorRef = useRef<HTMLDivElement>(null)
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const { currentFile, openFiles, pendingReveal, consumeReveal } = useEditorStore(root)
  // 每个文件一个 model：切换标签时保留撤销栈、光标与滚动位置
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map())
  const viewStatesRef = useRef<Map<string, monaco.editor.ICodeEditorViewState | null>>(new Map())
  const activePathRef = useRef<string | null>(null)
  // 程序化 setValue 时抑制内容变化回调，避免误标脏 + 自动保存回环
  const suppressChangeRef = useRef(false)
  const [editorReady, setEditorReady] = useState(false)
  const [largeFile, setLargeFile] = useState<LargeFileInfo | null>(null)
  const [largeBannerDismissed, setLargeBannerDismissed] = useState(false)
  const largePathRef = useRef<string | null>(null)
  const selectionSubRef = useRef<{ dispose: () => void } | null>(null)

  // 在创建编辑器前注册主题（颜色从 Paper & Ink 的 CSS token 读取）
  useLayoutEffect(() => {
    defineEditorThemes()
  }, [])

  const getOrCreateModel = useCallback((file: OpenFile): monaco.editor.ITextModel => {
    const existing = modelsRef.current.get(file.path)
    if (existing) {
      if (existing.getValue() !== file.content) {
        suppressChangeRef.current = true
        existing.setValue(file.content)
        suppressChangeRef.current = false
      }
      return existing
    }

    const uri = monaco.Uri.file(file.path)
    const model =
      monaco.editor.getModel(uri) ??
      monaco.editor.createModel(file.content, detectLanguage(file.name), uri)
    modelsRef.current.set(file.path, model)
    return model
  }, [])

  // 打开首个文件时创建编辑器；关闭全部文件后释放。容器随 currentFile 一起挂载。
  useEffect(() => {
    if (!currentFile) {
      if (monacoRef.current) {
        monacoRef.current.dispose()
        monacoRef.current = null
        setEditorReady(false)
      }
      return
    }

    if (monacoRef.current || !editorRef.current) return

    const model = getOrCreateModel(currentFile)
    activePathRef.current = currentFile.path
    const editor = monaco.editor.create(editorRef.current, {
      model,
      language: detectLanguage(currentFile.name),
      theme: resolvedTheme === 'dark' ? EDITOR_THEME.ink : EDITOR_THEME.paper,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13.5,
      lineHeight: 22,
      fontFamily: '"Geist Mono Variable", "Geist Mono", "Noto Sans SC Variable", Consolas, monospace',
      lineNumbers: 'on',
      wordWrap: 'on',
      // 中文正文里的全角标点会被默认的“易混字符”检查框成黄色方块，噪音大于收益
      unicodeHighlight: { ambiguousCharacters: false },
      padding: { top: 10 },
    })
    monacoRef.current = editor

    // 同步当前选区，供聊天面板附加片段
    selectionSubRef.current?.dispose()
    selectionSubRef.current = editor.onDidChangeCursorSelection(() => {
      const file = store.getState().currentFile
      const editorModel = editor.getModel()
      const range = editor.getSelection()
      if (!file || !editorModel || !range) {
        useSelectionStore.getState().clearSelection()
        return
      }
      const empty =
        range.startLineNumber === range.endLineNumber &&
        range.startColumn === range.endColumn
      if (empty) {
        useSelectionStore.getState().clearSelection()
        return
      }
      const endLine =
        range.endColumn === 1 && range.endLineNumber > range.startLineNumber
          ? range.endLineNumber - 1
          : range.endLineNumber
      useSelectionStore.getState().setSelection({
        path: file.path,
        name: file.name,
        startLine: range.startLineNumber,
        endLine,
        text: editorModel.getValueInRange(range),
      })
    })

    setEditorReady(true)
  }, [currentFile, resolvedTheme, getOrCreateModel, store])

  // 主题切换时重新读取 token 并更新编辑器配色
  useEffect(() => {
    defineEditorThemes()
    monaco.editor.setTheme(resolvedTheme === 'dark' ? EDITOR_THEME.ink : EDITOR_THEME.paper)
  }, [resolvedTheme])

  // 切换文件时检测一次大文件模式；编辑过程中不再重算，避免模式来回切换
  useEffect(() => {
    if (!currentFile) {
      largePathRef.current = null
      setLargeFile(null)
      setLargeBannerDismissed(false)
      return
    }
    if (largePathRef.current === currentFile.path) return
    largePathRef.current = currentFile.path
    const info = detectLargeFile(currentFile.content)
    setLargeFile(info.mode === 'normal' ? null : info)
    setLargeBannerDismissed(false)
  }, [currentFile])

  // 大文件模式：关闭换行 / 折叠，超大文件只读
  useEffect(() => {
    const editor = monacoRef.current
    if (!editor) return
    const large = largeFile !== null
    editor.updateOptions({
      wordWrap: large ? 'off' : 'on',
      folding: !large,
      occurrencesHighlight: large ? 'off' : 'singleFile',
      readOnly: largeFile?.mode === 'readonly',
    })
  }, [largeFile, editorReady])

  // 切换文件后清掉不属于当前文件的选区
  useEffect(() => {
    useSelectionStore.getState().clearForPath(currentFile?.path ?? '')
  }, [currentFile?.path])

  // 组件卸载时释放编辑器与所有 model
  useEffect(() => {
    const models = modelsRef.current
    const viewStates = viewStatesRef.current
    return () => {
      selectionSubRef.current?.dispose()
      selectionSubRef.current = null
      useSelectionStore.getState().clearSelection()
      monacoRef.current?.dispose()
      monacoRef.current = null
      for (const model of models.values()) {
        model.dispose()
      }
      models.clear()
      viewStates.clear()
    }
  }, [])

  // 切换当前文件：保存上一个文件的视图状态，并切换到它自己的 model
  useEffect(() => {
    const editor = monacoRef.current
    if (!editor || !currentFile) return

    const previousPath = activePathRef.current
    if (previousPath && previousPath !== currentFile.path) {
      viewStatesRef.current.set(previousPath, editor.saveViewState())
    }

    const model = getOrCreateModel(currentFile)
    if (editor.getModel() !== model) {
      editor.setModel(model)
      editor.restoreViewState(viewStatesRef.current.get(currentFile.path) ?? null)
    }
    monaco.editor.setModelLanguage(model, detectLanguage(currentFile.name))
    activePathRef.current = currentFile.path
  }, [currentFile, editorReady, getOrCreateModel])

  // 打开带行号的路径后滚动到该行并高亮（R-09）
  useEffect(() => {
    const editor = monacoRef.current
    if (!editor || !pendingReveal || !currentFile || pendingReveal.path !== currentFile.path) {
      return
    }
    const model = editor.getModel()
    const lineCount = model?.getLineCount() ?? pendingReveal.line
    const line = Math.max(1, Math.min(pendingReveal.line, lineCount))
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column: 1 })
    editor.focus()
    consumeReveal()
  }, [pendingReveal, currentFile, editorReady, consumeReveal])

  // 标签关闭后释放对应 model，避免撤销栈和内容长期占用内存
  useEffect(() => {
    const openPaths = new Set(openFiles.map((file) => file.path))
    for (const [filePath, model] of [...modelsRef.current.entries()]) {
      if (!openPaths.has(filePath)) {
        model.dispose()
        modelsRef.current.delete(filePath)
        viewStatesRef.current.delete(filePath)
      }
    }
  }, [openFiles])

  // 容器尺寸变化时重新布局（编辑器可能在面板尺寸或可见性变化时创建 / 恢复）
  useEffect(() => {
    if (!editorReady) return
    const editor = monacoRef.current
    const container = editorRef.current
    if (!editor || !container) return

    const layout = () => editor.layout()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(layout) : null
    observer?.observe(container)
    window.addEventListener('resize', layout)
    const timer = setTimeout(layout, 50)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', layout)
      clearTimeout(timer)
    }
  }, [editorReady])

  // 内容变化只更新 store：保存 / 草稿由 useFileDocument 统一调度
  useEffect(() => {
    if (!editorReady || !monacoRef.current) return
    const editor = monacoRef.current
    const subscription = editor.onDidChangeModelContent(() => {
      if (suppressChangeRef.current) return
      const file = store.getState().currentFile
      if (!file) return
      const nextContent = editor.getValue()
      if (nextContent === file.content) return
      store.getState().updateOpenFile(file.path, { content: nextContent })
      store.getState().markDirty(file.path)
    })
    return () => subscription.dispose()
  }, [editorReady, store])

  // 隐藏期间尺寸不变；回到前台时补一次布局，避免 Monaco 使用过期尺寸
  useEffect(() => {
    if (active && editorReady) monacoRef.current?.layout()
  }, [active, editorReady])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {largeFile && !largeBannerDismissed && (
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-rule-divide bg-panel px-3 py-1 type-caption text-ink-muted">
          <span>
            {t(largeFile.mode === 'readonly' ? 'largeFileReadOnly' : 'largeFileMode', {
              size: `${(largeFile.bytes / 1024 / 1024).toFixed(1)} MB`,
              lines: largeFile.lines.toLocaleString(),
            })}
          </span>
          <button
            type="button"
            aria-label={t('close')}
            title={t('close')}
            className="p-0.5 text-ink-muted hover:text-ink"
            onClick={() => setLargeBannerDismissed(true)}
          >
            <X size={11} />
          </button>
        </div>
      )}
      <div ref={editorRef} className="min-h-0 min-w-0 flex-1" />
    </div>
  )
}
