import React from 'react'
import { useI18nStore } from '../store/i18nStore'

interface ErrorBoundaryState {
  error: Error | null
}

export interface ErrorBoundaryProps extends React.PropsWithChildren {
  /**
   * app：整窗兜底（默认）；pane：只接管一块区域，坏掉的视图不影响其它面板
   */
  scope?: 'app' | 'pane'
  /** 变化时自动清除错误状态（如切换文件 / 切换会话后重试渲染） */
  resetKey?: unknown
}

/**
 * 错误边界：组件渲染或副作用异常不应该让整个窗口白屏。
 *
 * 顶层用 `scope="app"`，编辑器 / 聊天等独立面板用 `scope="pane"`，
 * 这样单个视图崩溃只留下一条可重试的提示，而不是整窗空白。
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  private unsubscribeI18n: (() => void) | null = null

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidMount(): void {
    // 语言切换后让错误界面同步更新
    this.unsubscribeI18n = useI18nStore.subscribe(() => this.forceUpdate())
  }

  componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
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
      const retry = (
        <button
          onClick={() => this.setState({ error: null })}
          className="border border-rule-control bg-raised px-4 py-2 type-label text-ink transition-colors hover:bg-hover"
        >
          {t('tryAgain')}
        </button>
      )

      if (this.props.scope === 'pane') {
        return (
          <div
            role="alert"
            data-testid="pane-error"
            className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-surface p-6 text-center"
          >
            <span className="type-label text-ink">{t('paneErrorTitle')}</span>
            <span className="max-w-md type-caption text-ink-muted">{this.state.error.message}</span>
            {retry}
          </div>
        )
      }

      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-surface p-6 text-ink">
          <h1 className="type-title text-ink">{t('errorBoundaryTitle')}</h1>
          <pre className="max-h-64 max-w-2xl overflow-auto whitespace-pre-wrap border border-rule-control bg-sunken p-3 type-code text-danger">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            {retry}
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
