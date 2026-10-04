// LKM-153: Connect to Trezi picks the stamping path by framework and Vite version. React on
// Vite 7 and 8 (plugin-react or -swc) gets Trezi's pre-transform Vite plugin, because
// Vite 8 transforms JSX with Oxc and plugin-react 6 has no babel option; React without
// Vite keeps the Babel plugin, Next keeps its loader (test/setup-next.mjs stamps it) and
// a plain HTML project is stamped at serve time (test/html-source.mjs), so it gets no
// card. The plugin is exercised with the real @babel/core. The chat-worktree flow is
// test/setup-worktree.mjs.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stampHtml } from '../src/main/html-source.ts'
import { detect, helperFiles } from '../src/main/setup.ts'
import { REACT_HELPER_CONTENT } from '../src/main/setup-react.ts'
import { VITE_HELPER, VITE_HELPER_CONTENT } from '../src/main/setup-vite.ts'
import { setupPrompt } from '../src/shared/setup-prompt.ts'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-setup-vite-')))
let count = 0
function project(pkg, installed = {}) {
  const root = join(dir, `p${++count}`)
  mkdirSync(root, { recursive: true })
  if (pkg) writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
  for (const [name, version] of Object.entries(installed)) {
    mkdirSync(join(root, 'node_modules', name), { recursive: true })
    writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }))
  }
  return root
}
let serial = 0
async function plugin(root) {
  mkdirSync(join(root, '.trezi'), { recursive: true })
  writeFileSync(join(root, '.trezi/trezi-source.cjs'), REACT_HELPER_CONTENT)
  // A fresh file per load: an ES module is evaluated once per URL.
  const file = join(root, `.trezi/trezi-vite-${++serial}.mjs`)
  writeFileSync(file, VITE_HELPER_CONTENT)
  const instance = (await import(pathToFileURL(file).href)).default()
  const warnings = []
  instance.configResolved({ root, logger: { warn: text => warnings.push(text) } })
  return { instance, warnings }
}

const previous = process.env.NODE_ENV
try {
  // Detection: Vite 8 installed (declared range alone also gives the major), Vite 7 with SWC.
  const vite8 = await detect(project({ dependencies: { react: '^19.2.0' }, devDependencies: { vite: '^8.0.0', '@vitejs/plugin-react': '^6.0.0' } },
    { vite: '8.0.3', '@vitejs/plugin-react': '6.0.1' }))
  assert.deepEqual(vite8, { framework: 'react', strategy: 'vite-plugin',
    vite: { version: '8.0.3', declaredVersion: '^8.0.0', major: 8, reactPlugin: '@vitejs/plugin-react', reactPluginVersion: '6.0.1' } })
  assert.equal((await detect(project({ dependencies: { react: '^19.0.0' }, devDependencies: { vite: '^8.0.0' } }))).vite.major, 8)
  const vite7 = await detect(project({ dependencies: { react: '^18.3.1' }, devDependencies: { vite: '^7.1.0', '@vitejs/plugin-react-swc': '^4.0.0' } },
    { vite: '7.1.12' }))
  assert.equal(vite7.strategy, 'vite-plugin')
  assert.equal(vite7.vite.major, 7)
  assert.equal(vite7.vite.reactPlugin, '@vitejs/plugin-react-swc')
  assert.equal(vite7.vite.reactPluginVersion, '^4.0.0', 'the declared range when the plugin is not installed')
  // Other builds keep their own paths.
  assert.deepEqual(await detect(project({ dependencies: { react: '^19.0.0' }, devDependencies: { webpack: '^5.0.0' } })), { framework: 'react', strategy: 'babel-plugin' })
  const next = await detect(project({ dependencies: { next: '16.0.0', react: '^19.0.0' } }))
  assert.equal(next.strategy, 'next-loader')
  assert.ok(!helperFiles(next).some(file => file.path === VITE_HELPER))
  const html = project(null)
  writeFileSync(join(html, 'index.html'), '<!doctype html><html><body><h1>Hi</h1></body></html>')
  assert.deepEqual(await detect(html), { framework: 'unknown', strategy: 'none' })
  assert.deepEqual(helperFiles(await detect(html)), [], 'no helper, so no card: the dev server stamps HTML itself')
  assert.match(await stampHtml('<!doctype html><html><body><h1>Hi</h1></body></html>', 'index.html'), /<h1 data-trezi-source="index\.html:1:\d+">/)
  assert.deepEqual(helperFiles(vite8).map(file => file.path), ['.trezi/trezi-source.cjs', VITE_HELPER])

  // The prompt wires the plugin, never plugin-react's removed babel option.
  const prompt = setupPrompt({ ok: true, framework: 'react', strategy: 'vite-plugin', vite: vite8.vite, files: helperFiles(vite8).map(f => f.path),
    helpers: [{ path: '.trezi/trezi-source.cjs', sha256: 'a'.repeat(64) }, { path: VITE_HELPER, sha256: 'b'.repeat(64) }], checkout: '/w/chat' })
  assert.match(prompt, /Vite 8\.0\.3 with @vitejs\/plugin-react 6\.0\.1/)
  assert.match(prompt, /do NOT use `react\(\{ babel \}\)`/)
  assert.match(prompt, /`trezi\(\)` FIRST/)
  assert.match(prompt, /@babel\/core/)
  assert.match(prompt, /\.trezi\/trezi-vite\.mjs: SHA-256 b{64}/)
  assert.match(prompt, /copied them into this chat workspace \(\/w\/chat\).*Never write \.trezi\/ yourself/)

  // The plugin: serve-only, before Vite's JSX transform, the same stamps as the Babel path.
  process.env.NODE_ENV = 'development'
  const app = project({ type: 'module', devDependencies: { vite: '^8.0.0' } })
  symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(app, 'node_modules'), 'dir')
  const { instance, warnings } = await plugin(app)
  assert.equal(instance.name, 'trezi-source')
  assert.equal(instance.apply, 'serve')
  assert.equal(instance.enforce, 'pre')
  assert.deepEqual(warnings, [])
  const TSX = 'type P = { title: string }\nexport function Panel({ title }: P) {\n  return <section><h2>{title}</h2></section>\n}\n'
  const out = instance.transform(TSX, join(app, 'src/Panel.tsx'))
  assert.match(out.code, /<section data-trezi-source="src\/Panel\.tsx:3:9">/)
  assert.match(out.code, /<h2 data-trezi-source="src\/Panel\.tsx:3:18">/)
  assert.match(out.code, /type P = \{/, 'types stay for Vite to strip')
  assert.ok(out.map.mappings)
  assert.match(instance.transform('export const A = () => <div />\n', join(app, 'src/A.jsx?t=1')).code, /src\/A\.jsx:1:23/)
  for (const id of ['\0virtual:x.jsx', join(app, 'node_modules/lib/x.jsx'), join(app, 'src/util.ts'), join(app, 'src/data.js')]) {
    assert.equal(instance.transform('export const a = <div />', id), null, id)
  }
  assert.equal(instance.transform('export const a = 1', join(app, 'src/A.tsx')), null)
  const broken = instance.transform('export const A = () => <div>\n', join(app, 'src/Broken.jsx'))
  assert.equal(broken, null, 'Vite reports the syntax error itself')
  assert.match(warnings.at(-1), /^\[trezi-source\] could not map src\/Broken\.jsx: /)

  // Why a project has no stamps, in the dev server log the card quotes.
  // Vite is installed, so a node_modules folder exists: without one, Bun auto-installs
  // @babel/core from its global cache and the result depends on that cache (LKM-154).
  const bare = await plugin(project({ type: 'module', devDependencies: { vite: '^8.0.0' } }, { vite: '8.0.0' }))
  assert.deepEqual(bare.warnings, ['[trezi-source] @babel/core is not installed, so elements are not mapped to source. Add it to devDependencies.'])
  assert.equal(bare.instance.transform('export const a = <div />', join(dir, 'x.jsx')), null)
  process.env.NODE_ENV = 'production'
  const prod = await plugin(app)
  assert.deepEqual(prod.warnings, [])
  assert.equal(prod.instance.transform('export const a = <div />', join(app, 'src/A.jsx')), null, 'never stamps a production build')

  console.log('SETUP-VITE OK: Vite 7/8 React use the pre-transform plugin, Next and HTML keep their paths, plugin stamps JSX/TSX and reports why not')
} finally {
  if (previous === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previous
  rmSync(dir, { recursive: true, force: true })
}
