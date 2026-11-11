/**
 * 渲染进程日志：把未捕获异常和 console.warn/error 写入 {appDir}/logs/renderer.log。
 * 只在 Electron 中生效；Web 开发模式没有 preload 时静默跳过。
 *
 * 两条过滤是必需的，不是洁癖：
 * - **已知噪音**：Chrome 把 ResizeObserver 的循环通知也当成 `error` 事件派发。实测
 *   `renderer.log` 1098 行**全是** `ResizeObserver loop completed with undelivered
 *   notifications`（183KB），真实渲染错误完全被埋掉。
 * - **重复折叠**：同一条消息在窗口期内只记第一次，之后只累计次数，下一条带上
 *   「上次之后又发生 N 次」—— 一个每帧都在报的错误不该把日志刷爆。
 */
type RendererLogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

/** 浏览器自己的噪音，不是我们的 bug，也不可修 */
const BENIGN_MESSAGES = [/^ResizeObserver loop/]

/** 同一条消息在这个窗口内只落第一行 */
const DEDUPE_WINDOW_MS = 60_000
/** 记录过的签名上限：超过就整体清空（噪音不值得为它做 LRU） */
const MAX_SIGNATURES = 200

interface SeenEntry {
  at: number
  suppressed: number
}

const seen = new Map<string, SeenEntry>()

function send(level: RendererLogLevel, args: unknown[]): void {
  try {
    const api = window.electronAPI
    if (!api?.logRenderer) return
    void api.logRenderer(level, args).catch(() => undefined)
  } catch {
    // 日志失败不能影响渲染进程
  }
}

function signatureOf(args: unknown[]): string {
  return args.map((item) => (typeof item === 'string' ? item : String(item))).join(' ').slice(0, 300)
}

/**
 * 落盘前统一过一遍：噪音直接丢，重复的折叠。
 * 导出只为测试 —— 生产路径只有 `installRendererLogging` 一个入口。
 */
export function emitRendererLog(
  level: RendererLogLevel,
  args: unknown[],
  now: number = Date.now()
): void {
  // 噪音判定按「某一个参数自己就是那条噪音」来认：window error 事件里 message 是
  // 第二个参数（第一个是固定的 `Uncaught error:`）
  const benign = args.some(
    (item) => typeof item === 'string' && BENIGN_MESSAGES.some((pattern) => pattern.test(item))
  )
  if (benign) return

  const signature = signatureOf(args)
  const previous = seen.get(signature)
  if (previous && now - previous.at < DEDUPE_WINDOW_MS) {
    previous.suppressed += 1
    return
  }
  if (!previous && seen.size >= MAX_SIGNATURES) seen.clear()
  const suppressed = previous?.suppressed ?? 0
  seen.set(signature, { at: now, suppressed: 0 })

  send(
    level,
    suppressed > 0 ? [...args, `（上一次之后又发生了 ${suppressed} 次同类日志）`] : args
  )
}

/** 测试用：清掉去重状态 */
export function resetRendererLogForTests(): void {
  seen.clear()
}

export function installRendererLogging(): void {
  if (typeof window === 'undefined') return

  window.addEventListener('error', (event) => {
    emitRendererLog('ERROR', [
      'Uncaught error:',
      event.message,
      `${event.filename}:${event.lineno}:${event.colno}`,
    ])
  })

  window.addEventListener('unhandledrejection', (event) => {
    emitRendererLog('ERROR', ['Unhandled rejection:', event.reason])
  })

  const originalError = console.error.bind(console)
  const originalWarn = console.warn.bind(console)

  console.error = (...args: unknown[]): void => {
    originalError(...args)
    emitRendererLog('ERROR', args)
  }
  console.warn = (...args: unknown[]): void => {
    originalWarn(...args)
    emitRendererLog('WARN', args)
  }
}
