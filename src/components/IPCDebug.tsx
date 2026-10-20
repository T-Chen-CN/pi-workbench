import React, { useState } from 'react'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'

type TestResult = { command: string; status: 'ok' | 'error'; message: string }

export const IPCDebug: React.FC = () => {
  const { t } = useI18nStore()
  const [testResults, setTestResults] = useState<TestResult[]>([])
  const [loading, setLoading] = useState(false)

  const runTests = async () => {
    setLoading(true)
    const results: TestResult[] = []

    try {
      // Test 1: openDirectoryDialog
      try {
        const result = await api.openDirectoryDialog()
        results.push({
          command: 'openDirectoryDialog',
          status: result.success ? 'ok' : 'error',
          message: result.canceled ? 'Canceled by user' : `Returned: ${result.path}`,
        })
      } catch (error) {
        results.push({
          command: 'openDirectoryDialog',
          status: 'error',
          message: String(error),
        })
      }

      // Test 2: listDirectory
      try {
        const result = await api.listDirectory('.')
        results.push({
          command: 'listDirectory',
          status: result.success ? 'ok' : 'error',
          message: result.items ? `Returned ${result.items.length} items` : result.error || 'Unknown error',
        })
      } catch (error) {
        results.push({
          command: 'listDirectory',
          status: 'error',
          message: String(error),
        })
      }

      // Test 3: readFile
      try {
        const result = await api.readFile('./package.json')
        results.push({
          command: 'readFile',
          status: result.success ? 'ok' : 'error',
          message: result.content ? `Returned ${result.content.length} characters` : result.error || 'Unknown error',
        })
      } catch (error) {
        results.push({
          command: 'readFile',
          status: 'error',
          message: String(error),
        })
      }

      // Test 4: writeFile（写入应用缓存目录，避免落在工作区之外）
      try {
        const appDirResult = await api.getAppDir()
        const separator = appDirResult.appDir?.includes('\\') ? '\\' : '/'
        const testPath = appDirResult.success && appDirResult.appDir
          ? `${appDirResult.appDir}${separator}cache${separator}temp${separator}ipc-debug-write.txt`
          : './test-electron-write.txt'
        const result = await api.writeFile(testPath, 'Test content from Electron')
        results.push({
          command: 'writeFile',
          status: result.success ? 'ok' : 'error',
          message: result.success ? 'File written successfully' : result.error || 'Unknown error',
        })
      } catch (error) {
        results.push({
          command: 'writeFile',
          status: 'error',
          message: String(error),
        })
      }

      setTestResults(results)
    } finally {
      setLoading(false)
    }
  }

  const allPassed = testResults.length > 0 && testResults.every((r) => r.status === 'ok')

  return (
    <div className="flex flex-col gap-4 p-4 bg-white dark:bg-[#1e1e1e] rounded-lg border border-gray-200 dark:border-gray-700">
      <h3 className="text-base font-semibold m-0 text-gray-900 dark:text-gray-100">{t('ipcDebug')}</h3>
      <button
        onClick={runTests}
        disabled={loading}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 border-none cursor-pointer font-medium"
      >
        {loading ? t('testing') : t('runTests')}
      </button>

      {testResults.length > 0 && (
        <div className={`p-3 rounded border ${allPassed ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700/50' : 'bg-gray-50 dark:bg-gray-900/20 border-gray-200 dark:border-gray-700'}`}>
          <h4 className="text-sm font-semibold mb-2 m-0 text-gray-900 dark:text-gray-100">
            {t('results')} {allPassed && '✓'}
          </h4>
          <ul className="list-none p-0 m-0 space-y-2">
            {testResults.map((result, i) => (
              <li
                key={i}
                className={`text-sm p-2 rounded ${
                  result.status === 'ok'
                    ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                    : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                }`}
              >
                <span className="font-mono font-semibold">{result.command}</span>
                <span className="mx-2">[{result.status}]</span>
                <span>{result.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
