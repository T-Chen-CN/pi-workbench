/** 会话标题生成（首轮后，不阻塞聊天） */

import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'

const TITLE_TIMEOUT_MS = 15_000

/**
 * 标题本身很短，但推理型模型（如 deepseek-flash）会先花掉一批 reasoning token，
 * 预算太小时 content 会直接为空（finish_reason: length）。留足余量。
 */
const TITLE_MAX_TOKENS = 512

/** 交给模型的输入上限：环境说明很容易把话题信号挤掉，两侧都收紧 */
const USER_INPUT_LIMIT = 600
const ASSISTANT_INPUT_LIMIT = 400

/**
 * 环境说明类段落：描述「当前环境」而不是对话主题。
 * Agent 的首轮回复经常以这类段落开头（工作目录 / 已加载的规矩 / 工作树状态），
 * 不剔除会让标题变成项目名或路径。
 */
const ENV_PARAGRAPH_START =
  /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:工作目录|当前目录|当前环境|具体到当前环境|我已加载|已加载的规矩|工作树状态|当前工作区|需要我做什么|可用工具)(?:\*\*)?\s*[:：]?/

export interface TitleLogger {
  warn: (...args: unknown[]) => void
}

/** 剔除环境说明段落（含靠反引号代码占比很高的段落），全被剔时回退原文 */
function isCodeHeavy(paragraph: string): boolean {
  const codeChars = (paragraph.match(/`[^`]*`/g) ?? []).reduce((n, span) => n + span.length, 0)
  return paragraph.length > 0 && codeChars / paragraph.length > 0.35
}

export function stripEnvironmentNotes(text: string): string {
  const paragraphs = text.split(/\n{2,}/)
  const kept = paragraphs.filter((paragraph) => {
    const trimmed = paragraph.trim()
    if (!trimmed) return false
    if (ENV_PARAGRAPH_START.test(trimmed)) return false
    if (isCodeHeavy(trimmed)) return false
    return true
  })
  return kept.join('\n\n').trim() || text.trim()
}

export function buildTitlePrompt(userText: string, assistantText: string): string {
  return [
    '你是会话命名器。根据用户的第一句话和助手回复的摘录，给这段对话起一个标题。',
    '',
    '规则：',
    '- 标题描述这段对话在做什么（主题），不是复述第一句话',
    '- 不要用文件路径、项目名、工具名、工作区名当标题，除非对话主题就是它们',
    '- 与对话的主要语言一致；中文不超过 16 字，英文不超过 5 个词；不加引号、不加标点、不要解释',
    '- 寒暄或身份类对话用中性描述',
    '- 只输出 JSON：{"title": "标题"}',
    '',
    '示例：',
    '用户：你是谁？ / 助手：我是 pi 里的编码智能体，可以读写文件、跑命令 → {"title": "助手自我介绍"}',
    '用户：帮我修一下登录跳转 / 助手：已把 auth guard 里的重定向改成只跳一次 → {"title": "修复登录跳转死循环"}',
    '用户：检查当前项目的情况 / 助手：项目体检完成，三个门禁全部通过 → {"title": "项目门禁体检"}',
    '',
    `用户：${userText.slice(0, USER_INPUT_LIMIT)}`,
    `助手：${stripEnvironmentNotes(assistantText).slice(0, ASSISTANT_INPUT_LIMIT)}`,
  ].join('\n')
}

/** 模型输出的第一行做清洗，去掉引号与“标题：”前缀 */
export function normalizeSessionTitle(raw: string): string {
  return raw
    .split(/\r?\n/)[0]
    .replace(/^(标题|title)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .trim()
    .slice(0, 40)
}

/** 解析模型回复：优先取 JSON 的 title 字段（可能包在代码块里），否则退回首行清洗 */
export function parseTitleResponse(raw: string): string {
  const text = raw.trim()
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { title?: unknown }
      if (typeof parsed?.title === 'string' && parsed.title.trim()) {
        return normalizeSessionTitle(parsed.title)
      }
    } catch {
      // 不是合法 JSON：落到首行解析
    }
  }
  return normalizeSessionTitle(text)
}

/** 标题与用户原话完全一样时等于没有命名（回退标题就是原话），判为不可用 */
export function isEchoOfUserText(title: string, userText: string): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[\s"'“”‘’`.,，。!！?？:：;；…~·\-—_/\\()（）[\]【】]/g, '')
      .trim()
  const left = normalize(title)
  const right = normalize(userText)
  return Boolean(left) && left === right
}

/** 只需要 `completeSimple`，测试注入替身即可（不必起真运行时） */
export interface TitleModelRunner {
  completeSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions
  ): Promise<AssistantMessage>
}

/**
 * 用当前会话的模型生成一个短标题。
 *
 * 走 SDK 的 `completeSimple`，协议差异（responses / messages / completions /
 * codex）由 catalog 决定，这里不再按 URL 猜接口，也不用自己拿 key 发请求（D3）。
 * 标题请求显式 `reasoning: 'off'`：推理预算会把内容挤空。
 */
export async function requestSessionTitle(
  runner: TitleModelRunner,
  model: Model<Api>,
  prompt: string,
  logger: TitleLogger
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
  timer.unref?.()
  try {
    const message = await runner.completeSimple(
      model,
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }],
            timestamp: Date.now(),
          } as Context['messages'][number],
        ],
      },
      {
        // 请求级 ThinkingLevel 没有 'off'（只有 minimal…max），所以这里不指定档位；
        // 靠小 maxTokens + 失败重试兜住「推理把预算吃光」的情况
        maxTokens: TITLE_MAX_TOKENS,
        temperature: 0.2,
        signal: controller.signal,
      }
    )
    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('')
    if (text.trim()) return text
    // 预算被推理吃光时这里会是空字符串，交给调用方决定是否重试
    logger.warn(
      '[Agent Manager] Title generation returned no text:',
      JSON.stringify({ stopReason: message.stopReason, model: message.model })
    )
    return null
  } catch (error) {
    logger.warn('[Agent Manager] Title generation failed:', error)
    return null
  } finally {
    clearTimeout(timer)
  }
}
