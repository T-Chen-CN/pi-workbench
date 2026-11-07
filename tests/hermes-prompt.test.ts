import { describe, expect, it } from 'vitest'
import {
  extractPromptBlock,
  fillPromptPlaceholders,
  HERMES_BOOTSTRAP_PROMPT,
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
    // 六个步骤与连接码交付都在
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('## 第六步：生成一次性连接码并交付')
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('/v1/devices/pairing')
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('pairingUrl')
    // Phase 1 起只认一次性连接码：不写文件、不导入凭证、不把管理密钥交给桌面端
    expect(HERMES_BOOTSTRAP_PROMPT).not.toContain('从文件导入')
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('不得在对话里输出任何明文密钥')
  })

  it('keeps the prompt free of real credentials', () => {
    // 复制出去的内容不能带任何真实凭据，也不能再有凭证文件模板行
    expect(HERMES_BOOTSTRAP_PROMPT).not.toMatch(/^ADMIN_KEY=/m)
    expect(HERMES_BOOTSTRAP_PROMPT).not.toMatch(/^GATEWAY_URL=/m)
    expect(HERMES_BOOTSTRAP_PROMPT).not.toMatch(/^DASHBOARD_PASSWORD=/m)
    expect(HERMES_BOOTSTRAP_PROMPT).not.toContain('API_KEY=')
  })

  it('returns an empty string when the fence is missing', () => {
    expect(extractPromptBlock('# 只有说明，没有代码块')).toBe('')
    expect(extractPromptBlock('```bash\necho hi\n```')).toBe('')
  })

  // 插件有自己的仓库（见 docs/requirements/CLOUD_AGENT.md）：文档里只留占位符，
  // 真实地址由 PLUGIN_REPO 注入 —— 复制出去的内容里不能残留 {{…}}。
  it('injects the plugin repo, and never pins a version', () => {
    expect(PLUGIN_REPO.startsWith('https://')).toBe(true)
    expect(HERMES_BOOTSTRAP_PROMPT).not.toContain('{{')
    expect(HERMES_BOOTSTRAP_PROMPT).not.toContain('}}')
    expect(HERMES_BOOTSTRAP_PROMPT).toContain(PLUGIN_REPO)
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('hermes plugins install')
    // 引导装默认分支最新版：钉了 SHA 就等于每次插件发版都要改应用仓库（两处发布串在一起）
    expect(HERMES_BOOTSTRAP_PROMPT).not.toContain('--ref')
    expect(HERMES_BOOTSTRAP_PROMPT).not.toMatch(/[0-9a-f]{40}/)
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('hermes plugins update')
  })

  it('only rewrites the known placeholder', () => {
    expect(fillPromptPlaceholders('a {{PLUGIN_REPO}} b')).toBe(`a ${PLUGIN_REPO} b`)
    // 未知占位符原样保留（不会被静默翻译成空串）
    expect(fillPromptPlaceholders('{{SOMETHING_ELSE}}')).toBe('{{SOMETHING_ELSE}}')
  })

  it('normalises CRLF from the doc and trims blank edges', () => {
    expect(extractPromptBlock('```text\r\nline one\r\nline two\r\n```')).toBe('line one\nline two')
    expect(extractPromptBlock('```text\n\nbody\n\n```')).toBe('body')
  })
})
