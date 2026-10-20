import React from 'react'

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

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[UI] Unhandled render error:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col h-screen items-center justify-center gap-4 bg-gray-900 text-gray-100 p-6">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <pre className="max-w-2xl max-h-64 overflow-auto text-xs text-red-300 bg-gray-800 p-3 rounded whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="px-4 py-2 rounded bg-gray-700 hover:bg-gray-600 text-sm"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-sm"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
