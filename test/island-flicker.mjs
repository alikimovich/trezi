// LKM-140: shadow flicker during live Shadow island drags.
// Measures the three hypotheses on a scripted drag through the real ChatIslands and Swift
// owners, against a modelled page whose dev server swaps the CSS with a gap frame (the old
// rule removed one frame before the new one applies), then proves the fix: frames shown
// through the preview override, one source write per gesture, override removed only after
// the HMR update with the final value applied. Prints `ISLAND-FLICKER {json}` lines.
import './helpers/with-service-owners.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatIslands, ISLAND_CONFLICT_NOTICE } from '../src/main/chat-islands.ts'
import { IslandOverrides } from '../src/main/island-overrides.ts'
import { shadowLight } from '../src/main/shadows.ts'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const root = await mkdtemp(join(tmpdir(), 'trezi-island-flicker-'))
const file = join(root, 'phone.js')
const initial = {
  x: 0.72,
  y: -0.28,
  distance: 12,
  blur: 24,
  layers: 3,
  decay: 0.6,
  color: 'rgba(0, 0, 0, 0.35)'
}
const keys = Object.keys(initial)
const code =
  keys.map((key) => `const SHADOW_${key} = ${JSON.stringify(initial[key])};`).join('\n') +
  `\nconst SHADOW_CSS = ${JSON.stringify(shadowLight(initial).css)};\n`
const derived = (x, y) => shadowLight({ ...initial, x, y }).css
const bounds = [
  [-1, 1],
  [-1, 1],
  [0, 64],
  [0, 80],
  [1, 8],
  [0, 1]
]
const request = {
  action: 'define',
  engine: 'agent',
  manifest: {
    file: 'phone.js',
    component: 'Phone',
    title: 'iPhone Frame Shadow',
    params: [
      ...keys.map((key, i) => ({
        id: key,
        label: key,
        kind: i === 6 ? 'color' : 'number',
        ...(i < 6 ? { min: bounds[i][0], max: bounds[i][1], step: i === 4 ? 1 : 0.01 } : {}),
        apply: { strategy: 'literal', anchor: `const SHADOW_${key} = ` }
      })),
      {
        id: 'output',
        label: 'CSS',
        kind: 'text',
        apply: { strategy: 'literal', anchor: 'const SHADOW_CSS = ' }
      }
    ]
  },
  blocks: [
    { id: 'shadow', title: 'Shadow', kind: 'shadow', output: 'css', params: [...keys, 'output'] }
  ]
}

/** A page and its dev server at 60 fps. Every write of the CSS literal is one HMR update that
 *  removes the old rule a frame before the new one applies (hypothesis 1, modelled). The
 *  port is the preview override (src/preview/island-override.ts) on the bound element. */
function page() {
  const literal = () =>
    JSON.parse(/const SHADOW_CSS = ("(?:[^"\\]|\\.)*");/.exec(readFileSync(file, 'utf8'))[1])
  const state = {
    own: literal(),
    override: null,
    swap: null,
    step: -1,
    frames: [],
    hmr: 0,
    literals: [],
    removedAt: null,
    appliedAt: null
  }
  let seen = state.own
  const timer = setInterval(() => {
    if (state.swap !== null) {
      state.own = state.swap
      state.swap = null
    }
    const next = literal()
    if (next !== seen) {
      seen = next
      state.hmr++
      state.literals.push(next)
      state.own = 'none'
      state.swap = next
    }
    state.frames.push({ step: state.step, shown: state.override ?? state.own })
  }, 16)
  const port = {
    async apply(_key, from, css) {
      if (state.override === null && state.own !== from) return 0
      state.override = css
      return 1
    },
    async settle(_key, css) {
      if (state.override === null) return true
      if (state.override !== css || state.own !== css) return false
      state.override = null
      state.removedAt = state.frames.length
      return true
    },
    async clear() {
      state.override = null
    }
  }
  return { state, port, stop: () => clearInterval(timer) }
}

/** Every frame shows the derived value of the current or previous step, in drag order. */
function departures(frames, steps) {
  let last = -1,
    gaps = 0,
    outOfOrder = 0,
    foreign = 0
  for (const { step, shown } of frames) {
    if (step < 0) continue
    const index = steps.lastIndexOf(shown)
    if (shown === 'none') gaps++
    else if (index < 0) foreign++
    else if (index < last) outOfOrder++
    else if (index < step - 1) foreign++
    if (index >= 0) last = Math.max(last, index)
  }
  return { gaps, outOfOrder, foreign }
}

async function drag(islands, chat, island, path, { gesture, ended = true, interval = 20 }) {
  const view = islands.sessions.get(chat).views.get(island)
  const command = (values) => ({
    chat,
    id: island,
    revision: view.revision,
    sourceRevision: view.sourceRevision,
    operation: crypto.randomUUID(),
    action: 'commit',
    gesture,
    values
  })
  const sent = []
  for (const [index, [x, y]] of path.entries()) {
    const last = ended && index === path.length - 1
    sent.push(islands.interact({ ...command({ x, y }), ended: last }))
    await sleep(interval)
  }
  await Promise.all(sent)
}

async function setup(name, overrides) {
  await writeFile(file, code)
  const islands = new ChatIslands(() => {}, undefined, overrides ? { overrides } : {})
  islands.register(name, root, `${name}-record`, () => 1)
  const made = await islands.tool(name, root, request)
  assert.ok(made.id, JSON.stringify(made))
  await islands.settle(name, true)
  return { islands, island: made.id }
}
const undo = (islands, chat, island) => {
  const view = islands.sessions.get(chat).views.get(island)
  return islands.interact({
    chat,
    id: island,
    revision: view.revision,
    sourceRevision: view.sourceRevision,
    operation: crypto.randomUUID(),
    action: 'undo',
    values: {}
  })
}
const until = async (check, what) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return
    await sleep(10)
  }
  throw new Error(`Timed out: ${what}`)
}

// A drag over the Light Source pad: 12 steps of 0.04 in x and 0.03 in y.
const path = Array.from({ length: 12 }, (_, i) => [
  Number((0.2 + i * 0.04).toFixed(2)),
  Number((-0.3 + i * 0.03).toFixed(2))
])
const steps = [shadowLight(initial).css, ...path.map(([x, y]) => derived(x, y))]

// Hypothesis 3: the formula. Light only moves the offsets; alpha and blur do not depend on it,
// and a step of the pad moves an offset by at most distance × step.
{
  const grid = []
  for (let x = -1; x <= 1.0001; x += 0.05)
    for (let y = -1; y <= 1.0001; y += 0.05)
      grid.push(shadowLight({ ...initial, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) }))
  const alphas = new Set(grid.map((r) => r.layers.map((l) => l.alpha).join('/')))
  const blurs = new Set(grid.map((r) => r.layers.map((l) => l.blurPx).join('/')))
  const jumps = path.slice(1).map(([x, y], i) => {
    const a = shadowLight({ ...initial, x: path[i][0], y: path[i][1] }).layers,
      b = shadowLight({ ...initial, x, y }).layers
    return Math.max(
      ...a.map((l, j) => Math.max(Math.abs(l.xPx - b[j].xPx), Math.abs(l.yPx - b[j].yPx)))
    )
  })
  const formula = {
    gridPoints: grid.length,
    alphaSets: alphas.size,
    alphas: [...alphas][0],
    blurSets: blurs.size,
    maxStepOffsetPx: Math.max(...jumps)
  }
  console.log(`ISLAND-FLICKER formula ${JSON.stringify(formula)}`)
  assert.equal(alphas.size, 1, 'The light never changes layer opacity')
  assert.equal(blurs.size, 1, 'The light never changes blur')
  assert.ok(
    formula.maxStepOffsetPx <= initial.distance * 0.04 + 1e-9,
    'A pad step moves an offset by at most distance × step'
  )
}

// Before the fix (LKM-133 live writes, no override): hypotheses 1 and 2 on the same drag.
{
  const { islands, island } = await setup('before')
  const p = page()
  try {
    const sends = path.map((_, i) => i)
    let index = 0
    const view = islands.sessions.get('before').views.get(island)
    const sent = []
    for (const [x, y] of path) {
      p.state.step = ++index
      sent.push(
        islands.interact({
          chat: 'before',
          id: island,
          revision: view.revision,
          sourceRevision: view.sourceRevision,
          operation: crypto.randomUUID(),
          action: 'commit',
          gesture: 'drag',
          ended: index === path.length,
          values: { x, y }
        })
      )
      await sleep(20)
    }
    await Promise.all(sent)
    await until(() => p.state.own === steps.at(-1), 'the last HMR update')
    await sleep(50)
    const orderedLiterals = p.state.literals.every(
      (literal, i) => i === 0 || steps.indexOf(literal) > steps.indexOf(p.state.literals[i - 1])
    )
    const result = {
      steps: sends.length,
      hmrEvents: p.state.hmr,
      writtenLiterals: p.state.literals.length,
      literalsInDragOrder: orderedLiterals,
      ...departures(p.state.frames, steps)
    }
    console.log(`ISLAND-FLICKER before ${JSON.stringify(result)}`)
    assert.ok(result.hmrEvents > 1, 'Live writes run one HMR update per written frame')
    assert.ok(result.gaps > 0, 'A gap-frame CSS swap shows through every live write')
    assert.ok(orderedLiterals, 'The island never reorders writes (hypothesis 2)')
    await undo(islands, 'before', island)
    assert.equal(await readFile(file, 'utf8'), code, 'One Undo restores the live drag')
  } finally {
    p.stop()
    islands.close('before')
  }
}

// The fix: same drag. No gap, no out-of-order value, one write, one Undo group.
{
  const p = page()
  const events = []
  const overrides = new IslandOverrides(p.port, { idle: 2000, poll: 10, timeout: 3000 }, (event) =>
    events.push({ ...event, frame: p.state.frames.length })
  )
  const { islands, island } = await setup('after', overrides)
  try {
    const view = islands.sessions.get('after').views.get(island)
    const sent = []
    for (const [index, [x, y]] of path.entries()) {
      p.state.step = index + 1
      sent.push(
        islands.interact({
          chat: 'after',
          id: island,
          revision: view.revision,
          sourceRevision: view.sourceRevision,
          operation: crypto.randomUUID(),
          action: 'commit',
          gesture: 'drag',
          ended: index === path.length - 1,
          values: { x, y }
        })
      )
      await sleep(20)
      if (index < path.length - 1)
        assert.equal(await readFile(file, 'utf8'), code, 'No source write mid-gesture')
    }
    await Promise.all(sent)
    await until(
      () => p.state.override === null && p.state.own === steps.at(-1),
      'override removal after the final HMR'
    )
    await sleep(50)
    const removed = events.find((e) => e.type === 'removed'),
      written = events.find((e) => e.type === 'written')
    const result = {
      steps: path.length,
      hmrEvents: p.state.hmr,
      writes: events.filter((e) => e.type === 'write').length,
      shownFrames: events.filter((e) => e.type === 'show').length,
      ...departures(p.state.frames, steps),
      overrideRemovedAtFrame: p.state.removedAt,
      writtenAtFrame: written.frame
    }
    console.log(`ISLAND-FLICKER after ${JSON.stringify(result)}`)
    assert.equal(result.writes, 1, 'One source write per gesture')
    assert.equal(result.hmrEvents, 1, 'One HMR update per gesture')
    assert.deepEqual(
      [result.gaps, result.outOfOrder, result.foreign],
      [0, 0, 0],
      'Every frame shows the current or previous step'
    )
    assert.ok(
      removed && p.state.frames[p.state.removedAt - 1]?.shown === steps.at(-1),
      'The override is removed only once the page shows the final value'
    )
    assert.match(
      await readFile(file, 'utf8'),
      new RegExp(`SHADOW_x = ${path.at(-1)[0]};\\nconst SHADOW_y = ${path.at(-1)[1]};`)
    )
    await undo(islands, 'after', island)
    assert.equal(await readFile(file, 'utf8'), code, 'One Undo restores the gesture')
    await assert.rejects(
      undo(islands, 'after', island),
      /No edit/,
      'The gesture was a single Undo group'
    )
    await until(() => p.state.own === steps[0], 'HMR of the Undo')

    // No release (a client that never sends `ended`): the write comes after `idle`; the
    // override still waits for the HMR update.
    const idle = new IslandOverrides(p.port, { idle: 120, poll: 10, timeout: 3000 })
    const quiet = await setup('idle', idle)
    p.state.own = steps[0]
    await drag(quiet.islands, 'idle', quiet.island, path.slice(0, 3), {
      gesture: 'quiet',
      ended: false
    })
    assert.equal(await readFile(file, 'utf8'), code, 'Nothing is written before the idle delay')
    assert.equal(p.state.override, steps[3])
    await until(
      async () => (await readFile(file, 'utf8')).includes(`SHADOW_x = ${path[2][0]};`),
      'idle write'
    )
    assert.equal(p.state.override, steps[3], 'The override is held until the HMR update applied')
    await until(() => p.state.override === null, 'idle override removal')
    await undo(quiet.islands, 'idle', quiet.island)
    assert.equal(await readFile(file, 'utf8'), code)
    quiet.islands.close('idle')
    await until(() => p.state.own === steps[0], 'HMR of the idle Undo')

    // LKM-133 conflict rule: a bound value changed outside the island during the gesture. The
    // release writes nothing, the notice is set and the override is removed at once.
    await drag(islands, 'after', island, path.slice(0, 2), { gesture: 'conflict', ended: false })
    assert.equal(p.state.override, steps[2])
    const external = code.replace('SHADOW_x = 0.72', 'SHADOW_x = 0.1')
    await writeFile(file, external)
    await islands.interact({
      chat: 'after',
      id: island,
      revision: view.revision,
      sourceRevision: view.sourceRevision,
      operation: crypto.randomUUID(),
      action: 'commit',
      gesture: 'conflict',
      ended: true,
      values: { x: 0.5, y: 0.5 }
    })
    assert.equal(await readFile(file, 'utf8'), external, 'A conflicted gesture writes nothing')
    assert.equal(p.state.override, null, 'The override is removed when the write is refused')
    assert.equal(islands.sessions.get('after').views.get(island).notice, ISLAND_CONFLICT_NOTICE)
    await writeFile(file, code)
    await islands.refresh('after')

    // Undo while an override waits for its HMR update: the override goes at once.
    p.state.own = steps[0]
    await drag(islands, 'after', island, path.slice(0, 2), { gesture: 'undo-race', ended: false })
    assert.equal(p.state.override, steps[2])
    await islands.interact({
      chat: 'after',
      id: island,
      revision: view.revision,
      sourceRevision: view.sourceRevision,
      operation: crypto.randomUUID(),
      action: 'reload',
      values: {}
    })
    assert.equal(p.state.override, null, 'Reload removes the override')
    assert.equal(await readFile(file, 'utf8'), code, 'A cleared gesture is never written')
  } finally {
    p.stop()
    islands.close('after')
  }
}

// No element shows the island's shadow (for example a Tailwind class list the preview cannot
// match): the gesture writes live, exactly as LKM-133.
{
  const writes = []
  const blind = { apply: async () => 0, settle: async () => true, clear: async () => {} }
  const { islands, island } = await setup(
    'blind',
    new IslandOverrides(blind, { idle: 2000, poll: 10, timeout: 1000 }, (e) => writes.push(e.type))
  )
  await drag(islands, 'blind', island, path.slice(0, 3), { gesture: 'live' })
  assert.ok(writes.includes('live') && !writes.includes('show'), 'Frames fall back to live writes')
  assert.match(await readFile(file, 'utf8'), new RegExp(`SHADOW_x = ${path[2][0]};`))
  await undo(islands, 'blind', island)
  assert.equal(await readFile(file, 'utf8'), code, 'One Undo restores the live fallback gesture')
  islands.close('blind')
}
// An island with a Shadow block and a group slider: only the shadow's own values take the
// override path. The slider keeps LKM-133's live write on every frame, and a gesture that
// moves from the shadow to the slider shows the source and writes what it holds.
{
  const calls = []
  const port = {
    async apply(_k, _f, css) {
      calls.push(['apply', css])
      return 1
    },
    async settle() {
      return true
    },
    async clear() {
      calls.push(['clear'])
    }
  }
  const mixedCode = `${code}const TILT = 3;\n`
  const mixed = {
    ...request,
    manifest: {
      ...request.manifest,
      params: [
        ...request.manifest.params,
        {
          id: 'tilt',
          label: 'Tilt',
          kind: 'number',
          min: 0,
          max: 10,
          step: 1,
          apply: { strategy: 'literal', anchor: 'const TILT = ' }
        }
      ]
    },
    blocks: [...request.blocks, { id: 'tilt', title: 'Tilt', kind: 'group', params: ['tilt'] }]
  }
  await writeFile(file, mixedCode)
  const islands = new ChatIslands(() => {}, undefined, {
    overrides: new IslandOverrides(port, { idle: 2000, poll: 10, timeout: 1000 })
  })
  islands.register('mixed', root, 'mixed-record', () => 1)
  const made = await islands.tool('mixed', root, mixed)
  assert.ok(made.id, JSON.stringify(made))
  await islands.settle('mixed', true)
  const view = islands.sessions.get('mixed').views.get(made.id)
  const send = (gesture, values, ended = false) =>
    islands.interact({
      chat: 'mixed',
      id: made.id,
      revision: view.revision,
      sourceRevision: view.sourceRevision,
      operation: crypto.randomUUID(),
      action: 'commit',
      gesture,
      ended,
      values
    })
  const read = () => readFile(file, 'utf8')

  for (const tilt of [4, 5, 6]) {
    await send('tilt', { tilt })
    assert.match(
      await read(),
      new RegExp(`const TILT = ${tilt};`),
      `Slider frame ${tilt} is written at once`
    )
  }
  await send('tilt', { tilt: 7 }, true)
  assert.equal(calls.length, 0, 'The slider never takes the override path')

  await send('light', { x: path[0][0], y: path[0][1] })
  assert.equal(
    calls.filter((c) => c[0] === 'apply').length,
    1,
    'A shadow value is still shown in the preview'
  )
  assert.match(await read(), /const TILT = 7;/)
  assert.doesNotMatch(
    await read(),
    new RegExp(`SHADOW_x = ${path[0][0]};`),
    'and its write is deferred'
  )

  // The gesture turns out to move another control: the held frames are written, nothing is lost.
  await send('both', { x: path[1][0], y: path[1][1] })
  await send('both', { tilt: 9 })
  assert.ok(
    calls.some((c) => c[0] === 'clear'),
    'The override is removed'
  )
  assert.match(
    await read(),
    new RegExp(`SHADOW_x = ${path[1][0]};`),
    'the held shadow values are written'
  )
  assert.match(await read(), /const TILT = 9;/)
  await send('both', { tilt: 10 }, true)
  assert.match(await read(), /const TILT = 10;/, 'later frames write live')
  islands.close('mixed')
}
console.log('ISLAND-FLICKER PASS')
process.exit(0)
