// 把 6 个 SVG、字体与应用占位图内联进 preview.html，产出自包含的提案页。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
// 可选的目录参数，例如 `node build.mjs set-b`
const dir = process.argv[2] ? join(here, process.argv[2]) : here

const b64 = (path) => readFileSync(join(root, path)).toString('base64')
const fonts = {
  '{{FONT_DISPLAY}}': b64('node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2'),
  '{{FONT_MONO}}': b64('node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2'),
  '{{ICON_CURRENT}}': `data:image/png;base64,${b64('app-icon.png')}`,
}

const concepts = readdirSync(dir)
  .filter((file) => file.endsWith('.svg'))
  .map((file) => file.slice(0, -4))

for (const source of readdirSync(dir).filter((file) => file.endsWith('.src.html'))) {
  let html = readFileSync(join(dir, source), 'utf-8')

  for (const name of concepts) {
    const svg = readFileSync(join(dir, `${name}.svg`), 'utf-8')
      .replace(/^<\?xml[^>]*>\s*/, '')
      .replace('<svg ', '<svg class="glyph" ')
      .trim()
    html = html.split(`{{SVG:${name}}}`).join(svg)
  }

  for (const [token, value] of Object.entries(fonts)) {
    html = html.split(token).join(value)
  }

  const leftover = html.match(/\{\{[^}]+\}\}/g)
  if (leftover) throw new Error(`${source}: 未替换的占位符: ${leftover.join(', ')}`)

  const target = source.replace(/\.src\.html$/, '.html')
  writeFileSync(join(dir, target), html)
  console.log(`${target} written (${(html.length / 1024).toFixed(1)} KB)`)
}
