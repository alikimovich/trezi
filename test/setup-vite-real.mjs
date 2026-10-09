// LKM-153: real Vite 7 (esbuild) and Vite 8 (Oxc) React fixtures, wired the way the setup
// prompt asks (`trezi()` first in plugins), serve modules with data-trezi-source stamps.
// Installs each fixture from the registry; prints SKIP when that is not possible. Vite
// runs in Node, as a project's dev server does, in middleware mode (no port).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REACT_HELPER_CONTENT } from '../src/main/setup-react.ts'
import { VITE_HELPER_CONTENT } from '../src/main/setup-vite.ts'

const APP =
  'export function Card({ label }) {\n  return <button className="card">{label}</button>\n}\nexport default function App() {\n  return <main><h1>Swiftly</h1><Card label="Go" /><Avatar /></main>\n}\nimport styles from "./themer-admin/Account.module.css"\nexport function Avatar() {\n  return <img className={styles.accountAvatar} src="/avatar.png" alt="Account" />\n}\n'
const CONFIG =
  "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nimport trezi from './.trezi/trezi-vite.mjs'\n\nexport default defineConfig({ plugins: [trezi(), react()] })\n"
// Exits by itself: closing a middleware-mode server can leave a promise no handle settles.
const DRIVER = `import { readFileSync } from 'node:fs'
import { createServer } from 'vite'
try {
  const version = JSON.parse(readFileSync('node_modules/vite/package.json', 'utf8')).version
  const server = await createServer({ configFile: 'vite.config.mjs', logLevel: 'warn', appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false } })
  const result = await server.transformRequest('/src/App.jsx')
  console.log('TREZI-RESULT ' + JSON.stringify({ code: result ? result.code : '', version }))
  process.exit(0)
} catch (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
}
`

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-setup-vite-real-')))
try {
  for (const [vite, plugin] of [
    ['^7.1.0', '^5.0.0'],
    ['^8.0.0', '^6.0.0']
  ]) {
    const root = join(dir, `vite-${vite.replace(/\D/g, '')}`)
    mkdirSync(join(root, 'src/themer-admin'), { recursive: true })
    mkdirSync(join(root, '.trezi'))
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        private: true,
        type: 'module',
        dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0' },
        devDependencies: { vite, '@vitejs/plugin-react': plugin, '@babel/core': '^7.28.0' }
      })
    )
    writeFileSync(join(root, 'vite.config.mjs'), CONFIG)
    writeFileSync(join(root, 'src/App.jsx'), APP)
    writeFileSync(
      join(root, 'src/themer-admin/Account.module.css'),
      '.accountAvatar { width: 32px; }\n'
    )
    writeFileSync(join(root, '.trezi/trezi-source.cjs'), REACT_HELPER_CONTENT)
    writeFileSync(join(root, '.trezi/trezi-vite.mjs'), VITE_HELPER_CONTENT)
    writeFileSync(join(root, 'driver.mjs'), DRIVER)
    const installed = spawnSync('bun', ['install', '--no-save'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 180_000
    })
    if (installed.status !== 0) {
      console.log(
        `SETUP-VITE-REAL SKIP — could not install the Vite ${vite} fixture: ${(installed.stderr || installed.stdout || String(installed.error)).slice(0, 240)}`
      )
      process.exit(0)
    }
    const run = spawnSync('node', ['driver.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, NODE_ENV: 'development' }
    })
    assert.equal(
      run.status,
      0,
      `Vite ${vite} dev server (${run.signal ?? run.error ?? 'exited'}): ${run.stderr}\n${run.stdout}`.slice(
        0,
        3000
      )
    )
    const line = run.stdout.split('\n').find((text) => text.startsWith('TREZI-RESULT '))
    assert.ok(line, `Vite ${vite} printed no result: ${run.stdout.slice(0, 1000)}`)
    const { code, version } = JSON.parse(line.slice('TREZI-RESULT '.length))
    assert.equal(
      Number(version.split('.')[0]),
      Number(vite.replace(/\D/g, '')[0]),
      `installed Vite ${version}`
    )
    for (const at of ['2:9', '5:9', '5:15']) {
      assert.match(
        code,
        new RegExp(`data-trezi-source["']?\\s*:\\s*["']src/App\\.jsx:${at}["']`),
        `Vite ${version} serves the stamp for ${at}`
      )
    }
    assert.match(code, /data-trezi-component-source["']?\s*:\s*["']src\/App\.jsx:5:31["']/)
    assert.match(
      code,
      /data-trezi-source["']?\s*:\s*["']src\/App\.jsx:9:9["']/,
      'img in CSS-module component is stamped'
    )
    assert.doesNotMatch(run.stderr, /\[trezi-source\]/, 'the plugin reported no problem')
    console.log(`Vite ${version}: the React fixture's modules carry data-trezi-source`)
  }
  console.log(
    'SETUP-VITE-REAL OK: Vite 7 and Vite 8 React fixtures are stamped by the Trezi plugin'
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
