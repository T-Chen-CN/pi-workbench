import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import '../monacoEnvironment'
import * as monaco from 'monaco-editor'
import { FileCode, Loader2, X } from 'lucide-react'
import { useEditorStore, editorStoreFor } from '../store/editorStore'
import { useSettingsStore } from '../store/settingsStore'
import { useI18nStore } from '../store/i18nStore'
import { useSelectionStore } from '../store/selectionStore'
import { useResolvedTheme } from '../store/themeStore'
import { localizeError } from '../i18n/errors'
import { api } from '../api'
import { toast } from '../store/toastStore'
import { confirmDialog } from '../store/dialogStore'
import type { OpenFile } from '../types'
import { EmptyState } from './ui'
import { readThemeTokens, tokenHex } from '../theme/tokens'
import { detectLargeFile, type LargeFileInfo } from '../utils/largeFile'

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  html: 'html',
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
  const {
    currentFile,
    openFiles,
    updateOpenFile,
    markClean,
    removeOpenFile,
    pendingReveal,
    consumeReveal,
  } = useEditorStore(root)
  const saveTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())
  const draftTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())
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

  const clearFileTimers = useCallback((filePath: string): void => {
    const pendingSave = saveTimersRef.current.get(filePath)
    if (pendingSave) {
      clearTimeout(pendingSave)
      saveTimersRef.current.delete(filePath)
    }
    const pendingDraft = draftTimersRef.current.get(filePath)
    if (pendingDraft) {
      clearTimeout(pendingDraft)
      draftTimersRef.current.delete(filePath)
    }
  }, [])

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
    monacoRef.current = monaco.editor.create(editorRef.current, {
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
      padding: { top: 10 },
    })

    // 同步当前选区，供聊天面板附加片段
    selectionSubRef.current?.dispose()
    selectionSubRef.current = monacoRef.current.onDidChangeCursorSelection(() => {
      const editor = monacoRef.current
      const file = store.getState().currentFile
      const editorModel = editor?.getModel()
      const range = editor?.getSelection()
      if (!editor || !file || !editorModel || !range) {
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
    const active = largeFile !== null
    editor.updateOptions({
      wordWrap: active ? 'off' : 'on',
      folding: !active,
      occurrencesHighlight: active ? 'off' : 'singleFile',
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

  // 容器尺寸变化时重新布局（编辑器可能在面板尺寸为 0 时创建）
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

  // 外部文件变化：所有已打开文件（含后台标签页）都同步磁盘内容；被外部删除时关闭标签
  useEffect(() => {
    const unsubscribe = api.onFsChanged(async (payload) => {
      const state = store.getState()
      const target = state.openFiles.find((file) => file.path === payload.path)
      if (!target) return

      const existsResult = await api.exists(payload.path)
      if (existsResult.success && existsResult.exists === false) {
        clearFileTimers(payload.path)
        void api.draftDelete(workspacePath, payload.path).catch(() => undefined)
        state.removeOpenFile(payload.path)
        toast.info(t('fileRemoved', { name: target.name }))
        return
      }

      if (target.isDirty) return

      const result = await api.readFile(payload.path)
      if (result.success && typeof result.content === 'string' && result.content !== target.content) {
        state.updateOpenFile(payload.path, { content: result.content })
        state.markClean(payload.path)
      }
    })

    return unsubscribe
  }, [clearFileTimers, t, store, workspacePath])

  const saveFile = useCallback(
    async (pathOverride?: string) => {
      const targetPath = pathOverride ?? store.getState().currentFile?.path
      if (!targetPath) return

      // 手动保存时取消该文件尚未触发的自动保存，避免重复写入
      const pendingSave = saveTimersRef.current.get(targetPath)
      if (pendingSave) {
        clearTimeout(pendingSave)
        saveTimersRef.current.delete(targetPath)
      }

      // 从 store 读取最新内容，避免闭包中的旧快照导致写回旧内容
      const latest = store.getState().openFiles.find((file) => file.path === targetPath)
      if (!latest) return

      const contentToSave = latest.content

      try {
        updateOpenFile(targetPath, { isSaving: true })
        const result = await api.writeFile(targetPath, contentToSave)
        if (!result.success) {
          throw new Error(result.error || 'Failed to save file')
        }

        // 写入期间用户可能继续输入：只有内容没再变化时才标记为已保存
        const afterSave = store.getState().openFiles.find((file) => file.path === targetPath)
        const changedDuringSave = Boolean(afterSave && afterSave.content !== contentToSave)

        if (changedDuringSave) {
          if (afterSave) {
            void api.draftSave(workspacePath, targetPath, afterSave.content).catch(() => undefined)
          }
        } else {
          const draftTimer = draftTimersRef.current.get(targetPath)
          if (draftTimer) {
            clearTimeout(draftTimer)
            draftTimersRef.current.delete(targetPath)
          }
          markClean(targetPath)
          // 文件已落盘，删除对应的崩溃恢复草稿
          if (workspacePath) {
            void api.draftDelete(workspacePath, targetPath).catch(() => undefined)
          }
        }

        updateOpenFile(targetPath, { isSaving: false })
        toast.success(t('savedFile', { name: latest.name }), 2000)
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.error('Failed to save file:', error)
        toast.error(t('saveFileFailed', { error: localizeError(errorMsg) }))
        updateOpenFile(targetPath, { isSaving: false })
      }
    },
    [updateOpenFile, markClean, t, store, workspacePath]
  )

  // 监听编辑器内容变化：自动保存的防抖计时器独立于 currentFile，
  // 切换文件不会清掉尚未触发的保存。
  useEffect(() => {
    if (!editorReady || !monacoRef.current) return

    const editor = monacoRef.current
    const saveTimers = saveTimersRef.current
    const draftTimers = draftTimersRef.current
    const subscription = editor.onDidChangeModelContent(() => {
      if (suppressChangeRef.current) return

      const state = store.getState()
      const file = state.currentFile
      if (!file) return

      const newContent = editor.getValue()
      state.updateOpenFile(file.path, { content: newContent })
      state.markDirty(file.path)

      // 崩溃恢复：内容变化后把未保存内容落到 cache/drafts（正常保存后删除）
      if (workspacePath) {
        const pendingDraft = draftTimers.get(file.path)
        if (pendingDraft) clearTimeout(pendingDraft)
        draftTimers.set(
          file.path,
          setTimeout(() => {
            draftTimers.delete(file.path)
            void api.draftSave(workspacePath, file.path, newContent).catch(() => undefined)
          }, 500)
        )
      }

      // 自动保存计时器按文件独立，切换文件不会取消其他文件待触发的保存
      const pendingSave = saveTimers.get(file.path)
      if (pendingSave) clearTimeout(pendingSave)
      const { autoSave, autoSaveDelay } = useSettingsStore.getState()
      if (autoSave) {
        saveTimers.set(
          file.path,
          setTimeout(() => {
            saveTimers.delete(file.path)
            if (useSettingsStore.getState().autoSave) {
              void saveFile(file.path)
            }
          }, autoSaveDelay)
        )
      }
    })

    return () => {
      subscription.dispose()

      for (const timer of saveTimers.values()) {
        clearTimeout(timer)
      }
      saveTimers.clear()

      // 卸载前把各文件最后的未保存内容补成草稿
      for (const [filePath, timer] of draftTimers) {
        clearTimeout(timer)
        if (!workspacePath) continue
        const file = store.getState().openFiles.find((item) => item.path === filePath)
        if (file?.isDirty) {
          void api.draftSave(workspacePath, filePath, file.content).catch(() => undefined)
        }
      }
      draftTimers.clear()
    }
  }, [editorReady, saveFile, store, workspacePath])

  const handleSave = useCallback(
    async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        await saveFile()
      }
    },
    [saveFile]
  )

  useEffect(() => {
    if (!active) return
    window.addEventListener('keydown', handleSave)
    return () => window.removeEventListener('keydown', handleSave)
  }, [handleSave, active])

  // 隐藏期间尺寸不变；回到前台时补一次布局，避免 Monaco 使用过期尺寸
  useEffect(() => {
    if (active && editorReady) monacoRef.current?.layout()
  }, [active, editorReady])

  if (!currentFile) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface">
        <EmptyState icon={FileCode} title={t('noFileOpen')} description={t('selectFileToEdit')} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex flex-shrink-0 items-stretch overflow-x-auto border-b border-rule-divide bg-panel">
        {openFiles.map((file) => {
          const active = currentFile?.path === file.path
          return (
            <div
              key={file.path}
              className={`group flex h-[34px] items-center gap-2 border-r border-rule-divide pl-3 pr-1.5 type-label transition-colors ${
                active
                  ? 'bg-surface text-ink shadow-[inset_0_2px_0_rgb(var(--accent))]'
                  : 'text-ink-muted hover:bg-hover hover:text-ink'
              }`}
            >
              <button
                type="button"
                className="flex max-w-[220px] items-center gap-1.5 bg-transparent text-inherit"
                title={file.path}
                onClick={() => store.setState({ currentFile: file })}
              >
                <FileCode size={12} className={active ? 'text-accent' : 'text-ink-muted'} />
                <span className="truncate">{file.name}</span>
                {file.isDirty && (
                  <span
                    className="h-1 w-1 flex-shrink-0 rounded-full bg-accent"
                    title={t('unsavedChanges')}
                  />
                )}
                {file.isSaving && <Loader2 size={10} className="animate-spin text-ink-muted" />}
              </button>
              <button
                type="button"
                className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-ink-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={t('close')}
                title={t('close')}
                onClick={async () => {
                  const target = store.getState().openFiles.find((f) => f.path === file.path)
                  if (
                    target?.isDirty &&
                    !(await confirmDialog({
                      message: t('discardChangesConfirm'),
                      danger: true,
                    }))
                  ) {
                    return
                  }

                  // 取消该文件所有待触发的保存/草稿计时器
                  clearFileTimers(file.path)

                  if (workspacePath) {
                    void api.draftDelete(workspacePath, file.path).catch(() => undefined)
                  }
                  removeOpenFile(file.path)
                }}
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
      </div>
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
      <div ref={editorRef} className="min-h-0 flex-1" />
    </div>
  )
}
