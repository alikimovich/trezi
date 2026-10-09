import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { syntaxTokenizer } from '../main/syntax-shiki'
import type { NativeBridge } from './bridge'
import { dispatchIPC } from './platform'
import {
  assertLoadAwareTiming,
  formatLoadAwareTiming,
  type LoadAwareTiming,
  median,
  systemLoad,
  TIMING_RUNS
} from './smoke-timing'
import { waitFor } from './smoke-wait'
import { tsxSample } from './syntax-sample'

export const SYNTAX_SAMPLE = 'syntax-sample.tsx'
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Probe text → the category its first character shows. */
const PROBES: Record<string, string> = {
  'import {': 'keyword',
  "'react'": 'string',
  '// Card 1:': 'comment',
  'interface Card1Props': 'keyword',
  'Card1Props {': 'typeDeclaration',
  'string\n': 'type',
  'useState(false)': 'function',
  '/[^a-z0-9]+/g': 'regex',
  'section className': 'tag',
  'className="card"': 'attribute',
  '"card"': 'string',
  '0)\n': 'number'
}
const KEYSTROKES = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn'

interface Typed {
  keystrokes: number[]
  wall: number[]
  highlighted: number
  revision: number
}
interface TypingPass {
  keystrokes: number[]
  wall: number[]
  p95: number
  wallP95: number
  worst: number
  load: number
}
/** The p95 of a pass's keystrokes after the first five, which warm caches (the first
 *  edit message, layout of the line). */
const p95Of = (values: number[]) => {
  const sorted = values.slice(5).sort((a, b) => a - b)
  return { p95: sorted[Math.floor(sorted.length * 0.95)], worst: sorted[sorted.length - 1] }
}
const typingPass = (typed: Typed, load: number): TypingPass => ({
  keystrokes: typed.keystrokes,
  wall: typed.wall,
  ...p95Of(typed.keystrokes),
  wallP95: p95Of(typed.wall).p95,
  load
})

/**
 * Grammar highlighting in the native editor (LKM-183) on a 3,000-line TSX file: the
 * categories shown at probe texts, the main-thread cost of each keystroke (under 16 ms)
 * and the code captured in light and dark. Without Shiki (not installed) the category
 * probes are skipped and said so; typing and the captures still run.
 */
export async function checkSourceSyntax(host: NativeBridge, fixture: string, artifacts: string) {
  const verify = (params: Record<string, unknown>) =>
    host.request('sourceSyntax', { root: fixture, ...params })
  // Shiki is a declared dependency: when it cannot load, the check fails, never skips.
  await syntaxTokenizer('tsx').catch((error) =>
    assert.fail(`Shiki must be installed (bun add shiki@^3): ${String(error?.message ?? error)}`)
  )
  const sample = tsxSample(3000)
  writeFileSync(join(fixture, SYNTAX_SAMPLE), sample)
  await dispatchIPC('main', {
    type: 'invoke',
    channel: 'source:popout',
    args: [fixture, SYNTAX_SAMPLE]
  })
  await waitFor(async () => {
    const s = await host.request('sourceInspect')
    return s.popped && s.source === SYNTAX_SAMPLE && s.text === sample
  }, 'syntax sample open')
  await host.request('sourceResize', { root: fixture, width: 1000, height: 700 })

  const expected = Object.keys(PROBES)
  let shown: Record<string, unknown> = {}
  await waitFor(
    async () => {
      const state = await verify({ probes: expected })
      shown = state.categories
      return state.highlighted === state.revision && expected.every((p) => shown[p] === PROBES[p])
    },
    'syntax categories',
    15000
  ).catch(() => assert.fail(`Highlight categories: ${JSON.stringify(shown)}`))

  // LKM-222: each keystroke's cost is the main thread's CPU time (insertion, layout,
  // display, state update and highlight apply), so other workers building on the same Mac
  // do not inflate it as wall time did (57–110 ms under load, ~11 ms alone). A pass's
  // statistic is its p95 after the first five keystrokes (caches warming). One warm-up pass,
  // then the median of TIMING_RUNS passes: reported against the 16 ms target, failing
  // above twice it while the machine is not overloaded. The load is recorded per pass.
  let typed: Typed = { keystrokes: [], wall: [], highlighted: 0, revision: 0 }
  const wrapping = async (on: boolean) => {
    await host.request('sourcePerform', { action: { root: fixture, action: 'wrap', wrap: on } })
    await waitFor(async () => (await verify({ probes: [] })).wraps === on, `wrap ${on}`)
  }
  const typePasses = async (runs: number) => {
    const passes: TypingPass[] = []
    for (let pass = -1; pass < runs; pass++) {
      await waitFor(async () => {
        const state = await verify({ probes: [] })
        return state.highlighted === state.revision
      }, 'highlighter converged before typing')
      await delay(500)
      const load = loadavg()[0]
      typed = await verify({ type: KEYSTROKES, after: 'const total', pace: 0.06 })
      assert.ok(
        Array.isArray(typed.keystrokes) && Array.isArray(typed.wall),
        `Typing ran: ${JSON.stringify(typed)}`
      )
      if (pass >= 0) passes.push(typingPass(typed, load))
    }
    return passes
  }
  await wrapping(true)
  const passes = await typePasses(TIMING_RUNS)
  const typedWrapping = typed
  // The same passes without soft wrap (LKM-192), reported only: the wrap's own cost.
  await wrapping(false)
  const unwrapped = await typePasses(3)
  await wrapping(true)
  const load = systemLoad(Math.max(...passes.map((pass) => pass.load)))
  const report = (runs: TypingPass[]) =>
    runs
      .map(
        (run) =>
          `[p95 ${run.p95.toFixed(2)} cpu, ${run.wallP95.toFixed(2)} wall, load ${run.load.toFixed(2)}: ${run.keystrokes.map((ms) => ms.toFixed(1)).join(' ')}]`
      )
      .join(' ')
  const wrapCost = median(passes.map((run) => run.p95)) - median(unwrapped.map((run) => run.p95))
  console.log(
    `Native syntax typing wrap cost: p95 median ${median(unwrapped.map((run) => run.p95)).toFixed(2)} ms without wrap, ${wrapCost >= 0 ? '+' : ''}${wrapCost.toFixed(2)} ms with wrap (wall p95 median ${median(passes.map((run) => run.wallP95)).toFixed(2)} ms wrapped, ${median(unwrapped.map((run) => run.wallP95)).toFixed(2)} ms unwrapped)`
  )
  // A failure carries every pass's keystrokes and load, so load tells apart from a slower editor.
  let timing: LoadAwareTiming
  try {
    timing = assertLoadAwareTiming(
      'Native syntax typing (3,000-line TSX), main-thread CPU p95 per keystroke',
      16,
      passes.map((run) => run.p95),
      load
    )
  } catch (error) {
    assert.fail(`${(error as Error).message} (per pass, per keystroke CPU ms: ${report(passes)})`)
  }
  console.log(formatLoadAwareTiming(timing))
  if (timing.overTarget) console.log(`WARN over the 16 ms target: ${report(passes)}`)
  const { p95, worst } = [...passes].sort((a, b) => a.p95 - b.p95)[passes.length >> 1]
  assert.equal(
    typedWrapping.highlighted,
    typedWrapping.revision,
    'The last wrapped keystroke is highlighted'
  )
  assert.equal(typed.highlighted, typed.revision, 'The last keystroke is highlighted')
  const after = await verify({ probes: expected })
  assert.ok(
    expected.every((p) => after.categories[p] === PROBES[p]),
    `Highlights survive typing: ${JSON.stringify(after.categories)}`
  )

  const offscreen = process.env.TREZI_NATIVE_BACKGROUND_TEST === '1'
  if (offscreen)
    console.log('SKIP foreground syntax captures: TREZI_NATIVE_BACKGROUND_TEST (offscreen saved)')
  else
    await waitFor(async () => {
      const s = await host.request('sourceVerification', { root: fixture, prepare: true })
      return s.active && s.key && s.visible
    }, 'syntax capture foreground')
  await delay(300)
  for (const appearance of ['light', 'dark']) {
    const image = await verify({ capture: appearance, offscreen })
    writeFileSync(
      join(artifacts, `source-syntax-${appearance}.png`),
      Buffer.from(image.png, 'base64')
    )
  }
  writeFileSync(
    join(artifacts, 'source-syntax.json'),
    JSON.stringify(
      {
        clock: 'thread-cpu',
        timing,
        p95,
        worst,
        passes,
        unwrapped,
        wrapCost,
        categories: after.categories
      },
      null,
      2
    )
  )
  console.log(
    'Native syntax highlighting: TSX categories, main-thread typing within the load-aware gate with highlights applied, light/dark captures pass.'
  )
}

/** Turns Wrap Lines back on, discards the typed draft, closes the editor and deletes the sample. */
export async function restoreSourceSyntax(host: NativeBridge, fixture: string) {
  const perform = (action: string, extra: Record<string, unknown> = {}) =>
    host.request('sourcePerform', { action: { root: fixture, action, ...extra } })
  const shown = await host.request('sourceSyntax', { root: fixture, probes: [] }).catch(() => null)
  if (shown && shown.wraps === false) await perform('wrap', { wrap: true })
  const state = await host.request('sourceInspect')
  if (state.source === SYNTAX_SAMPLE && state.dirty) {
    await perform('reload')
    await waitFor(
      async () => !(await host.request('sourceInspect')).dirty,
      'syntax draft discarded'
    )
  }
  if ((await host.request('sourceInspect')).popped) await perform('dock')
  if ((await host.request('sourceInspect')).visible) await perform('hide')
  rmSync(join(fixture, SYNTAX_SAMPLE), { force: true })
}
