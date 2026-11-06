/**
 * Hermes 自举 Prompt 的运行时副本。
 *
 * 唯一的事实源是 `docs/requirements/hermes-bootstrap-prompt.md`（规范原文，含判读说明）。
 * 打包只带 `dist/`，运行时读不到 `docs/`，所以这里用 vite 的 `?raw` 在**构建时**把
 * 那份文档内联进来，再取出其中唯一的 ```text 代码块。
 *
 * 因此：改 Prompt 只改文档，应用里自动跟着变；`tests/hermes-prompt.test.ts` 守住
 * 「代码块存在、内容完整」这条，防止文档被改坏后按钮复制出一段残缺文本。
 *
 * 插件仓库与版本**不写在文档里**，而是文档里留 `{{PLUGIN_REPO}}` / `{{PLUGIN_REF}}` 占位符、
 * 由这里注入：插件有自己的仓库与发版节奏（见 `docs/guides/PLUGIN_REPO_MIGRATION.md`），
 * 跟版时只改下面两个常量，文档一字不动。
 */

import doc from '../../docs/requirements/hermes-bootstrap-prompt.md?raw'

const TEXT_FENCE = /```text\r?\n([\s\S]*?)```/

/**
 * 插件仓库地址（`hermes plugins install` 的 `repo` 参数）。
 * 公开仓库，安装不需要任何凭据。
 */
export const PLUGIN_REPO = 'https://github.com/T-Chen-CN/pi-workbench-plugin.git'

/**
 * 插件版本：**完整 40 位 commit SHA**（`hermes plugins install --ref` 只认这个，不认 tag / 分支）。
 * 当前 = tag `v0.1.0`；每次插件发版在这里改一行（见迁移手册 §5「发布 checklist」）。
 */
export const PLUGIN_REF = '8669f32e98a6afb49ec81f9bac59394e3852f6d5'

/** 取出文档里第一个 ```text 代码块（统一换行、去掉首尾空行） */
export function extractPromptBlock(markdown: string): string {
  const match = TEXT_FENCE.exec(markdown)
  if (!match) return ''
  return match[1].replace(/\r\n?/g, '\n').trim()
}

/** 把文档里的占位符换成真实值（纯函数，便于单测；用 split/join 而不是 replaceAll：tsconfig 锁在 ES2020） */
export function fillPromptPlaceholders(block: string): string {
  return block.split('{{PLUGIN_REPO}}').join(PLUGIN_REPO).split('{{PLUGIN_REF}}').join(PLUGIN_REF)
}

export const HERMES_BOOTSTRAP_PROMPT = fillPromptPlaceholders(extractPromptBlock(doc))
