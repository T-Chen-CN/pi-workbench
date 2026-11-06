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
 * 插件仓库**不写死在文档里**，而是文档里留 `{{PLUGIN_REPO}}` 占位符、由这里注入：插件有自己的
 * 仓库与发版节奏（见 `docs/guides/PLUGIN_REPO_MIGRATION.md`）。
 *
 * **故意不钉版本**：引导只负责"装上"，装的是仓库默认分支最新版，之后跟版靠 `hermes plugins update`。
 * 把 40 位 SHA 写进 Prompt 会让每次插件发版都得改应用仓库（两处发布串在一起），而收益只是"新机器装到
 * 某个旧版"。要复现某次部署时用 `--ref <SHA>`，那属于运维手册，不属于引导 Prompt。
 */

import doc from '../../docs/requirements/hermes-bootstrap-prompt.md?raw'

const TEXT_FENCE = /```text\r?\n([\s\S]*?)```/

/**
 * 插件仓库地址（`hermes plugins install` 的 `repo` 参数）。
 * 公开仓库，安装不需要任何凭据。
 */
export const PLUGIN_REPO = 'https://github.com/T-Chen-CN/pi-workbench-plugin.git'

/** 取出文档里第一个 ```text 代码块（统一换行、去掉首尾空行） */
export function extractPromptBlock(markdown: string): string {
  const match = TEXT_FENCE.exec(markdown)
  if (!match) return ''
  return match[1].replace(/\r\n?/g, '\n').trim()
}

/** 把文档里的占位符换成真实值（纯函数，便于单测；用 split/join 而不是 replaceAll：tsconfig 锁在 ES2020） */
export function fillPromptPlaceholders(block: string): string {
  return block.split('{{PLUGIN_REPO}}').join(PLUGIN_REPO)
}

export const HERMES_BOOTSTRAP_PROMPT = fillPromptPlaceholders(extractPromptBlock(doc))
