import React, { useCallback, useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { useEditorStore } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { toast } from '../store/toastStore'

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

export const MonacoEditor: React.FC = () => {
  const { t } = useI18nStore()
  const editorRef = useRef<HTMLDivElement>(null)
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const { currentFile, openFiles, updateOpenFile, markClean, removeOpenFile } = useEditorStore()
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  // 程序化 setValue 时抑制内容变化回调，避免误标脏 + 自动保存回环
  const suppressChangeRef = useRef(false)
  const [editorReady, setEditorReady] = useState(false)

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

    monacoRef.current = monaco.editor.create(editorRef.current, {
      value: currentFile.content,
      language: detectLanguage(currentFile.name),
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: 14,
      lineNumbers: 'on',
      wordWrap: 'on',
    })
    setEditorReady(true)
  }, [currentFile])

  // 组件卸载时释放编辑器
  useEffect(() => {
    return () => {
      monacoRef.current?.dispose()
      monacoRef.current = null
    }
  }, [])

  // Update editor content when current file changes
  useEffect(() => {
    if (!monacoRef.current || !currentFile) return

    const model = monacoRef.current.getModel()
    if (model && model.getValue() === currentFile.content) return

    suppressChangeRef.current = true
    monacoRef.current.setValue(currentFile.content)
    suppressChangeRef.current = false

    const language = detectLanguage(currentFile.name)
    monaco.editor.setModelLanguage(model || monaco.editor.createModel('', ''), language)
  }, [currentFile, editorReady])

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

  // 外部文件变化：未被本地修改时同步磁盘内容；被外部删除时关闭标签
  const currentPath = currentFile?.path

  useEffect(() => {
    if (!currentPath) return

    const unsubscribe = api.onFsChanged(async (payload) => {
      if (payload.path !== currentPath) return

      const state = useEditorStore.getState()
      const target = state.openFiles.find((file) => file.path === currentPath)
      if (!target) return

      const existsResult = await api.exists(currentPath)
      if (existsResult.success && existsResult.exists === false) {
        state.removeOpenFile(currentPath)
        toast.info(`File removed: ${target.name}`)
        return
      }

      if (target.isDirty) return

      const result = await api.readFile(currentPath)
      if (result.success && typeof result.content === 'string' && result.content !== target.content) {
        state.updateOpenFile(currentPath, { content: result.content })
        state.markClean(currentPath)
      }
    })

    return unsubscribe
  }, [currentPath])

  const saveFile = useCallback(
    async (pathOverride?: string) => {
      const targetPath = pathOverride ?? useEditorStore.getState().currentFile?.path
      if (!targetPath) return

      // 从 store 读取最新内容，避免闭包中的旧快照导致写回旧内容
      const latest = useEditorStore.getState().openFiles.find((file) => file.path === targetPath)
      if (!latest) return

      try {
        updateOpenFile(targetPath, { isSaving: true })
        const result = await api.writeFile(targetPath, latest.content)
        if (!result.success) {
          throw new Error(result.error || 'Failed to save file')
        }
        markClean(targetPath)
        updateOpenFile(targetPath, { isSaving: false })
        toast.success(`已保存: ${latest.name}`, 2000)
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.error('Failed to save file:', error)
        toast.error(`保存失败: ${errorMsg}`)
        updateOpenFile(targetPath, { isSaving: false })
      }
    },
    [updateOpenFile, markClean]
  )

  // 监听编辑器内容变化：自动保存的防抖计时器独立于 currentFile，
  // 切换文件不会清掉尚未触发的保存。
  useEffect(() => {
    if (!editorReady || !monacoRef.current) return

    const editor = monacoRef.current
    const subscription = editor.onDidChangeModelContent(() => {
      if (suppressChangeRef.current) return

      const state = useEditorStore.getState()
      const file = state.currentFile
      if (!file) return

      const newContent = editor.getValue()
      state.updateOpenFile(file.path, { content: newContent })
      state.markDirty(file.path)

      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = setTimeout(() => {
        saveTimeoutRef.current = null
        void saveFile(file.path)
      }, 2000)
    })

    return () => {
      subscription.dispose()
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
      }
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
      <div className="flex-1 flex flex-col items-center justify-center bg-white dark:bg-[#1e1e1e]">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-2">{t('noFileOpen')}</h2>
          <p className="text-gray-600 dark:text-gray-400">{t('selectFileToEdit')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 bg-white dark:bg-[#1e1e1e] min-h-0">
      <div className="flex gap-0 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#252526] flex-shrink-0 overflow-x-auto">
        {openFiles.map((file) => (
          <div
            key={file.path}
            className={`flex items-center gap-2 px-4 py-2 border-r border-gray-200 dark:border-gray-700 cursor-pointer select-none whitespace-nowrap ${
              currentFile?.path === file.path
                ? 'bg-white dark:bg-[#1e1e1e] border-b-2 border-b-blue-600'
                : 'hover:bg-gray-100 dark:hover:bg-[#2d2d30]'
            }`}
          >
            <span
              className="flex items-center gap-2 flex-1"
              onClick={() => useEditorStore.setState({ currentFile: file })}
            >
              <span className="text-gray-900 dark:text-gray-100">{file.name}</span>
              {file.isDirty && <span className="w-2 h-2 rounded-full bg-red-500"></span>}
              {file.isSaving && <span className="animate-spin text-xs">⟳</span>}
            </span>
            <button
              className="p-1 hover:bg-gray-200 dark:hover:bg-[#2d2d30] rounded text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 border-none bg-none cursor-pointer"
              onClick={() => {
                const target = useEditorStore.getState().openFiles.find((f) => f.path === file.path)
                if (target?.isDirty && !window.confirm(t('discardChangesConfirm'))) return
                removeOpenFile(file.path)
              }}
              title="Close"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div ref={editorRef} className="flex-1 min-h-0" />
    </div>
  )
}
