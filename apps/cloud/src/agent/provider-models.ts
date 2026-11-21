/**
 * 供应商模型清单（F-10 辅助）与配置探测（F-13 / A-16）。
 *
 * 两处用途共用同一段请求逻辑：设置页「刷新模型列表」要拿到 id 列表；配置轮换前要
 * 判断这份新配置到底可不可用（Key 是否有效、模型是否存在）。
 *
 * 这是**单管理员**部署的 SSRF 面：设备 token 就能让它去请求任意 http(s) 地址，
 * 所以只允许 http(s)、超时受限、响应截断，且永不回传供应商响应原文。
 */

/** 供应商 `/models` 的鉴权头（与桌面端 apiConfig:fetchModels 保持同一口径） */
export function modelsHeaders(provider: string, apiKey: string): Record<string, string> {
  return provider === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` }
}

export type ProviderModelsResult =
  | { ok: true; models: string[] }
  | {
      ok: false
      kind: 'invalid-url' | 'missing-key' | 'unreachable' | 'http-status' | 'bad-json'
      /** 供应商返回的 HTTP 状态（只有 `http-status` 有） */
      status?: number
      detail: string
    }

export async function fetchProviderModels(input: {
  provider: string
  apiUrl: string
  apiKey: string
  timeoutMs?: number
}): Promise<ProviderModelsResult> {
  const baseUrl = String(input.apiUrl ?? '')
    .trim()
    .replace(/\/+$/, '')
  if (!baseUrl || baseUrl.includes('your-api-endpoint')) {
    return { ok: false, kind: 'invalid-url', detail: 'A valid API URL is required' }
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, kind: 'invalid-url', detail: 'API URL must start with http:// or https://' }
  }
  if (!input.apiKey) {
    return { ok: false, kind: 'missing-key', detail: 'API key is required' }
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: modelsHeaders(input.provider, input.apiKey),
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      kind: 'unreachable',
      detail: `Cannot reach the provider: ${message.slice(0, 160)}`,
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return {
      ok: false,
      kind: 'http-status',
      status: response.status,
      detail: `Provider returned HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`,
    }
  }

  const text = (await response.text().catch(() => '')).slice(0, 256 * 1024)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, kind: 'bad-json', detail: 'Provider did not return JSON' }
  }

  // 兼容三种常见形状：{ data: [{ id }] } / { models: [...] } / [...]; 元素也可能是纯字符串
  const pick = (list: unknown[]): string[] =>
    list
      .map((item) =>
        typeof item === 'string'
          ? item
          : typeof item === 'object' && item !== null
            ? String((item as { id?: unknown; name?: unknown }).id ?? (item as { name?: unknown }).name ?? '')
            : ''
      )
      .filter((id) => id.length > 0)

  const record = data as { data?: unknown; models?: unknown } | null
  let models: string[] = []
  if (Array.isArray(data)) models = pick(data)
  else if (Array.isArray(record?.data)) models = pick(record.data)
  else if (Array.isArray(record?.models)) models = pick(record.models)

  return { ok: true, models: [...new Set(models)].sort() }
}

export interface ConfigProbeInput {
  provider: string
  apiUrl: string
  apiKey: string
  model: string
}

/**
 * 轮换前的探测：这份配置下一轮能不能真的跑起来。
 *
 * 为什么必须探测：`AgentManager.initialize()` 只校验「模型 id 在本地 models.json 里」，
 * 这个文件正是按 apiConfig 生成的，所以**任何 Key 都能初始化成功**——不探测的话，
 * 推一份错 Key 也会报「配置已生效」，直到用户下一句话才炸。
 *
 * 判定口径：拿得到清单就看模型在不在；供应商不提供 `/models`（404/405/501，少见）
 * 视为「无从验证」按可用处理；其余失败（连不上、401/403、坏 JSON）一律判不可用。
 */
export async function probeProviderConfig(
  input: ConfigProbeInput,
  timeoutMs = 6_000
): Promise<{ ok: true; warning?: string } | { ok: false; reason: string }> {
  const result = await fetchProviderModels({
    provider: input.provider,
    apiUrl: input.apiUrl,
    apiKey: input.apiKey,
    timeoutMs,
  })
  if (!result.ok) {
    if (result.kind === 'http-status' && [404, 405, 501].includes(result.status ?? 0)) {
      return { ok: true, warning: `供应商不提供模型清单（HTTP ${result.status}），无法验证 Key` }
    }
    return { ok: false, reason: result.detail }
  }
  if (result.models.length > 0 && !result.models.includes(input.model)) {
    const sample = result.models.slice(0, 5).join(', ')
    return {
      ok: false,
      reason: `供应商没有模型 ${input.model}（现有：${sample}${result.models.length > 5 ? '…' : ''}）`,
    }
  }
  return { ok: true }
}
