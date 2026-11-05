/**
 * Hermes 自举 Prompt 的运行时副本。
 *
 * 唯一的事实源是 `docs/requirements/hermes-bootstrap-prompt.md`（规范原文，含判读说明）。
 * 打包只带 `dist/`，运行时读不到 `docs/`，所以这里用 vite 的 `?raw` 在**构建时**把
 * 那份文档内联进来，再取出其中唯一的 ```text 代码块。
 *
 * 因此：改 Prompt 只改文档，应用里自动跟着变；`tests/hermes-prompt.test.ts` 守住
 * 「代码块存在、内容完整」这条，防止文档被改坏后按钮复制出一段残缺文本。
 */

import doc from '../../docs/requirements/hermes-bootstrap-prompt.md?raw'

const TEXT_FENCE = /```text\r?\n([\s\S]*?)```/

/** 取出文档里第一个 ```text 代码块（统一换行、去掉首尾空行） */
export function extractPromptBlock(markdown: string): string {
  const match = TEXT_FENCE.exec(markdown)
  if (!match) return ''
  return match[1].replace(/\r\n?/g, '\n').trim()
}

export const HERMES_BOOTSTRAP_PROMPT = extractPromptBlock(doc)
