import React, { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { useEditorStore } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { toast } from '../store/toastStore'

export const MonacoEditor: React.FC = () => {
  const { t } = useI18nStore()
  const editorRef = useRef<HTMLDivElement>(null)
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const { currentFile, openFiles, updateOpenFile, markDirty, markClean, removeOpenFile } = useEditorStore()
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Initialize Monaco editor
  useEffect(() => {
    if (!editorRef.current) return

    monacoRef.current = monaco.editor.create(editorRef.current, {
      theme: 'vs-dark',
      language: 'typescript',
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: 14,
      lineNumbers: 'on',
      wordWrap: 'on',
    })

    return () => {
      monacoRef.current?.dispose()
    }
  }, [])

  // Update editor content when current file changes
  useEffect(() => {
    if (!monacoRef.current || !currentFile) return

    const model = monacoRef.current.getModel()
    if (model && model.getValue() === currentFile.content) return

    monacoRef.current.setValue(currentFile.content)

    // Detect language from file extension
    const extension = currentFile.name.split('.').pop() || 'txt'
    const languageMap: Record<string, string> = {
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

    const language = languageMap[extension] || 'plaintext'
    monaco.editor.setModelLanguage(model || monaco.editor.createModel('', ''), language)
  }, [currentFile])

  // Handle editor changes
  useEffect(() => {
    if (!monacoRef.current) return

    const model = monacoRef.current.getModel()
    if (!model) return

    const subscription = model.onDidChangeContent(() => {
      if (!currentFile) return

      const newContent = model.getValue()
      updateOpenFile(currentFile.path, { content: newContent })
      markDirty(currentFile.path)

      // Auto-save after 2 seconds of inactivity
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = setTimeout(() => {
        void saveFile(currentFile.path)
      }, 2000)
    })

    return () => {
      subscription.dispose()
      // 切换文件/卸载时取消未触发的自动保存，避免写入旧内容
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
      }
    }
  }, [currentFile, updateOpenFile, markDirty])

  const saveFile = async (pathOverride?: string) => {
    const targetPath = pathOverride ?? currentFile?.path
    if (!targetPath) return

    // 从 store 读取最新内容，避免闭包中的旧快照导致写回旧内容
    const latest = useEditorStore.getState().openFiles.find(file => file.path === targetPath)
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
  }

  const handleSave = async (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      await saveFile()
    }
  }

  useEffect(() => {
    window.addEventListener('keydown', handleSave)
    return () => window.removeEventListener('keydown', handleSave)
  }, [currentFile])

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
    <div className="flex flex-col flex-1 bg-white dark:bg-[#1e1e1e]">
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
              onClick={() => removeOpenFile(file.path)}
              title="Close"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div ref={editorRef} className="flex-1" />
    </div>
  )
}
