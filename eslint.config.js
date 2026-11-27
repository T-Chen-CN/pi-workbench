import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import jsxA11y from 'eslint-plugin-jsx-a11y'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'release/**',
      'pi-bridge/dist/**',
      'apps/cloud/dist/**',
      'apps/cloud/web-dist/**',
      'node_modules/**',
      'cache/**',
      'data/**',
      // 本机临时脚本与图标生成实验（已被 .gitignore 忽略）
      '.tmp/**',
      'config/**',
      'logs/**',
      '.claude/**',
      // pi 的并行工作树：独立检出、独立依赖，不属于本检出
      '.pi-workbench/**',
      '**/.pi-workbench/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,cts}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // TypeScript 已负责未定义变量检查
      'no-undef': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // 与 IPC / SDK 交互处存在必要的 any
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // A11y 门禁：覆盖桌面渲染层、共享云端 UI 与云端 Web 控制台
    ...jsxA11y.flatConfigs.recommended,
    files: ['src/**/*.tsx', 'packages/cloud-ui/**/*.tsx', 'apps/cloud/web-src/**/*.tsx'],
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // 桌面端弹窗 / 命令面板 / 重命名输入框打开时主动聚焦属于预期键盘体验
      'jsx-a11y/no-autofocus': 'off',
      // WAI-ARIA 可滚动阅读区（region）与交互式画布（application）允许 tabIndex={0} 承接键盘导航
      'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['tabpanel', 'application', 'region'] }],
      // Radio / Checkbox 选项常含标题 + 说明两层 span
      'jsx-a11y/label-has-associated-control': ['error', { depth: 3 }],
    },
  },
  {
    // 跨包边界：packages/cloud-ui 与 apps/cloud/web-src 禁止引入桌面 store / 翻译表 / Electron
    files: ['packages/cloud-ui/**/*.{ts,tsx}', 'apps/cloud/web-src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: '云端 UI / Web 禁止依赖 Electron' },
            { name: 'zustand', message: '云端 UI / Web 禁止引入桌面 Zustand store' },
          ],
          patterns: [
            {
              group: ['**/src/store/*', '**/src/i18n/*', '**/src/api/*', '**/src/panelHost/*', '**/src/workspace/*'],
              message: '禁止跨包引入桌面端 store / i18n / api / panelHost / workspace',
            },
          ],
        },
      ],
    },
  },
  {
    // 进程边界：渲染进程禁止直接引入 Electron 主进程或 Node 内置模块
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: '渲染进程禁止引入 electron，只能通过 window.electronAPI' },
            { name: 'fs', message: '渲染进程无 Node fs 权限，请走 IPC' },
            { name: 'path', message: '渲染进程请使用 src/utils/filePath.ts 而不是 Node path' },
            { name: 'child_process', message: '渲染进程无子进程权限，请走 IPC' },
            { name: 'worker_threads', message: '渲染进程无 Node worker_threads 权限' },
            { name: 'os', message: '渲染进程无 Node os 权限' },
            { name: 'crypto', message: '渲染进程请使用 Web Crypto API' },
          ],
          patterns: [
            {
              group: ['node:*', '../electron/*', '../../electron/*', '../../../electron/*'],
              message: '渲染进程禁止直接引入 Node 内置模块或 electron/ 源码',
            },
          ],
        },
      ],
    },
  },
  {
    // Worker 线程边界：必须在纯 Node 环境可独立运行，禁止引入 electron
    files: [
      'electron/path-safety.ts',
      'electron/*-worker.ts',
      'electron/documents/documents-worker.ts',
      'electron/documents/zip.ts',
      'electron/documents/xml.ts',
      'electron/documents/ooxml.ts',
      'electron/documents/pdf.ts',
      'electron/documents/detect.ts',
      'electron/documents/extract.ts',
      'electron/documents/preview.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'Worker 线程或纯解析模块禁止引入 electron' },
          ],
        },
      ],
    },
  },
  {
    // AST 级设计系统护栏：禁止在业务源码字面量中硬编码十六进制色值
    files: ['src/**/*.{ts,tsx}', 'packages/cloud-ui/**/*.{ts,tsx}', 'apps/cloud/web-src/**/*.{ts,tsx}'],
    ignores: [
      'src/theme/**',
      'src/utils/shikiHighlighter.ts',
      'src/components/ui/ui.tsx',
      'src/components/ui/patterns.tsx',
      'packages/cloud-ui/src/primitives.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message: '禁止硬编码十六进制色值，改用 Paper & Ink 语义 token（docs/design/DESIGN_SYSTEM.md）',
        },
      ],
    },
  },
  {
    // 启动页脚本：在渲染进程的浏览器环境里运行
    files: ['src/public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
  {
    // 构建期脚本（Node ESM）
    files: ['scripts/**/*.{js,mjs}', 'docs/**/*.mjs', 'apps/cloud/scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        WebSocket: 'readonly',
      },
    },
  },
  {
    // 工作台插件是按 CommonJS 加载的示例代码
    files: ['examples/plugins/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  }
)
