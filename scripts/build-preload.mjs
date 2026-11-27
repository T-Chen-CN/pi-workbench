import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

await build({
  entryPoints: [path.join(root, 'electron/preload.cts')],
  outfile: path.join(root, 'dist-electron/preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'silent',
})
