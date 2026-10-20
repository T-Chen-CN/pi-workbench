import React, { useState } from 'react'
import { useI18nStore } from '../store/i18nStore'
import { api } from '../api'
import { Button } from './ui'

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
          message: result.canceled
            ? t('canceledByUser')
            : t('returnedPath', { path: result.path ?? '' }),
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
          message: result.items
            ? t('returnedItems', { count: result.items.length })
            : result.error || t('unknownError'),
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
          message: result.content
            ? t('returnedChars', { count: result.content.length })
            : result.error || t('unknownError'),
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
          message: result.success ? t('fileWritten') : result.error || t('unknownError'),
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
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h3 className="m-0 font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-subtle">
          {t('ipcDebug')}
        </h3>
        <Button variant="secondary" size="sm" loading={loading} onClick={() => void runTests()}>
          {loading ? t('testing') : t('runTests')}
        </Button>
      </div>

      {testResults.length > 0 && (
        <div className="border border-line bg-panel p-2">
          <h4 className="m-0 mb-1.5 flex items-center gap-2 text-[11px] font-semibold text-ink">
            {t('results')}
            {allPassed && <span className="text-success">✓ {t('allPassed')}</span>}
          </h4>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {testResults.map((result, i) => (
              <li
                key={i}
                className={`px-2 py-1 font-mono text-[10px] ${
                  result.status === 'ok'
                    ? 'bg-success/10 text-success'
                    : 'bg-danger/10 text-danger'
                }`}
              >
                <span className="font-mono font-semibold">{result.command}</span>
                <span className="mx-1.5 opacity-70">[{result.status}]</span>
                <span className="text-ink-muted">{result.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
