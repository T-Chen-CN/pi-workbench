import React, { useEffect, useRef } from 'react'
import { useEditorStore } from '../store/editorStore'

export const Editor: React.FC = () => {
  const { currentFile, openFiles, updateOpenFile, markDirty } = useEditorStore()
  const editorRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!currentFile || !editorRef.current) return
    editorRef.current.value = currentFile.content
    editorRef.current.focus()
  }, [currentFile])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!currentFile) return
    const newContent = e.target.value
    updateOpenFile(currentFile.path, { content: newContent })
    markDirty(currentFile.path)
  }

  if (!currentFile) {
    return (
      <div className="editor-empty">
        <p>选择文件开始编辑</p>
      </div>
    )
  }

  return (
    <div className="editor-panel">
      <div className="editor-tabs">
        {openFiles.map((file) => (
          <div
            key={file.path}
            className={`tab ${currentFile.path === file.path ? 'active' : ''}`}
            onClick={() => useEditorStore.setState({ currentFile: file })}
          >
            <span className="tab-name">{file.name}</span>
            {file.isDirty && <span className="dirty-indicator">●</span>}
          </div>
        ))}
      </div>
      <textarea
        ref={editorRef}
        className="editor-content"
        onChange={handleChange}
        placeholder="编辑代码..."
      />
    </div>
  )
}
