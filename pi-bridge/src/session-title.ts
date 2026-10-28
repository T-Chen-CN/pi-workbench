/** 会话标题生成（首轮后，不阻塞聊天） */

import type { ApiConfigInput } from './model-config.js'

const TITLE_TIMEOUT_MS = 15_000

/**
 * 标题本身很短，但推理型模型（如 deepseek-flash）会先花掉一批 reasoning token，
 * 预算太小时 content 会直接为空（finish_reason: length）。留足余量。
 */
const TITLE_MAX_TOKENS = 512

export interface TitleLogger {
  warn: (...args: unknown[]) => void
}

export function buildTitlePrompt(userText: string, assistantText: string): string {
  return [
    '你是一个会话命名器。根据下面的对话生成一个简短标题。',
    '要求：只输出标题本身，不加引号、不加标点、不要解释；使用对话的主要语言；中文不超过 16 个字，英文不超过 8 个词。',
    '',
    `用户：${userText.slice(0, 800)}`,
    `助手：${assistantText.slice(0, 800)}`,
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
