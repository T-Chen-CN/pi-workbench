/** 会话标题生成（首轮后，不阻塞聊天） */

import type { ApiConfigInput } from './model-config.js'

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

/** 用配置的供应商生成一个短标题（OpenAI 兼容 / Anthropic） */
export async function requestSessionTitle(
  apiConfig: ApiConfigInput,
  prompt: string,
  logger: TitleLogger
): Promise<string | null> {
  const { provider, apiUrl, apiKey, selectedModel } = apiConfig
  const base = apiUrl.replace(/\/+$/, '')
  if (!base) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
  try {
    if (provider === 'anthropic') {
      const response = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: selectedModel,
          max_tokens: TITLE_MAX_TOKENS,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as any
      const text = data?.content?.[0]?.text
      if (typeof text === 'string' && text.trim()) return text
      logger.warn(
        '[Agent Manager] Title generation returned no text:',
        JSON.stringify({ stopReason: data?.stop_reason })
      )
      return null
    }

    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: TITLE_MAX_TOKENS,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = (await response.json()) as any
    const choice = data?.choices?.[0]
    const content = choice?.message?.content
    if (typeof content === 'string' && content.trim()) return content
    // 推理型模型把预算花在 reasoning 上时这里会是空字符串，交给调用方决定是否重试
    logger.warn(
      '[Agent Manager] Title generation returned no text:',
      JSON.stringify({ finishReason: choice?.finish_reason, content: content ?? null })
    )
    return null
  } catch (error) {
    logger.warn('[Agent Manager] Title generation failed:', error)
    return null
  } finally {
    clearTimeout(timer)
  }
}
