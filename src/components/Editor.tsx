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
      <div className="flex-1 flex items-center justify-center bg-white dark:bg-[#1e1e1e]">
        <p className="text-gray-600 dark:text-gray-400">选择文件开始编辑</p>
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
              currentFile.path === file.path
                ? 'bg-white dark:bg-[#1e1e1e] border-b-2 border-b-blue-600'
                : 'hover:bg-gray-100 dark:hover:bg-[#2d2d30]'
            }`}
            onClick={() => useEditorStore.setState({ currentFile: file })}
          >
            <span className="text-gray-900 dark:text-gray-100">{file.name}</span>
            {file.isDirty && <span className="w-2 h-2 rounded-full bg-red-500"></span>}
          </div>
        ))}
      </div>
      <textarea
        ref={editorRef}
        className="flex-1 px-4 py-3 bg-white dark:bg-[#1e1e1e] text-gray-900 dark:text-gray-100 border-none resize-none font-mono focus:outline-none"
        onChange={handleChange}
        placeholder="编辑代码..."
      />
    </div>
  )
}
