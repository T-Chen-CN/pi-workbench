/**
 * 内置的 GitHub OAuth App 标识。
 *
 * clientId 是公开信息，随应用分发：所有设备共用同一个 OAuth App，
 * 新设备无需任何本地配置即可使用设备码登录。client secret 不进入应用，
 * 设备码流程也不需要它。环境变量仅用于 fork 或调试时覆盖。
 */

const BUILTIN_GITHUB_CLIENT_ID = 'Ov23liz9zmjL1W3FSTuI'

export function getGithubClientId(): string | null {
  const override = process.env.PI_WORKBENCH_GITHUB_CLIENT_ID?.trim()
  if (override) return override
  return BUILTIN_GITHUB_CLIENT_ID.trim() || null
}
