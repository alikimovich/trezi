// The app's Shiki bundle (LKM-183) runs outside the checkout: it builds the bundle and a
// CJS copy of the backend's loader exactly as scripts/build-native.mjs does, into a temp
// folder with no node_modules above it, and highlights TSX there in a child Bun with
// auto-install off. Also checks that grammars stay lazy chunks and only the editor's
// languages ship.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import {
  buildSyntaxBundle,
  SYNTAX_BUNDLE_BANNER,
  SYNTAX_BUNDLE_DEFINE
} from '../scripts/syntax-bundle.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-syntax-bundle-')))
assert.ok(relative(root, dir).startsWith('..'), 'the copy lives outside the checkout')
try {
  const metafile = await buildSyntaxBundle(root, join(dir, 'syntax'))
  const loader = await build({
    entryPoints: [join(root, 'src/main/syntax-shiki.ts')],
    outfile: join(dir, 'index.cjs'),
    bundle: true,
    platform: 'node',
    target: 'es2022',
    format: 'cjs',
    packages: 'external',
    metafile: true,
    define: SYNTAX_BUNDLE_DEFINE,
    banner: { js: SYNTAX_BUNDLE_BANNER },
    logLevel: 'warning'
  })
  const imports = Object.values(loader.metafile.outputs).flatMap((output) => output.imports)
  assert.deepEqual(
    imports.filter((item) => item.external).map((item) => item.path),
    [],
    'the loader imports no package'
  )

  // Highlight in a child Bun whose working directory is the temp folder.
  const probe = join(dir, 'probe.cjs')
  writeFileSync(
    probe,
    `const { syntaxTokenizer, SYNTAX_SHIKI_MODULE } = require('./index.cjs')
const started = performance.now()
syntaxTokenizer('tsx').then((tokenizer) => {
  const { tokens } = tokenizer.tokenizeLine2('const a = <div className="x" />', null)
  const categories = []
  for (let i = 1; i < tokens.length; i += 2) categories.push(tokenizer.category(tokens[i]))
  console.log(JSON.stringify({ module: SYNTAX_SHIKI_MODULE, ms: performance.now() - started, categories }))
}, (error) => { console.error(String(error.message)); process.exit(1) })
`
  )
  const child = spawnSync(process.execPath, ['--no-install', probe], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
    timeout: 60_000
  })
  assert.equal(child.status, 0, `Shiki loads outside the checkout: ${child.stderr}`)
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1))
  assert.equal(result.module, join(dir, 'syntax/shiki.mjs'))
  assert.ok(
    result.categories.some((c) => c > 0),
    `TSX tokens carry categories: ${child.stdout}`
  )

  // Lazy grammars: the entry holds no grammar, each editor language is its own chunk,
  // and grammars the editor does not use are not shipped.
  const entry = readFileSync(join(dir, 'syntax/shiki.mjs'), 'utf8')
  assert.ok(!entry.includes('"displayName":'), 'no grammar in the entry module')
  const inputs = Object.keys(metafile.inputs)
  const grammars = inputs
    .map((path) => /@shikijs\/langs\/dist\/([^/]+)\.mjs$/.exec(path)?.[1])
    .filter(Boolean)
    .sort()
  for (const name of ['tsx', 'css', 'swift', 'svelte', 'vue', 'yaml', 'shellscript', 'mdx'])
    assert.ok(grammars.includes(name), `${name} grammar ships`)
  for (const name of ['python', 'rust', 'cpp', 'java']) assert.ok(!grammars.includes(name), name)
  assert.ok(
    !inputs.some((path) => /@shikijs\/themes\//.test(path)),
    'no bundled themes: the editor uses its category theme'
  )
  const chunks = readdirSync(join(dir, 'syntax/chunks'))
  const size = (path) => statSync(path).size
  const total = chunks.reduce(
    (sum, name) => sum + size(join(dir, 'syntax/chunks', name)),
    size(join(dir, 'syntax/shiki.mjs'))
  )
  assert.ok(chunks.length >= 16, `${chunks.length} lazy chunks`)
  console.log(
    `SYNTAX-BUNDLE: entry ${(entry.length / 1024).toFixed(0)} KB, ${chunks.length} chunks, ${(total / 1024 / 1024).toFixed(2)} MB total; ${grammars.length} grammars (${grammars.join(', ')}); first TSX tokenizer outside the checkout ${result.ms.toFixed(0)} ms`
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(
  'SYNTAX-BUNDLE OK — Shiki loads from the app bundle outside the checkout, grammars lazy'
)
