/**
 * 统一的子进程环境变量脱敏（终端 PTY、工作树依赖安装、Git 子进程与云端任务共用）。
 *
 * 原则：Windows 环境变量名大小写不敏感，所有精确键与前缀一律按大写比对；
 * 宁可多剥离通用密文命名后缀，也不让主进程注入的供应商/联网/云端凭据泄漏给子进程。
 */

export const SENSITIVE_ENV_EXACT_KEYS = new Set<string>([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'PERPLEXITY_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'NPM_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
])

export const SENSITIVE_ENV_PREFIXES = ['PI_WORKBENCH_', 'PI_CODING_AGENT_'] as const

export const SENSITIVE_ENV_PATTERN =
  /^(?:.*_(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|SECRET_KEY|ACCESS_TOKEN|PRIVATE_KEY))$/i

export function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  if (SENSITIVE_ENV_EXACT_KEYS.has(upper)) return true
  if (SENSITIVE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true
  return SENSITIVE_ENV_PATTERN.test(key)
}

/** 剥离所有已知供应商密钥、应用内部凭据与常见密文环境变量，返回新的干净副本 */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (isSensitiveEnvKey(key)) continue
    sanitized[key] = value
  }
  return sanitized
}
