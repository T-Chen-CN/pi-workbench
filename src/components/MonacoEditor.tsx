import React, { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { useEditorStore } from '../store/editorStore'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { useToast } from './Toast'

export const MonacoEditor: React.FC = () => {
  const { t } = useI18nStore()
  const editorRef = useRef<HTMLDivElement>(null)
  const monacoRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const { currentFile, openFiles, updateOpenFile, markDirty, markClean, removeOpenFile } = useEditorStore()
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const toast = useToast()

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
        saveFile()
      }, 2000)
    })

    return () => subscription.dispose()
  }, [currentFile, updateOpenFile, markDirty])

  const saveFile = async () => {
    if (!currentFile) return

    try {
      updateOpenFile(currentFile.path, { isSaving: true })
      const result = await api.writeFile(currentFile.path, currentFile.content)
      if (!result.success) {
        throw new Error(result.error || 'Failed to save file')
      }
      markClean(currentFile.path)
      updateOpenFile(currentFile.path, { isSaving: false })
      toast.success(`已保存: ${currentFile.name}`, 2000)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error('Failed to save file:', error)
      toast.error(`保存失败: ${errorMsg}`)
      updateOpenFile(currentFile.path, { isSaving: false })
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
      <div className="editor-empty">
        <div className="editor-empty-content">
          <h2>{t('noFileOpen')}</h2>
          <p>{t('selectFileToEdit')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="monaco-editor-wrapper">
      <div className="editor-tabs">
        {openFiles.map((file) => (
          <div
            key={file.path}
            className={`tab ${currentFile?.path === file.path ? 'active' : ''}`}
          >
            <span
              className="tab-content"
              onClick={() => useEditorStore.setState({ currentFile: file })}
            >
              <span className="tab-name">{file.name}</span>
              {file.isDirty && <span className="dirty-dot">●</span>}
              {file.isSaving && <span className="saving-dot">⟳</span>}
            </span>
            <button
              className="tab-close"
              onClick={() => removeOpenFile(file.path)}
              title="Close"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div ref={editorRef} className="editor-container" />
    </div>
  )
}
