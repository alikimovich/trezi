import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-391: the Mark up model, overlay and session. The fixture runs real views in a window
// that is never ordered in; the checks here pin what crosses into the page and the wiring only
// the native `preview-markup` smoke runs.
if (process.platform !== 'darwin') {
  console.log('PREVIEW-MARKUP SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('preview-markup', [
    'test/fixtures/preview-markup/main.swift',
    'src/native/KeyShortcuts.swift',
    'src/native/PreviewMarkupModel.swift',
    'src/native/PreviewMarkupView.swift',
    'src/native/PreviewMarkup.swift'
  ])
  const report = JSON.parse(runFixture(binary))
  console.log(`PREVIEW-MARKUP PNG/JPEG ${JSON.stringify(report.evaluation)}`)
  const { selectors, script, restore } = report

  // Every element the preview instrumentation appends to the document is in the hide list;
  // the rest live inside `data-trezi-overlay`'s shadow root.
  const inShadow = new Set([
    'data-trezi-composer',
    'data-trezi-hover',
    'data-trezi-measure',
    'data-trezi-measure-label',
    'data-trezi-selbadge',
    'data-trezi-selbox',
    'data-trezi-size',
    'data-trezi-source',
    'data-trezi-toolbar',
    // A style sheet that hides the scrollbars; it paints nothing.
    'data-trezi-frame-style'
  ])
  const hosts = new Set()
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.ts'))
        for (const [, attribute] of readFileSync(path, 'utf8').matchAll(
          /setAttribute\('(data-trezi-[a-z-]+)'/g
        ))
          hosts.add(attribute)
    }
  }
  walk('src/preview')
  assert.ok(hosts.has('data-trezi-overlay') && hosts.has('data-trezi-cover'), 'the scan found none')
  for (const attribute of hosts)
    if (!inShadow.has(attribute))
      assert.ok(selectors.includes(`[${attribute}]`), `${attribute} would show in the snapshot`)

  // The scripts run in the isolated world against a stub document: hosts disappear for the
  // capture, their own inline state comes back, and a capture that dies restores by timer.
  const element = (display, priority) => {
    const values = new Map(display ? [['display', [display, priority]]] : [])
    return {
      style: {
        getPropertyValue: (name) => values.get(name)?.[0] ?? '',
        getPropertyPriority: (name) => values.get(name)?.[1] ?? '',
        setProperty: (name, value, important) => values.set(name, [value, important ?? '']),
        removeProperty: (name) => values.delete(name)
      },
      values
    }
  }
  const pinned = element('block', 'important')
  const toolbar = element('', '')
  const timers = []
  const scope = {
    document: {
      querySelectorAll: (query) => (query === selectors.join(',') ? [pinned, toolbar] : [])
    },
    requestAnimationFrame: (run) => run(),
    setTimeout: (run) => timers.push(run),
    clearTimeout() {},
    innerWidth: 640,
    innerHeight: 480,
    scrollX: 3,
    scrollY: 120
  }
  const run = (code) =>
    new Function(...Object.keys(scope), `return (async () => { ${code} })()`)(
      ...Object.values(scope)
    )
  // `globalThis` of the isolated world: the page never sees the restore function.
  scope.globalThis = {}
  const metrics = JSON.parse(await run(script))
  assert.deepEqual(metrics, { width: 640, height: 480, scrollX: 3, scrollY: 120 })
  assert.deepEqual(pinned.values.get('display'), ['none', 'important'])
  assert.deepEqual(toolbar.values.get('display'), ['none', 'important'])
  await run(restore)
  assert.deepEqual(pinned.values.get('display'), ['block', 'important'])
  assert.equal(toolbar.values.has('display'), false)
  assert.ok(timers.length > 0, 'a fail-safe restore is armed')
  await run(script)
  assert.deepEqual(pinned.values.get('display'), ['none', 'important'])
  for (const fire of timers.splice(0)) fire()
  assert.deepEqual(pinned.values.get('display'), ['block', 'important'], 'the fail-safe restores')
  await run(restore)

  // Wiring the fixture cannot reach.
  const source = (name) => readFileSync(`src/native/${name}`, 'utf8')
  assert.ok(source('ToolbarMore.swift').includes('("Mark up", "markup")'), 'the "…" entry')
  assert.ok(source('HostMenus.swift').includes('("Mark up", "", "markup")'), 'the menu entry')
  assert.match(source('PreviewCover.swift'), /markup\?\.overlay/, 'the page gets no hover under it')
  assert.match(source('WorkspaceLayout.swift'), /markup\?\.place\(area: available\)/)
  assert.match(source('Host.swift'), /keyCode == 53[^\n]*markup\?\.escape\(\)/)
  assert.match(source('HostMenus.swift'), /markup\?\.undo\(\)/)
  assert.match(readFileSync('scripts/build-native.mjs', 'utf8'), /PreviewMarkupHost\.swift/)
  const native = source('index.ts')
  assert.match(native, /installMarkup\(/)
  assert.ok(!/1280/.test(source('PreviewMarkupHost.swift')), 'not the agent frame budget')
  console.log('PREVIEW-MARKUP PASS')
}
