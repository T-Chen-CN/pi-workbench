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
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-surface p-6 text-ink">
          <h1 className="type-title text-ink">{t('errorBoundaryTitle')}</h1>
          <pre className="max-h-64 max-w-2xl overflow-auto whitespace-pre-wrap border border-line bg-sunken p-3 type-code text-danger">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="border border-line bg-raised px-4 py-2 type-label text-ink transition-colors hover:bg-hover"
            >
              {t('tryAgain')}
            </button>
            <button
              onClick={() => window.location.reload()}
              className="bg-accent px-4 py-2 type-label text-accent-fg transition-colors hover:bg-accent-hover"
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
