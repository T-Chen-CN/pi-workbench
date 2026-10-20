/**
 * Monaco worker 配置。
 *
 * 直接使用 monaco-editor 的 ESM 入口时，worker 的默认 URL 解析在 Vite 下
 * 会指向错误路径，导致语言服务 worker 加载失败。这里用 Vite 的 ?worker
 * 导入显式创建对应 worker。
 */
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/languages/features/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/languages/features/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker.js?worker'
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker'

interface MonacoEnvironmentLike {
  getWorker: (workerId: string, label: string) => Worker
}

const monacoEnvironment: MonacoEnvironmentLike = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  },
}

;(globalThis as unknown as { MonacoEnvironment: MonacoEnvironmentLike }).MonacoEnvironment =
  monacoEnvironment
