/**
 * 渲染进程日志：把未捕获异常和 console.warn/error 写入 {appDir}/logs/renderer.log。
 * 只在 Electron 中生效；Web 开发模式没有 preload 时静默跳过。
 */
type RendererLogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

function send(level: RendererLogLevel, args: unknown[]): void {
  try {
    const api = window.electronAPI
    if (!api?.logRenderer) return
    void api.logRenderer(level, args).catch(() => undefined)
  } catch {
    // 日志失败不能影响渲染进程
  }
}

export function installRendererLogging(): void {
  if (typeof window === 'undefined') return

  window.addEventListener('error', (event) => {
    send('ERROR', [
      'Uncaught error:',
      event.message,
      `${event.filename}:${event.lineno}:${event.colno}`,
    ])
  })

  window.addEventListener('unhandledrejection', (event) => {
    send('ERROR', ['Unhandled rejection:', event.reason])
  })

  const originalError = console.error.bind(console)
  const originalWarn = console.warn.bind(console)

  console.error = (...args: unknown[]): void => {
    originalError(...args)
    send('ERROR', args)
  }
  console.warn = (...args: unknown[]): void => {
    originalWarn(...args)
    send('WARN', args)
  }
}
