import { describe, expect, it } from 'vitest'
import { extractPromptBlock, HERMES_BOOTSTRAP_PROMPT } from '../src/utils/hermesPrompt'

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
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('# hermes-handoff v1.1')
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('DASHBOARD_SESSION_TOKEN=')
    expect(HERMES_BOOTSTRAP_PROMPT).toContain('API_SERVER_KEY')
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

  it('normalises CRLF from the doc and trims blank edges', () => {
    expect(extractPromptBlock('```text\r\nline one\r\nline two\r\n```')).toBe('line one\nline two')
    expect(extractPromptBlock('```text\n\nbody\n\n```')).toBe('body')
  })
})
