// LKM-600: an inspector Apply whose preview document is out of date for the draft's files
// is refreshed by the app (one bounded reload that re-resolves the same element) before
// any agent starts; the source hash checks run again after it. Nothing is bypassed: a real
// source change, a missing or ambiguous element, a moved selection or project, or a preview
// still out of date keeps the draft with a concise reason and starts no agent.
// Real NativeInspectorController with recorded seams; the refresh algorithm and the Git
// freshness read are driven directly with fake clocks and a scratch repository.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSourceOwner } from '../src/main/source-owner.ts'
import { NativeInspectorController } from '../src/native/inspector-controller.ts'
import {
  changedBetween,
  previewFreshness,
  refreshForApply
} from '../src/native/inspector-preview-refresh.ts'

let hash = 'base'
setSourceOwner({ read: async (_root, file) => ({ path: file, hash, binary: false, size: 10 }) })

const A = {
  tag: 'span',
  id: 'a',
  classes: [],
  source: '/p/src/card.tsx:3',
  componentSource: null,
  styles: {},
  selector: 'span#a',
  text: null,
  rect: { x: 0, y: 0, width: 10, height: 10 }
}
const B = { ...A, id: 'b', source: '/p/src/card.tsx:9', selector: 'span#b' }

const cases = []
const test = (name, run) => cases.push({ name, run })

/** A controller with a recorded Apply dispatch and scripted preview freshness. */
const make = (freshness) => {
  const dispatched = []
  const refreshes = []
  const checks = []
  const c = new NativeInspectorController(
    async (channel) =>
      channel === 'styles:read'
        ? { values: { opacity: '1', display: 'inline' }, specified: { opacity: '1' } }
        : channel === 'controls:list'
          ? []
          : null,
    async () => {},
    () => {},
    async (root, prompt, submit, action) => {
      dispatched.push({ root, prompt, submit, action })
      return `apply-${dispatched.length}`
    },
    async () => {}
  )
  c.previewFreshness = async (root, files) => {
    checks.push(files)
    return freshness.shift() ?? 'current'
  }
  const act = (action, extra = {}) =>
    c.action({ root: c.state.root, generation: c.state.generation, action, ...extra })
  return { c, act, dispatched, refreshes, checks }
}
const staged = async (c, act) => {
  await c.activate('/p')
  await c.select(A)
  await act('apply', { field: 'style:opacity', value: '0.4' })
  assert.equal(c.state.draft?.count, 1)
}

test('an already-current preview dispatches at once, without a refresh', async () => {
  const { c, act, dispatched, checks } = make(['current'])
  let refreshed = 0
  c.refreshPreview = async () => {
    refreshed++
    return 'ok'
  }
  await staged(c, act)
  await act('apply-drafts')
  assert.equal(refreshed, 0)
  assert.deepEqual(checks, [['src/card.tsx']], 'freshness is judged for the draft files')
  assert.equal(dispatched.length, 1)
  assert.equal(c.state.draft?.submitted, true)
  assert.match(dispatched[0].prompt, /a preview identity marked stale is not a reason to refuse/)
})

test('a stale preview is refreshed once, the same element re-picked, then Apply continues', async () => {
  const { c, act, dispatched } = make(['stale', 'current'])
  const calls = []
  c.refreshPreview = async (root, element, still) => {
    calls.push({ root, element })
    // LKM-638: the batch shows as applying; the fields are not locked while it refreshes.
    assert.equal(c.state.draft?.submitted, true, 'the footer shows the Apply starting')
    assert.equal(c.state.busy, false, 'the inspector stays editable while refreshing')
    // The reload re-picks the same element: a new generation, the same target.
    await c.select({ ...A, rect: { x: 1, y: 1, width: 10, height: 10 } })
    assert.equal(still(), true)
    return 'ok'
  }
  await staged(c, act)
  await act('apply-drafts')
  assert.equal(calls.length, 1, 'exactly one bounded refresh')
  assert.equal(calls[0].element.id, 'a')
  assert.equal(dispatched.length, 1, 'no agent was asked to do preview housekeeping')
  assert.equal(c.state.error, '')
  assert.equal(c.state.draft?.submitted, true)
})

test('a source change found before or after the refresh keeps the draft and starts nothing', async () => {
  const before = make(['stale'])
  let refreshed = 0
  before.c.refreshPreview = async () => {
    refreshed++
    return 'ok'
  }
  await staged(before.c, before.act)
  hash = 'edited'
  await before.act('apply-drafts')
  assert.equal(refreshed, 0, 'a mismatched hash is refused before any refresh')
  assert.equal(before.dispatched.length, 0)
  assert.match(before.c.state.error, /Source changed while the preview draft was pending/)
  assert.equal(before.c.state.draft?.conflict, true)
  hash = 'base'
  const after = make(['stale', 'current'])
  after.c.refreshPreview = async () => {
    hash = 'edited-during-refresh'
    return 'ok'
  }
  await staged(after.c, after.act)
  await after.act('apply-drafts')
  assert.equal(after.dispatched.length, 0)
  assert.match(after.c.state.error, /Source changed while the preview draft was pending/)
  assert.equal(after.c.state.draft?.count, 1, 'the draft is kept')
})

for (const [outcome, text] of [
  ['missing', /no longer on the page\. Reselect it, then Apply\. The draft is still pending\./],
  ['ambiguous', /more than one element matches the selection\. Reselect it/],
  ['timeout', /did not finish refreshing\. Refresh it, then Apply again/]
])
  test(`a refresh that ends ${outcome} keeps the draft pending with a concise reason`, async () => {
    const { c, act, dispatched } = make(['stale'])
    c.refreshPreview = async () => outcome
    await staged(c, act)
    await act('apply-drafts')
    assert.equal(dispatched.length, 0)
    assert.match(c.state.error, text)
    assert.equal(c.state.draft?.count, 1)
    assert.equal(c.state.draft?.submitted, false)
    assert.equal(c.state.busy, false)
    // Apply again is possible once the preview is current.
    c.previewFreshness = async () => 'current'
    await act('apply-drafts')
    assert.equal(dispatched.length, 1)
  })

test('a re-attached element at a new selector keeps its draft and Apply continues', async () => {
  const { c, act, dispatched } = make(['stale', 'current'])
  c.refreshPreview = async () => {
    // A sibling was added above it: same tag, source stamp and id, new structural selector.
    assert.equal(await c.reattach({ ...A, selector: 'div > span:nth-of-type(2)' }), true)
    return 'ok'
  }
  await staged(c, act)
  await act('apply-drafts')
  assert.equal(dispatched.length, 1)
  assert.match(dispatched[0].prompt, /Target div > span:nth-of-type\(2\) from/)
  assert.equal(c.state.draft?.submitted, true)
  assert.equal(c.state.error, '')
})

test('a preview still out of date after its one refresh is reported, not looped', async () => {
  const { c, act, dispatched } = make(['stale', 'stale', 'stale'])
  let refreshed = 0
  c.refreshPreview = async () => {
    refreshed++
    return 'ok'
  }
  await staged(c, act)
  await act('apply-drafts')
  assert.equal(refreshed, 1)
  assert.equal(dispatched.length, 0)
  assert.match(c.state.error, /did not finish refreshing/)
  assert.equal(c.state.draft?.count, 1)
})

test('a selection switch during the refresh holds the draft for its element; nothing starts', async () => {
  const { c, act, dispatched } = make(['stale'])
  c.refreshPreview = async (_root, _element, still) => {
    await c.select(B)
    assert.equal(still(), false)
    return 'ok'
  }
  await staged(c, act)
  await act('apply-drafts')
  assert.equal(dispatched.length, 0)
  assert.equal(c.element?.id, 'b', 'never substituted or retargeted')
  assert.equal(c.state.draft, undefined, 'B shows no draft')
  assert.equal(c.state.error, '', "A's outcome is not shown on B")
  await c.select(A)
  assert.equal(c.state.draft?.count, 1, "A's draft was held, not dropped")
  assert.equal(c.state.draft?.submitted, false)
})

test('a project switch during the refresh starts nothing and keeps the draft', async () => {
  const { c, act, dispatched } = make(['stale'])
  c.refreshPreview = async () => {
    c.suspend()
    await c.activate('/q')
    return 'moved'
  }
  await staged(c, act)
  await act('apply-drafts')
  assert.equal(dispatched.length, 0)
  assert.equal(c.state.root, '/q')
  assert.equal(c.state.error, '', 'nothing reported on the other project')
  await c.activate('/p')
  await c.select(A)
  assert.equal(c.state.draft?.count, 1)
})

test('Undo and Revert cannot change the draft while its preview refreshes', async () => {
  const { c, act, dispatched } = make(['stale', 'current'])
  c.refreshPreview = async () => {
    await c.action({ root: '/p', generation: c.state.generation, action: 'revert-draft' })
    return 'ok'
  }
  await staged(c, act)
  await act('apply-drafts')
  assert.equal(dispatched.length, 1)
  assert.match(dispatched[0].prompt, /set opacity to 0\.4/)
})

// The refresh algorithm itself, on a fake clock.
const deps = (script) => {
  let now = 0
  const log = []
  return {
    log,
    deps: {
      still: () => script.still?.() ?? true,
      reload: () => log.push('reload'),
      ready: async (since, ms) => {
        log.push(`ready ${since} ${ms}`)
        return script.ready ?? true
      },
      layers: async () => ({ truncated: false, nodes: script.nodes() }),
      alive: async () => script.alive(),
      reattach: async () => log.push('reattach'),
      wait: async (ms) => {
        now += ms
      },
      now: () => now
    }
  }
}
const node = (id, source = A.source) => ({ tag: 'span', id, source, path: [0] })

test('refreshForApply: one reload, a unique match re-picked, then ok', async () => {
  let picked = false
  const { deps: d, log } = deps({
    nodes: () => [node('a'), node('b')],
    alive: () => picked
  })
  d.reattach = async () => {
    log.push('reattach')
    picked = true
  }
  assert.equal(await refreshForApply(d, A, 1000), 'ok')
  assert.deepEqual(log, ['reload', 'ready 0 1000', 'reattach'])
})

test('refreshForApply: ambiguous at once, missing only at the deadline, moved, timeout', async () => {
  const two = deps({ nodes: () => [node('a'), node('a')], alive: () => false })
  assert.equal(await refreshForApply(two.deps, A, 1000), 'ambiguous')
  let reads = 0
  const none = deps({
    nodes: () => {
      reads++
      return []
    },
    alive: () => false
  })
  assert.equal(await refreshForApply(none.deps, A, 1000), 'missing')
  assert.ok(reads > 1, 'a late-hydrating page gets more than one read')
  // A loaded tree without the element ends after the grace, long before the deadline.
  let elapsed = 0
  const absent = deps({ nodes: () => [node('z', '/p/src/other.tsx:1')], alive: () => false })
  const wait = absent.deps.wait
  absent.deps.wait = async (ms) => {
    elapsed += ms
    await wait(ms)
  }
  assert.equal(await refreshForApply(absent.deps, A, 10_000), 'missing')
  assert.ok(elapsed >= 1200 && elapsed < 2000, `ended after the grace: ${elapsed}`)
  // The element coming back within the grace resets it.
  let reads2 = 0
  const late = deps({
    nodes: () => (++reads2 < 4 ? [node('z', '/p/src/other.tsx:1')] : [node('a')]),
    alive: () => reads2 >= 5
  })
  assert.equal(await refreshForApply(late.deps, A, 10_000), 'ok')
  const unpicked = deps({ nodes: () => [node('a')], alive: () => false })
  assert.equal(await refreshForApply(unpicked.deps, A, 1000), 'timeout')
  assert.equal(unpicked.log.filter((x) => x === 'reattach').length, 1, 'one re-pick only')
  const notReady = deps({ ready: false, nodes: () => [], alive: () => false })
  assert.equal(await refreshForApply(notReady.deps, A, 1000), 'timeout')
  let live = true
  const moved = deps({
    still: () => live,
    nodes: () => {
      live = false
      return [node('a')]
    },
    alive: () => true
  })
  assert.equal(await refreshForApply(moved.deps, A, 1000), 'moved')
  const gone = deps({ still: () => false, nodes: () => [], alive: () => true })
  assert.equal(await refreshForApply(gone.deps, A, 1000), 'moved')
  assert.deepEqual(gone.log, [], 'a superseded project is never reloaded')
})

test('freshness: stale only when a draft file changed between the two revisions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lkm600-'))
  try {
    const git = (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: dir
      })
        .toString()
        .trim()
    git('init', '-q')
    writeFileSync(join(dir, 'card.tsx'), 'a')
    writeFileSync(join(dir, 'other.tsx'), 'a')
    git('add', '.')
    git('commit', '-qm', 'one')
    const one = git('rev-parse', 'HEAD')
    writeFileSync(join(dir, 'other.tsx'), 'b')
    git('commit', '-qam', 'two')
    const two = git('rev-parse', 'HEAD')
    writeFileSync(join(dir, 'card.tsx'), 'b')
    git('commit', '-qam', 'three')
    const three = git('rev-parse', 'HEAD')
    const ident = (served, live) => ({
      stale: served !== live,
      servedRevision: served,
      liveRevision: live
    })
    const check = (served, live) =>
      previewFreshness(ident(served, live), (from, to) =>
        changedBetween(dir, from, to, ['card.tsx'])
      )
    assert.equal(await check(two, two), 'current')
    assert.equal(await check(one, two), 'current', 'another file moved HEAD: no reload')
    assert.equal(await check(two, three), 'stale')
    assert.equal(await changedBetween(dir, 'nope', three, ['card.tsx']), true, 'unknown is changed')
    assert.equal(
      await previewFreshness({ stale: true, servedRevision: null, liveRevision: three }, () => {
        throw new Error('not consulted')
      }),
      'current'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

let failed = 0
for (const { name, run } of cases) {
  hash = 'base'
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n  ${error.stack?.split('\n').slice(0, 4).join('\n  ')}`)
  }
}
setSourceOwner(null)
if (failed) {
  console.log(`${failed} of ${cases.length} failed`)
  process.exit(1)
}
console.log(`${cases.length} passed`)
process.exit(0)
