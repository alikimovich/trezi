// LKM-216: the visual editor never shows stale styles. The freshness hub re-reads the
// island, Layers and chat islands after every change, drops the token memo, and checks a
// stylesheet change the page did not apply: a targeted cache-busted reload first, one
// hard reload as the fallback. Fakes only: no WebKit, no ports, no file watching.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PAGE_ASSETS } from '../src/main/preview-freshness.ts'
import {
  noteSourceChange,
  observedSourceOwner,
  onSourceChange
} from '../src/main/source-changes.ts'
import { EditorFreshness, isStyleFile, relativePath } from '../src/native/editor-freshness.ts'
import { ignoredLivePath, LiveTreeWatch } from '../src/native/live-tree-watch.ts'
import { touchesStyles } from '../src/preview/style-watch.ts'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const TIMING = { settle: 5, css: 25, recheck: 10, window: 1000, hardGap: 1000 }

function fakeHost(overrides = {}) {
  const calls = {
    inspector: 0,
    layers: 0,
    islands: [],
    tokens: [],
    checks: 0,
    reloads: [],
    hard: 0
  }
  const host = {
    current: { root: '/p', url: 'http://127.0.0.1:5173/' },
    results: [],
    active: () => host.current,
    inspector: async () => void calls.inspector++,
    layers: async () => void calls.layers++,
    islands: async (root) => void calls.islands.push(root),
    tokens: (root) => void calls.tokens.push(root),
    check: async () => {
      calls.checks++
      return host.results.length > 1 ? host.results.shift() : (host.results[0] ?? null)
    },
    reloadStyles: async (paths) => {
      calls.reloads.push(paths)
      return paths.length
    },
    hardReload: () => void calls.hard++,
    report: (error) => {
      throw error
    },
    ...overrides
  }
  return { host, calls }
}
const fresh = { stale: [], staleStyles: [] }
const stale = { stale: ['/app.css'], staleStyles: ['/app.css'] }

// --- a burst of changes is one re-read of the island, Layers and the chat islands ---
{
  const { host, calls } = fakeHost()
  const hub = new EditorFreshness(host, TIMING)
  hub.invalidate('/p', 'source-edit', ['src/App.tsx'])
  hub.invalidate('/p', 'file-change', ['/p/src/App.tsx'])
  hub.invalidate('/p', 'landing', [])
  await delay(30)
  assert.equal(hub.stats.rereads, 1)
  assert.deepEqual([calls.inspector, calls.layers, calls.islands], [1, 1, ['/p']])
  assert.deepEqual(calls.tokens, ['/p', '/p', '/p'], 'every change drops the token memo')
  assert.equal(calls.checks, 0, 'no stylesheet changed, nothing to compare')
  hub.dispose()
}

// --- another project's change drops its token memo only; ignored paths do nothing ---
{
  const { host, calls } = fakeHost()
  const hub = new EditorFreshness(host, TIMING)
  hub.invalidate('/other', 'source-edit', ['a.css'])
  hub.invalidate('/p', 'file-change', ['node_modules/x/index.js', '.next/cache/a'])
  await delay(40)
  assert.deepEqual(calls.tokens, ['/other', '/p'])
  assert.equal(hub.stats.rereads, 0)
  assert.equal(calls.checks, 0)
  hub.dispose()
}

// --- HMR applied the CSS in time: re-read, the server comparison finds nothing to fix ---
{
  const { host, calls } = fakeHost()
  host.results = [fresh]
  const hub = new EditorFreshness(host, TIMING)
  hub.invalidate('/p', 'source-edit', ['src/app.module.css'])
  await delay(8)
  hub.invalidate('/p', 'hmr')
  await delay(40)
  assert.equal(calls.reloads.length, 0)
  assert.equal(calls.hard, 0)
  assert.ok(hub.stats.rereads >= 1)
  hub.dispose()
}

// --- a page signal is not proof (a document load inserts <link>s): a stale stylesheet is
// --- still swapped, but a stale script after the signal is never a reason to hard-reload ---
{
  const { host, calls } = fakeHost()
  host.results = [stale, fresh]
  const hub = new EditorFreshness(host, TIMING)
  hub.invalidate('/p', 'dependency', ['package.json'])
  await delay(8)
  hub.invalidate('/p', 'hmr')
  await delay(80)
  assert.deepEqual(calls.reloads, [['/app.css']], 'stale stylesheet swapped despite the signal')
  assert.equal(calls.hard, 0)
  hub.dispose()
}
{
  const { host, calls } = fakeHost()
  host.results = [{ stale: ['/main.js'], staleStyles: [] }]
  const hub = new EditorFreshness(host, TIMING)
  hub.invalidate('/p', 'source-edit', ['src/app.css'])
  await delay(8)
  hub.invalidate('/p', 'hmr')
  await delay(80)
  assert.equal(calls.hard, 0, 'HMR replaced the script: no hard reload')
  hub.dispose()
}

// --- HMR/document signals with no outstanding change are CSS-in-JS churn: ignored ---
{
  const { host } = fakeHost()
  const hub = new EditorFreshness(host, TIMING)
  hub.invalidate('/p', 'hmr')
  hub.invalidate('/p', 'document')
  await delay(20)
  assert.equal(hub.stats.rereads, 0)
  hub.dispose()
}

// --- no HMR within the window: a stale stylesheet is swapped, then re-read ---
{
  const { host, calls } = fakeHost()
  host.results = [stale, fresh]
  const hub = new EditorFreshness(host, TIMING)
  hub.invalidate('/p', 'source-edit', ['/p/src/app.css'])
  await delay(80)
  assert.deepEqual(calls.reloads, [['/app.css']])
  assert.equal(calls.checks, 2, 'checked again after the targeted reload')
  assert.equal(calls.hard, 0)
  assert.deepEqual(hub.stats, { rereads: 2, styleChecks: 1, styleReloads: 1, hardReloads: 0 })
  hub.dispose()
}

// --- the page navigated while a check was swapping: no hard reload of the new page ---
{
  const { host, calls } = fakeHost()
  host.results = [stale, stale]
  const hub = new EditorFreshness(host, TIMING)
  hub.invalidate('/p', 'source-edit', ['/p/src/app.css'])
  await delay(TIMING.css + 3)
  hub.invalidate('/p', 'document')
  await delay(30)
  assert.equal(calls.hard, 0, 'the new document is checked on its own, not hard-reloaded')
  assert.equal(hub.idle, false, "the new document's own check is pending")
  hub.dispose()
}

// --- Trezi's own link swap fires the page's CSS signal: that is not HMR ---
{
  const { host, calls } = fakeHost()
  host.results = [stale, stale]
  let hub
  host.reloadStyles = async (paths) => {
    calls.reloads.push(paths)
    hub.invalidate('/p', 'hmr')
    return 1
  }
  hub = new EditorFreshness(host, TIMING)
  hub.invalidate('/p', 'dependency', ['package.json'])
  await delay(80)
  assert.equal(calls.hard, 1, 'still stale after the swap: one hard reload')
}

// --- still stale (or a script is stale): one hard reload, rate-limited ---
{
  const { host, calls } = fakeHost()
  host.results = [{ stale: ['/main.js'], staleStyles: [] }]
  const hub = new EditorFreshness(host, TIMING)
  hub.invalidate('/p', 'dependency', ['package.json'])
  await delay(60)
  assert.equal(calls.reloads.length, 0, 'no stylesheet to swap')
  assert.equal(calls.hard, 1)
  hub.invalidate('/p', 'dependency', ['package.json'])
  await delay(60)
  assert.equal(calls.hard, 1, 'a second hard reload within hardGap is skipped')
  hub.dispose()
}

// --- a new document is checked once it loaded (WebKit may have served cached CSS) ---
{
  const { host, calls } = fakeHost()
  host.results = [fresh]
  const hub = new EditorFreshness(host, TIMING)
  hub.invalidate('/p', 'file-change', ['styles/theme.scss'])
  await delay(15)
  hub.invalidate('/p', 'document')
  await delay(15)
  assert.equal(calls.checks, 0, 'the check moved past the new document')
  await delay(30)
  assert.equal(calls.checks, 1)
  assert.equal(calls.hard, 0)
  hub.dispose()
}

// --- a project with no web preview (simulator, not running) skips the comparison ---
{
  const { host, calls } = fakeHost()
  host.current = { root: '/p', url: null }
  const hub = new EditorFreshness(host, TIMING)
  hub.invalidate('/p', 'source-edit', ['a.css'])
  await delay(50)
  assert.equal(calls.checks, 0)
  assert.equal(hub.stats.rereads, 1)
  hub.dispose()
}

// --- one failing re-read is reported and does not stop the others ---
{
  const reported = []
  const { host, calls } = fakeHost({
    layers: async () => {
      throw new Error('layers gone')
    },
    report: (error) => reported.push(String(error))
  })
  const hub = new EditorFreshness(host, TIMING)
  await hub.reread()
  assert.deepEqual(reported, ['Error: layers gone'])
  assert.equal(calls.inspector, 1)
  assert.deepEqual(calls.islands, ['/p'])
}

// --- paths and style files ---
assert.equal(relativePath('/p', '/p/src/a.css'), 'src/a.css')
assert.equal(relativePath('/p', './src/a.css'), 'src/a.css')
assert.equal(relativePath('/p', ''), '')
for (const file of [
  'a.css',
  'b/c.module.scss',
  'd.less',
  'tailwind.config.ts',
  'x/postcss.config.cjs'
])
  assert.ok(isStyleFile(file), file)
for (const file of ['a.tsx', 'tailwind.ts', 'css.js']) assert.ok(!isStyleFile(file), file)
for (const path of ['node_modules/a/b.css', '.git/index', 'web/.next/x', 'dist/a.js', '.trezi/x'])
  assert.ok(ignoredLivePath(path), path)
for (const path of ['src/build.ts', 'styles/out.css.ts', 'app/page.tsx'])
  assert.ok(!ignoredLivePath(path), path)

// --- the live-tree watch batches, filters and follows the active project ---
{
  const opened = []
  const open = (root, listener) => {
    const watcher = new EventEmitter()
    watcher.close = () => (watcher.closed = true)
    opened.push({ root, listener, watcher })
    return watcher
  }
  const batches = []
  const watch = new LiveTreeWatch((root, files) => batches.push([root, files]), open)
  watch.target('/a')
  watch.target('/a')
  assert.equal(opened.length, 1)
  opened[0].listener('change', 'src/a.tsx')
  opened[0].listener('change', 'node_modules/x/y.js')
  opened[0].listener('rename', 'src/a.tsx')
  opened[0].listener('change', 'src/b.css')
  await delay(70)
  assert.deepEqual(batches, [['/a', ['src/a.tsx', 'src/b.css']]])
  opened[0].listener('change', 'src/c.tsx')
  watch.target('/b')
  assert.ok(opened[0].watcher.closed)
  await delay(70)
  assert.equal(batches.length, 1, 'a pending batch for the old project is dropped')
  opened[1].watcher.emit('error', new Error('gone'))
  assert.equal(watch.watching, '')
  const failing = new LiveTreeWatch(
    () => {},
    () => {
      throw new Error('EMFILE')
    }
  )
  failing.target('/c')
  assert.equal(failing.watching, '')
}

// --- the source owner reports its own successful writes ---
{
  const seen = []
  const off = onSourceChange((change) => seen.push(change))
  const owner = observedSourceOwner({
    commit: async (_root, edits) => ({ ok: edits[0].path !== 'conflict.css', hashes: [] }),
    undo: async () => ({ ok: true, file: 'a.css' }),
    record: async () => {},
    deleteFile: async () => ({ ok: false })
  })
  await owner.commit('/p', [{ path: 'src/a.module.css', expectedHash: 'x', content: '' }])
  await owner.commit('/p', [{ path: 'conflict.css', expectedHash: 'x', content: '' }])
  await owner.undo('/p')
  await owner.record('/p', [{ path: 'src/App.tsx', before: '', after: 'x' }])
  await owner.deleteFile('/p', 'gone.css')
  off()
  noteSourceChange('/p', [], 'dependency')
  assert.deepEqual(seen, [
    { root: '/p', files: ['src/a.module.css'], reason: 'source-edit' },
    { root: '/p', files: ['a.css'], reason: 'source-edit' },
    { root: '/p', files: ['src/App.tsx'], reason: 'landing' }
  ])
  // A throwing listener never reaches the writer.
  const offBad = onSourceChange(() => {
    throw new Error('boom')
  })
  noteSourceChange('/p', [], 'file-change')
  offBad()
}

// --- the page's stylesheet mutations that count as a CSS update ---
{
  const node = (nodeName, rel) => ({ nodeName, getAttribute: () => rel ?? null })
  const link = node('LINK', 'stylesheet'),
    style = node('STYLE'),
    icon = node('LINK', 'icon'),
    div = node('DIV')
  const record = (type, target, added = [], removed = []) => ({
    type,
    target,
    addedNodes: added,
    removedNodes: removed
  })
  assert.ok(touchesStyles(record('attributes', link)))
  assert.ok(!touchesStyles(record('attributes', icon)))
  assert.ok(touchesStyles(record('characterData', { parentNode: style })))
  assert.ok(!touchesStyles(record('characterData', { parentNode: div })))
  assert.ok(touchesStyles(record('childList', style)))
  assert.ok(touchesStyles(record('childList', div, [link])))
  assert.ok(touchesStyles(record('childList', div, [], [style])))
  assert.ok(!touchesStyles(record('childList', div, [div], [icon])))
}

// --- the page lists each asset once: the latest HMR copy, the document's <link> wins ---
{
  const origin = 'http://127.0.0.1:5173'
  const entries = [
    { name: `${origin}/src/app.css?t=1`, initiatorType: 'link', decodedBodySize: 10 },
    { name: `${origin}/src/app.css?t=2`, initiatorType: 'link', decodedBodySize: 12 },
    { name: `${origin}/theme.css`, initiatorType: 'link', decodedBodySize: 5 },
    { name: `${origin}/src/main.tsx?t=3`, initiatorType: 'script', decodedBodySize: 7 }
  ]
  const fetched = []
  const run = new Function('location', 'document', 'performance', 'fetch', `return ${PAGE_ASSETS}`)
  const result = await run(
    { origin, href: `${origin}/` },
    {
      querySelectorAll: (selector) =>
        selector.startsWith('link')
          ? [{ href: `${origin}/theme.css?trezi-fresh=9` }]
          : [{ src: `${origin}/src/main.tsx` }]
    },
    { getEntriesByType: () => entries },
    async (url) => {
      fetched.push(url)
      return { ok: true, text: async () => url }
    }
  )
  assert.deepEqual(
    result.map((asset) => [asset.url, asset.kind]),
    [
      [`${origin}/theme.css?trezi-fresh=9`, 'style'],
      [`${origin}/src/app.css?t=2`, 'style'],
      [`${origin}/src/main.tsx`, 'script']
    ]
  )
  assert.equal(result[1].size, 12)
  assert.equal(fetched.length, 3)
}

console.log('editor-freshness: OK')
