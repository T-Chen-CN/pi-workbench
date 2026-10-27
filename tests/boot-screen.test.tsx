// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BootScreen } from '../src/components/BootScreen'
import { useI18nStore } from '../src/store/i18nStore'
import { translations } from '../src/i18n/translations'

const html = readFileSync(resolve(__dirname, '../src/index.html'), 'utf-8')
const css = readFileSync(resolve(__dirname, '../src/index.css'), 'utf-8')

function readVars(block: string | undefined): Record<string, string> {
  const vars: Record<string, string> = {}
  if (!block) return vars
  for (const match of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    vars[match[1]] = match[2].trim()
  }
  return vars
}

const paperTokens = readVars(css.match(/:root\s*{([\s\S]*?)}/)?.[1])
const inkTokens = readVars(css.match(/html\.dark\s*{([\s\S]*?)}/)?.[1])
const paperBoot = readVars(html.match(/:root\s*{([\s\S]*?)}/)?.[1])
const inkBoot = readVars(html.match(/html\.dark\s*{([\s\S]*?)}/)?.[1])

/** 启动页自己声明了一份颜色，必须与 index.css 的语义 token 保持一致 */
const PALETTE: Record<string, string> = {
  'boot-surface': 'surface',
  'boot-ink': 'ink',
  'boot-muted': 'ink-muted',
  'boot-accent': 'accent',
  'boot-accent-fg': 'accent-fg',
  'boot-hairline': 'line',
}

describe('static boot page', () => {
  it('uses the same palette as the design tokens', () => {
    for (const [bootVar, token] of Object.entries(PALETTE)) {
      expect(paperBoot[bootVar], `paper ${bootVar}`).toBe(paperTokens[token])
      expect(inkBoot[bootVar], `ink ${bootVar}`).toBe(inkTokens[token])
    }
  })

  it('never uses inline scripts (production CSP allows only self)', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
    expect(html).toContain('src="./boot.js"')
  })

  it('carries the boot markup and both language lines', () => {
    expect(html).toContain('class="boot"')
    expect(html).toContain('boot-status-zh')
    expect(html).toContain('boot-status-en')
    expect(html).toContain('-webkit-app-region: drag')
  })
})

describe('BootScreen', () => {
  afterEach(() => cleanup())

  it('renders the Chinese status line', () => {
    useI18nStore.getState().setLanguage('zh')
    render(<BootScreen />)
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText(translations.zh.bootStarting)).toBeTruthy()
  })

  it('follows the language store', () => {
    useI18nStore.getState().setLanguage('en')
    render(<BootScreen />)
    expect(screen.getByText(translations.en.bootStarting)).toBeTruthy()
  })
})
