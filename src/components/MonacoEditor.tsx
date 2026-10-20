import React, { useCallback, useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { FileCode, Loader2, X } from 'lucide-react'
import { useEditorStore } from '../store/editorStore'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useI18nStore } from '../store/i18nStore'
import { useResolvedTheme } from '../store/themeStore'
import { localizeError } from '../i18n/errors'
import { api } from '../api'
import { toast } from '../store/toastStore'
import type { OpenFile } from '../types'
import { EmptyState } from './ui'

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

monaco.editor.defineTheme(EDITOR_THEME.paper, {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '9A9284', fontStyle: 'italic' },
    { token: 'keyword', foreground: '8A3B2A' },
    { token: 'string', foreground: '4F6B3A' },
    { token: 'number', foreground: '8A6A3B' },
    { token: 'type', foreground: '3E5D66' },
    { token: 'type.identifier', foreground: '3E5D66' },
    { token: 'identifier', foreground: '2B2721' },
    { token: 'function', foreground: '6B4E2E' },
    { token: 'delimiter', foreground: '6D675C' },
    { token: 'tag', foreground: '8A3B2A' },
    { token: 'attribute.name', foreground: '7A4B36' },
  ],
  colors: {
    'editor.background': '#FBF9F4',
    'editor.foreground': '#2B2721',
    'editorLineNumber.foreground': '#B5AE9F',
    'editorLineNumber.activeForeground': '#6D675C',
    'editor.selectionBackground': '#2F5D4E24',
    'editor.inactiveSelectionBackground': '#17151212',
    'editor.lineHighlightBackground': '#17151209',
    'editorCursor.foreground': '#2F5D4E',
    'editorIndentGuide.background1': '#17151214',
    'editorIndentGuide.activeBackground1': '#17151233',
    'editorWidget.background': '#FBF9F4',
    'editorWidget.border': '#17151229',
    'editorSuggestWidget.background': '#FBF9F4',
    'editorSuggestWidget.border': '#17151229',
    'editorSuggestWidget.selectedBackground': '#EFECE4',
    'scrollbarSlider.background': '#918A7D55',
    'scrollbarSlider.hoverBackground': '#918A7D88',
  },
})

monaco.editor.defineTheme(EDITOR_THEME.ink, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '7C7466', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'E08A72' },
    { token: 'string', foreground: '9DBF8A' },
    { token: 'number', foreground: 'D6B26E' },
    { token: 'type', foreground: '8FC4CF' },
    { token: 'type.identifier', foreground: '8FC4CF' },
    { token: 'identifier', foreground: 'E6DFD3' },
    { token: 'function', foreground: 'DEC49E' },
    { token: 'delimiter', foreground: '9C9487' },
    { token: 'tag', foreground: 'E08A72' },
    { token: 'attribute.name', foreground: 'C8A88A' },
  ],
  colors: {
    'editor.background': '#1A1815',
    'editor.foreground': '#E6DFD3',
    'editorLineNumber.foreground': '#736C60',
    'editorLineNumber.activeForeground': '#9C9487',
    'editor.selectionBackground': '#8FC7B43D',
    'editor.inactiveSelectionBackground': '#EDE7DC14',
    'editor.lineHighlightBackground': '#EDE7DC0A',
    'editorCursor.foreground': '#8FC7B4',
    'editorIndentGuide.background1': '#EDE7DC14',
    'editorIndentGuide.activeBackground1': '#EDE7DC33',
    'editorWidget.background': '#1A1815',
    'editorWidget.border': '#EDE7DC29',
    'editorSuggestWidget.background': '#1A1815',
    'editorSuggestWidget.border': '#EDE7DC29',
    'editorSuggestWidget.selectedBackground': '#2B2722',
    'scrollbarSlider.background': '#736C6055',
    'scrollbarSlider.hoverBackground': '#736C6088',
  },
})

export const MonacoEditor: React.FC = () => {
  const { t } = useI18nStore()
  const resolvedTheme = useResolvedTheme()
  const editorRef = useRef<HTMLDivElement>(null)
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const { currentFile, openFiles, updateOpenFile, markClean, removeOpenFile } = useEditorStore()
  const saveTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())
  const draftTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())
  // 每个文件一个 model：切换标签时保留撤销栈、光标与滚动位置
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map())
  const viewStatesRef = useRef<Map<string, monaco.editor.ICodeEditorViewState | null>>(new Map())
  const activePathRef = useRef<string | null>(null)
  // 程序化 setValue 时抑制内容变化回调，避免误标脏 + 自动保存回环
  const suppressChangeRef = useRef(false)
  const [editorReady, setEditorReady] = useState(false)

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
      fontFamily: '"IBM Plex Mono", "Cascadia Code", Consolas, monospace',
      lineNumbers: 'on',
      wordWrap: 'on',
      padding: { top: 10 },
    })
    setEditorReady(true)
  }, [currentFile, resolvedTheme, getOrCreateModel])

  // 主题切换时更新编辑器配色
  useEffect(() => {
    monaco.editor.setTheme(resolvedTheme === 'dark' ? EDITOR_THEME.ink : EDITOR_THEME.paper)
  }, [resolvedTheme])

  // 组件卸载时释放编辑器与所有 model
  useEffect(() => {
    const models = modelsRef.current
    const viewStates = viewStatesRef.current
    return () => {
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
      const state = useEditorStore.getState()
      const target = state.openFiles.find((file) => file.path === payload.path)
      if (!target) return

      const existsResult = await api.exists(payload.path)
      if (existsResult.success && existsResult.exists === false) {
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
  }, [t])

  const saveFile = useCallback(
    async (pathOverride?: string) => {
      const targetPath = pathOverride ?? useEditorStore.getState().currentFile?.path
      if (!targetPath) return

      // 手动保存时取消该文件尚未触发的自动保存，避免重复写入
      const pendingSave = saveTimersRef.current.get(targetPath)
      if (pendingSave) {
        clearTimeout(pendingSave)
        saveTimersRef.current.delete(targetPath)
      }

      // 从 store 读取最新内容，避免闭包中的旧快照导致写回旧内容
      const latest = useEditorStore.getState().openFiles.find((file) => file.path === targetPath)
      if (!latest) return

      const contentToSave = latest.content

      try {
        updateOpenFile(targetPath, { isSaving: true })
        const result = await api.writeFile(targetPath, contentToSave)
        if (!result.success) {
          throw new Error(result.error || 'Failed to save file')
        }

        // 写入期间用户可能继续输入：只有内容没再变化时才标记为已保存
        const afterSave = useEditorStore.getState().openFiles.find((file) => file.path === targetPath)
        const changedDuringSave = Boolean(afterSave && afterSave.content !== contentToSave)
        const workspacePath = useWorkspaceStore.getState().workspacePath

        if (changedDuringSave) {
          if (workspacePath && afterSave) {
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
    [updateOpenFile, markClean, t]
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

      const state = useEditorStore.getState()
      const file = state.currentFile
      if (!file) return

      const newContent = editor.getValue()
      state.updateOpenFile(file.path, { content: newContent })
      state.markDirty(file.path)

      // 崩溃恢复：内容变化后把未保存内容落到 cache/drafts（正常保存后删除）
      const workspacePath = useWorkspaceStore.getState().workspacePath
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
      saveTimers.set(
        file.path,
        setTimeout(() => {
          saveTimers.delete(file.path)
          void saveFile(file.path)
        }, 2000)
      )
    })

    return () => {
      subscription.dispose()

      for (const timer of saveTimers.values()) {
        clearTimeout(timer)
      }
      saveTimers.clear()

      // 卸载前把各文件最后的未保存内容补成草稿
      const workspacePath = useWorkspaceStore.getState().workspacePath
      for (const [filePath, timer] of draftTimers) {
        clearTimeout(timer)
        if (!workspacePath) continue
        const file = useEditorStore.getState().openFiles.find((item) => item.path === filePath)
        if (file?.isDirty) {
          void api.draftSave(workspacePath, filePath, file.content).catch(() => undefined)
        }
      }
      draftTimers.clear()
    }
  }, [editorReady, saveFile])

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
    window.addEventListener('keydown', handleSave)
    return () => window.removeEventListener('keydown', handleSave)
  }, [handleSave])

  if (!currentFile) {
    return (
      <div className="flex flex-1 items-center justify-center bg-panel">
        <EmptyState icon={FileCode} title={t('noFileOpen')} description={t('selectFileToEdit')} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="flex flex-shrink-0 items-stretch overflow-x-auto border-b border-line bg-surface">
        {openFiles.map((file) => {
          const active = currentFile?.path === file.path
          return (
            <div
              key={file.path}
              className={`group flex h-[34px] items-center gap-2 border-r border-line pl-3 pr-1.5 font-mono text-[10.5px] transition-colors ${
                active
                  ? 'bg-panel text-ink shadow-[inset_0_2px_0_rgb(var(--accent))]'
                  : 'text-ink-subtle hover:bg-hover hover:text-ink'
              }`}
            >
              <button
                type="button"
                className="flex max-w-[220px] items-center gap-1.5 bg-transparent text-inherit"
                title={file.path}
                onClick={() => useEditorStore.setState({ currentFile: file })}
              >
                <FileCode size={12} className={active ? 'text-accent' : 'text-ink-subtle'} />
                <span className="truncate">{file.name}</span>
                {file.isDirty && (
                  <span
                    className="h-1 w-1 flex-shrink-0 rounded-full bg-accent"
                    title={t('unsavedChanges')}
                  />
                )}
                {file.isSaving && <Loader2 size={10} className="animate-spin text-ink-subtle" />}
              </button>
              <button
                type="button"
                className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-ink-subtle opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={t('close')}
                title={t('close')}
                onClick={() => {
                  const target = useEditorStore.getState().openFiles.find((f) => f.path === file.path)
                  if (target?.isDirty && !window.confirm(t('discardChangesConfirm'))) return

                  // 取消该文件所有待触发的保存/草稿计时器
                  const pendingSave = saveTimersRef.current.get(file.path)
                  if (pendingSave) {
                    clearTimeout(pendingSave)
                    saveTimersRef.current.delete(file.path)
                  }
                  const pendingDraft = draftTimersRef.current.get(file.path)
                  if (pendingDraft) {
                    clearTimeout(pendingDraft)
                    draftTimersRef.current.delete(file.path)
                  }

                  const workspacePath = useWorkspaceStore.getState().workspacePath
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
      <div ref={editorRef} className="min-h-0 flex-1" />
    </div>
  )
}
