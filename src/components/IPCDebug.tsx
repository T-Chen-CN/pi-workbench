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

      // Test 4: writeFile (to temp location)
      try {
        const testPath = './test-electron-write.txt'
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
    <div className="ipc-debug">
      <h3>{t('ipcDebug')}</h3>
      <button onClick={runTests} disabled={loading}>
        {loading ? t('testing') : t('runTests')}
      </button>

      {testResults.length > 0 && (
        <div className={`results ${allPassed ? 'all-passed' : ''}`}>
          <h4>{t('results')} {allPassed && '✓'}</h4>
          <ul>
            {testResults.map((result, i) => (
              <li key={i} className={result.status}>
                <span className="command">{result.command}</span>
                <span className="status">{result.status}</span>
                <span className="message">{result.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
