import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { build, stop } from 'esbuild'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const retired = /^(electron|electron-vite|playwright|react|react-dom|zustand|@codemirror)(\/|$)/
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
const packageName = (specifier) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
for (const dependency of Object.keys(pkg.dependencies))
  assert(!retired.test(dependency), `Retired app dependency: ${dependency}`)
for (const file of ['src/main/index.ts', 'src/preload', 'src/renderer', 'electron.vite.config.ts'])
  assert(!existsSync(file), `Retired entrypoint still exists: ${file}`)
const backend = await build({
  entryPoints: ['src/native/index.ts'],
  bundle: true,
  write: false,
  metafile: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  logLevel: 'silent'
})
for (const output of Object.values(backend.metafile.outputs)) {
  for (const { path, external } of output.imports) {
    if (!external) continue
    assert(!retired.test(path), `Retired runtime imported by native backend: ${path}`)
    assert(
      builtins.has(path) || pkg.dependencies[packageName(path)],
      `Undeclared runtime dependency: ${path}`
    )
  }
}
const preview = await build({
  entryPoints: ['src/preview/preload.ts'],
  bundle: true,
  write: false,
  metafile: true,
  platform: 'browser',
  format: 'iife',
  logLevel: 'silent'
})
for (const output of Object.values(preview.metafile.outputs))
  assert.equal(output.imports.length, 0, 'Isolated preview must be self-contained')
stop()
console.log(
  'NATIVE-BOUNDARY PASS — no Electron/renderer runtime; declared backend dependencies; self-contained WebKit instrumentation'
)
