// LKM-153: Connect to Trezi from a chat worktree. The swiftly-demos chat was parked by
// a stopped turn, so its worktree never received `.trezi/trezi-source.cjs` and the setup
// agent stopped. Trezi now copies the helpers into the chat's checkout itself (parked or
// not) before the setup turn; the wiring lands on the live checkout, whose copies the
// dev server loads, and the Vite 8 React fixture's JSX gets stamps. Runs through the
// Swift repository and editing owners (test/repository-owner.mjs, suites list); the
// Swift helper writer itself is covered by test/workflow-owner.mjs.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  afterTurn,
  beforeTurn,
  initChatIsolation,
  isolatedCwd,
  isolationSnapshot,
  releaseChat
} from '../src/main/chat-isolation.ts'
import { scaffold } from '../src/main/setup.ts'
import { setWorkflowOwner } from '../src/main/workflow-owner.ts'
import { setupPrompt } from '../src/shared/setup-prompt.ts'

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-setup-worktree-')))
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const sha = (data) => createHash('sha256').update(data).digest('hex')
const events = []
initChatIsolation({
  worktreesDir: () => join(dir, 'worktrees'),
  store: () => ({ get() {}, save() {}, remove() {} }),
  getWindow: () => ({
    webContents: { isDestroyed: () => false, send: (_, event) => events.push(event) }
  })
})
// Create-only, answering hashes, like the Swift writer (WorkflowSetup.setup).
setWorkflowOwner({
  writeHelpers: async (root, files) => {
    mkdirSync(join(root, '.trezi'), { recursive: true })
    let written = false
    const helpers = files.map(({ path, content }) => {
      if (!existsSync(join(root, path))) {
        writeFileSync(join(root, path), content)
        written = true
      }
      return { path, sha256: sha(readFileSync(join(root, path))) }
    })
    return { ok: true, written, helpers }
  }
})

const APP =
  'export function Card({ label }) {\n  return <button className="card">{label}</button>\n}\nexport function App() {\n  return <main><h1>Swiftly</h1><Card label="Go" /></main>\n}\n'
const CONFIG =
  "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({ plugins: [react()] })\n"
const WIRED =
  "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nimport trezi from './.trezi/trezi-vite.mjs'\n\nexport default defineConfig({ plugins: [trezi(), react()] })\n"

const previous = process.env.NODE_ENV
try {
  const root = join(dir, 'swiftly-demos'),
    key = 'setup-worktree'
  mkdirSync(join(root, 'src'), { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(root, '.gitignore'), 'node_modules\n.env\n')
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'swiftly-demos',
        private: true,
        type: 'module',
        scripts: { dev: 'vite' },
        dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0' },
        devDependencies: { vite: '^8.0.0', '@vitejs/plugin-react': '^6.0.0' }
      },
      null,
      2
    )
  )
  writeFileSync(join(root, 'vite.config.js'), CONFIG)
  writeFileSync(join(root, 'src/App.jsx'), APP)
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')

  // The incident's state: the chat's earlier turn was stopped, so its work is held.
  const cwd = await isolatedCwd(root, key)
  assert.notEqual(cwd, root, 'the chat runs in its own worktree')
  await beforeTurn(key, 'edit')
  writeFileSync(join(cwd, 'NOTES.md'), 'half-made edit\n')
  await afterTurn(key, 'Draft notes', [], 'failed')
  assert.equal(isolationSnapshot(key).state, 'parked')
  assert.equal(existsSync(join(cwd, '.trezi/trezi-source.cjs')), false)
  // The live project's installed packages: Trezi's @babel/core stands in for the project's
  // (no Vite in it, so the declared ^8 decides the version). Linked only now, so creating
  // the worktree above did not install a clone of them.
  symlinkSync(
    new URL('../node_modules', import.meta.url).pathname,
    join(root, 'node_modules'),
    'dir'
  )

  // Set up: the live helpers are written, then copied into the chat's checkout.
  const result = await scaffold(root, key)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.framework, 'react')
  assert.equal(result.strategy, 'vite-plugin')
  assert.equal(result.vite.major, 8)
  assert.equal(result.checkout, cwd)
  assert.deepEqual(
    result.helpers.map((h) => h.path),
    ['.trezi/trezi-source.cjs', '.trezi/trezi-vite.mjs']
  )
  for (const helper of result.helpers) {
    // The agent's own check from the incident: `shasum -a 256 .trezi/trezi-source.cjs` in its checkout.
    assert.equal(
      sha(readFileSync(join(cwd, helper.path))),
      helper.sha256,
      `${helper.path} is in the chat workspace`
    )
    assert.ok(readFileSync(join(cwd, helper.path)).equals(readFileSync(join(root, helper.path))))
  }
  const prompt = setupPrompt(result)
  assert.match(prompt, /trezi-vite\.mjs/)
  assert.ok(prompt.includes(cwd), 'the prompt names the checkout Trezi copied the helpers into')
  assert.match(prompt, /Never write \.trezi\/ yourself/)
  assert.doesNotMatch(prompt, /react\(\{ babel: \{ plugins/)
  // A chat of another project gets nothing copied.
  assert.equal((await scaffold(join(dir, 'missing'), key)).checkout, undefined)

  // Turn start of a parked chat also brings the helpers (it used to skip the sync).
  unlinkSync(join(cwd, '.trezi/trezi-vite.mjs'))
  await beforeTurn(key, 'Connect this project to Trezi')
  assert.equal(
    readFileSync(join(cwd, '.trezi/trezi-vite.mjs'), 'utf8'),
    readFileSync(join(root, '.trezi/trezi-vite.mjs'), 'utf8')
  )

  // The agent wires the config in its checkout; the turn lands on the live tree.
  writeFileSync(join(cwd, 'vite.config.js'), WIRED)
  events.length = 0
  await afterTurn(key, 'Connect this project to Trezi', [], 'success')
  const merged = events.find((e) => e.type === 'isolation' && e.state === 'merged')
  assert.ok(merged, `the setup turn landed: ${JSON.stringify(events)}`)
  assert.ok(merged.files.includes('vite.config.js'))
  assert.ok(
    !merged.files.some((file) => file.startsWith('.trezi/')),
    'helpers never land through the agent'
  )
  assert.equal(readFileSync(join(root, 'vite.config.js'), 'utf8'), WIRED)
  assert.equal(git(root, 'ls-files', '.trezi'), '', 'the helpers stay untracked, Trezi-owned files')

  // The live dev server's plugin stamps the fixture's JSX (Vite runs it before Oxc).
  process.env.NODE_ENV = 'development'
  const trezi = (await import(pathToFileURL(join(root, '.trezi/trezi-vite.mjs')).href)).default()
  assert.equal(trezi.apply, 'serve')
  assert.equal(trezi.enforce, 'pre')
  const warnings = []
  trezi.configResolved({ root, logger: { warn: (text) => warnings.push(text) } })
  const out = trezi.transform(APP, join(root, 'src/App.jsx'))
  assert.deepEqual(warnings, [])
  assert.match(out.code, /data-trezi-source="src\/App\.jsx:2:9"/)
  assert.match(out.code, /data-trezi-source="src\/App\.jsx:5:9"/)
  assert.match(out.code, /<h1 data-trezi-source="src\/App\.jsx:5:15"/)
  assert.match(out.code, /<Card data-trezi-component-source="src\/App\.jsx:5:31"/)
  assert.ok(out.map.mappings, 'a source map keeps Vite errors on the authored lines')

  await releaseChat(key)
  console.log(
    'SETUP-WORKTREE OK: helpers copied into a parked chat worktree, wiring landed live, Vite 8 fixture JSX stamped'
  )
} finally {
  if (previous === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previous
  rmSync(dir, { recursive: true, force: true })
}
