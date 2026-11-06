import { describe, expect, it } from 'vitest'
import {
  extractPromptBlock,
  fillPromptPlaceholders,
  HERMES_BOOTSTRAP_PROMPT,
  PLUGIN_REF,
  PLUGIN_REPO,
} from '../src/utils/hermesPrompt'

describe('hermes bootstrap prompt', () => {
  it('inlines the fenced block from the requirement doc', () => {
    // 构建时用 ?raw 内联 docs/requirements/hermes-bootstrap-prompt.md
    expect(HERMES_BOOTSTRAP_PROMPT.length).toBeGreaterThan(2000)
    expect(HERMES_BOOTSTRAP_PROMPT.startsWith('# 任务：')).toBe(true)
    // 代码块之外的说明文字不该被带进去
    expect(HERMES_BOOTSTRAP_PROMPT).not.toContain('> 用途：用户把下方代码块')
    expect(HERMES_BOOTSTRAP_PROMPT).not.toContain('```')
    // 六个步骤与交付格式都在
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('## 第五步：交付')
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('# hermes-handoff v2')
    // v2 = 单入口：网关地址 + 管理密钥，不再有 api key / 控制台会话令牌
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('GATEWAY_URL=')
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('ADMIN_KEY=')
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('ADMIN_KEY_CONFIGURED=')
    expect(HERMES_BOOTSTRAP_PROMPT).not.toContain('DASHBOARD_SESSION_TOKEN=')
    expect(HERMES_BOOTSTRAP_PROMPT).not.toContain('API_SERVER_KEY')
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('绝对不要')
  })

  it('keeps the prompt free of real credentials', () => {
    // 交接文件模版里的密钥只能是空占位符（复制出去的内容不能带任何真实凭据）
    const templateLines = HERMES_BOOTSTRAP_PROMPT.split('\n').filter(
      (line) => line.startsWith('API_KEY=') || line.startsWith('DASHBOARD_PASSWORD=')
    )
    expect(templateLines.length).toBeGreaterThan(0)
    for (const line of templateLines) {
      expect(['API_KEY=', 'DASHBOARD_PASSWORD=']).toContain(line)
    }
  })

  it('returns an empty string when the fence is missing', () => {
    expect(extractPromptBlock('# 只有说明，没有代码块')).toBe('')
    expect(extractPromptBlock('```bash\necho hi\n```')).toBe('')
  })

  // 插件有自己的仓库（见 docs/guides/PLUGIN_REPO_MIGRATION.md）：文档里只留占位符，
  // 真实地址与版本由 PLUGIN_REPO / PLUGIN_REF 注入 —— 复制出去的内容里不能残留 {{…}}。
  it('injects the plugin repo and an immutable SHA ref', () => {
    expect(PLUGIN_REF).toMatch(/^[0-9a-f]{40}$/)
    expect(PLUGIN_REPO.startsWith('https://')).toBe(true)
    expect(HERMES_BOOTSTRAP_PROMPT).not.toContain('{{')
    expect(HERMES_BOOTSTRAP_PROMPT).not.toContain('}}')
    expect(HERMES_BOOTSTRAP_PROMPT).toContain(PLUGIN_REPO)
    expect(HERMES_BOOTSTRAP_PROMPT).toContain(`--ref ${PLUGIN_REF}`)
    // 装插件那条命令只能来自指定仓库，不能出现别的来源或可移动引用
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('hermes plugins install')
    expect(HERMES_BOOTSTRAP_PROMPT).not.toContain('--ref main')
  })

  it('only rewrites the two known placeholders', () => {
    expect(fillPromptPlaceholders('a {{PLUGIN_REPO}} b {{PLUGIN_REF}} c')).toBe(
      `a ${PLUGIN_REPO} b ${PLUGIN_REF} c`
    )
    // 未知占位符原样保留（不会被静默翻译成空串）
    expect(fillPromptPlaceholders('{{SOMETHING_ELSE}}')).toBe('{{SOMETHING_ELSE}}')
  })

  it('normalises CRLF from the doc and trims blank edges', () => {
    expect(extractPromptBlock('```text\r\nline one\r\nline two\r\n```')).toBe('line one\nline two')
    expect(extractPromptBlock('```text\n\nbody\n\n```')).toBe('body')
  })
})
