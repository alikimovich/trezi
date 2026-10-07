// LKM-197: after a dependency change the preview restarts with clean caches and reloads
// past WebKit's; the agent's reload_preview / restart_dev_server report the load, and
// open_preview's report says whether the loaded CSS/JS matches what the server serves.
// No ports: fetch and the native host are stand-ins.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewServers } from '../src/main/preview-evidence.ts'
import {
  fnv1a,
  PAGE_ASSETS,
  PAGE_FNV,
  previewFreshness,
  staleAsset
} from '../src/main/preview-freshness.ts'
import { previewLoads } from '../src/main/preview-loads.ts'
import {
  answerPreviewRefresh,
  reloadAgentPreview,
  restartAgentDevServer
} from '../src/main/preview-refresh-tools.ts'
import { registerPreviewSource } from '../src/main/preview-state.ts'
import { DependencyWatch, dependencySignature } from '../src/native/dependency-watch.ts'
import { projectKey } from '../src/shared/projectKey.ts'

// --- the dependency watch: a change must settle, Trezi's own restarts never trigger ---
{
  let signature = 'a'
  let target = { key: 'k', root: '/r' }
  const changed = []
  const watch = new DependencyWatch(
    () => target,
    (key) => changed.push(key),
    async () => signature
  )
  await watch.tick()
  signature = 'b'
  await watch.tick()
  signature = 'c'
  await watch.tick()
  assert.deepEqual(changed, [], 'an install still writing does not trigger')
  await watch.tick()
  assert.deepEqual(changed, ['k'], 'a settled change restarts once')
  await watch.tick()
  await watch.tick()
  assert.deepEqual(changed, ['k'], 'the new state is the baseline')
  target = null
  await watch.tick()
  signature = 'd'
  target = { key: 'k', root: '/r' }
  for (let i = 0; i < 3; i++) await watch.tick()
  assert.deepEqual(changed, ['k'], 'a change while the project was not running is re-baselined')
  target = { key: 'other', root: '/o' }
  signature = 'e'
  for (let i = 0; i < 3; i++) await watch.tick()
  assert.deepEqual(changed, ['k'], 'a project switch re-baselines')
}

// --- the signature: manifest, lockfiles and each direct dependency's installed manifest ---
{
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-dependency-watch-')))
  try {
    const write = (file, text) => {
      mkdirSync(join(dir, file, '..'), { recursive: true })
      writeFileSync(join(dir, file), text)
    }
    write(
      'package.json',
      JSON.stringify({ dependencies: { 'local-ui': 'file:../ui' }, devDependencies: { vite: '6' } })
    )
    write('node_modules/local-ui/package.json', '{"version":"1.0.0"}')
    write('src/App.jsx', 'export default 1')
    const first = await dependencySignature(dir)
    write('src/App.jsx', 'export default 2')
    write('node_modules/other/package.json', '{}')
    assert.equal(await dependencySignature(dir), first, 'sources and indirect packages are ignored')
    write('node_modules/local-ui/package.json', '{"version":"1.10.0"}')
    const upgraded = await dependencySignature(dir)
    assert.notEqual(upgraded, first, 'an upgraded direct dependency changes it')
    write('bun.lock', '{}')
    assert.notEqual(await dependencySignature(dir), upgraded, 'a lockfile change changes it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- freshness: the page's copies against the server's current responses ---
const OLD_CSS = '.button{color:red}'
const NEW_CSS = '.button{color:rgb(0, 128, 0)}'
const JS = 'import "/node_modules/local-ui/style.css"'
const origin = 'http://127.0.0.1:5197'
assert.equal(
  new Function(`return ${PAGE_FNV}`)()(NEW_CSS),
  fnv1a(NEW_CSS),
  'the page hashes like Bun'
)
assert.equal(staleAsset({ hash: fnv1a(OLD_CSS), size: 0 }, NEW_CSS), true)
assert.equal(staleAsset({ hash: null, size: OLD_CSS.length }, NEW_CSS), true, 'by size')
assert.equal(staleAsset({ hash: fnv1a(NEW_CSS), size: NEW_CSS.length }, NEW_CSS), false)

let loaded = OLD_CSS
const page = () => [
  {
    url: `${origin}/node_modules/local-ui/style.css`,
    kind: 'style',
    hash: fnv1a(loaded),
    size: loaded.length
  },
  { url: `${origin}/src/main.js`, kind: 'script', hash: fnv1a(JS), size: 0 },
  { url: 'http://example.com/remote.css', kind: 'style', hash: 'x', size: 1 }
]
let shown = `${origin}/settings?tab=1`
registerPreviewSource({
  getUrl: () => shown,
  capture: async () => null,
  agent: {
    evaluate: async (code) => (code === PAGE_ASSETS ? page() : null),
    captureRect: async () => null,
    setViewport: async () => ({ width: null, zoom: 1 })
  }
})
const fetched = []
globalThis.fetch = async (url, init) => {
  fetched.push({ url: String(url), accept: init?.headers?.Accept, cache: init?.cache })
  const path = new URL(url).pathname
  const body = path.endsWith('.css') ? NEW_CSS : path.endsWith('.js') ? JS : '<!doctype html>'
  return new Response(body, { status: 200 })
}
{
  const fresh = await previewFreshness(`${origin}/`, 2000)
  assert.equal(fresh.checked, 2)
  assert.equal(fresh.matches, false)
  assert.deepEqual(fresh.stale, ['/node_modules/local-ui/style.css'])
  assert.match(fresh.note, /reload_preview with hard: true/)
  assert.ok(
    fetched.every((f) => f.url.startsWith(origin) && f.cache === 'no-store'),
    'only the dev server is fetched, fresh'
  )
  assert.equal(fetched.find((f) => f.url.endsWith('.css')).accept, 'text/css,*/*;q=0.1')
}

// --- the tools, against a stand-in native host ---
const root = '/project-preview-refresh'
const chat = 'chat-preview-refresh'
previewServers.set(projectKey(root), { url: `${origin}/` })
const host =
  (script, seen = []) =>
  (channel, request) => {
    assert.equal(channel, 'preview:refresh')
    seen.push(request)
    setTimeout(() => script(request), 5)
  }
const navigate = (url) => {
  previewLoads.record({ type: 'start', url })
  previewLoads.record({ type: 'response', url, status: 200 })
  previewLoads.record({ type: 'loaded', url })
}

{
  const seen = []
  const stale = await reloadAgentPreview(
    root,
    chat,
    { hard: true },
    host((request) => {
      answerPreviewRefresh(request.id, { state: 'reloading' })
      navigate(shown)
    }, seen)
  )
  assert.deepEqual(
    { action: seen[0].action, hard: seen[0].hard, root: seen[0].root, key: seen[0].key },
    { action: 'reload', hard: true, root, key: chat }
  )
  assert.equal(stale.reloaded, true)
  assert.equal(stale.hard, true)
  assert.equal(stale.navigation, 'loaded')
  assert.equal(stale.finalUrl, shown, 'the route is kept')
  assert.equal(stale.assets.matches, false)
  assert.match(stale.message, /restart_dev_server with cleanCache: true/)

  loaded = NEW_CSS
  const restarted = await restartAgentDevServer(
    root,
    chat,
    { cleanCache: true },
    host((request) => {
      assert.equal(request.action, 'restart')
      assert.equal(request.hard, true)
      answerPreviewRefresh(request.id, { state: 'restarting' })
      setTimeout(() => {
        navigate(shown)
        answerPreviewRefresh(request.id, { state: 'restarted', url: `${origin}/` })
      }, 20)
    })
  )
  assert.equal(restarted.restarted, true)
  assert.equal(restarted.cleanCache, true)
  assert.equal(restarted.url, `${origin}/`)
  assert.equal(restarted.loaded, true)
  assert.deepEqual(restarted.assets, {
    checked: 2,
    matches: true,
    stale: [],
    note: 'The CSS/JS the preview loaded matches what the dev server serves now.'
  })

  const failed = await restartAgentDevServer(
    root,
    chat,
    { cleanCache: true },
    host((request) => {
      answerPreviewRefresh(request.id, { state: 'restarting' })
      answerPreviewRefresh(request.id, { state: 'failed', error: 'vite: command not found.' })
    })
  )
  assert.equal(failed.restarted, false)
  assert.match(failed.message, /did not start: vite: command not found/)

  const elsewhere = await reloadAgentPreview(
    root,
    chat,
    {},
    host((request) => answerPreviewRefresh(request.id, { state: 'elsewhere' }))
  )
  assert.equal(elsewhere.reloaded, false)
  assert.equal(elsewhere.hard, false)
  assert.match(elsewhere.message, /another chat or project/)

  const silent = await restartAgentDevServer(
    root,
    chat,
    {},
    host(() => {})
  )
  assert.equal(silent.restarted, false)
  assert.match(silent.message, /did not confirm the restart/)

  for (const run of [reloadAgentPreview, restartAgentDevServer]) {
    const refused = await run(root, chat, {}, host(assert.fail), true)
    assert.match(refused.error, /^Background edits cannot/)
  }

  previewServers.delete(projectKey(root))
  const stopped = await reloadAgentPreview(root, chat, { hard: true }, host(assert.fail))
  assert.equal(stopped.reloaded, false)
  assert.match(stopped.message, /dev server is stopped/)
  assert.match(stopped.message, /restart_dev_server/)
}

console.log(
  'PREVIEW-REFRESH OK — dependency watch settles once, signature, CSS/JS freshness, reload_preview and restart_dev_server results'
)
