import React from 'react'
import { useI18nStore } from '../store/i18nStore'

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 顶层错误边界：任何组件渲染/副作用异常都不应该让整个窗口白屏。
 */
export class ErrorBoundary extends React.Component<
  React.PropsWithChildren,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  private unsubscribeI18n: (() => void) | null = null

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidMount(): void {
    // 语言切换后让错误界面同步更新
    this.unsubscribeI18n = useI18nStore.subscribe(() => this.forceUpdate())
  }

  componentWillUnmount(): void {
    this.unsubscribeI18n?.()
    this.unsubscribeI18n = null
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[UI] Unhandled render error:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      const { t } = useI18nStore.getState()
      return (
        <div className="flex flex-col h-screen items-center justify-center gap-4 bg-gray-900 text-gray-100 p-6">
          <h1 className="text-xl font-semibold">{t('errorBoundaryTitle')}</h1>
          <pre className="max-w-2xl max-h-64 overflow-auto text-xs text-red-300 bg-gray-800 p-3 rounded whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm"
            >
              {t('tryAgain')}
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-sm"
            >
              {t('reload')}
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
