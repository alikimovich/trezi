import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { syntaxTokenizer } from '../main/syntax-shiki'
import type { NativeBridge } from './bridge'
import { dispatchIPC } from './platform'
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

/**
 * Grammar highlighting in the native editor (LKM-183) on a 3,000-line TSX file: the
 * categories shown at probe texts, the main-thread cost of each keystroke (under 16 ms)
 * and the code captured in light and dark. Without Shiki (not installed) the category
 * probes are skipped and said so; typing and the captures still run.
 */
export async function checkSourceSyntax(host: NativeBridge, fixture: string, artifacts: string) {
  const verify = (params: Record<string, unknown>) =>
    host.request('sourceSyntax', { root: fixture, ...params })
  const shiki = await syntaxTokenizer('tsx').then(
    () => '',
    (error) => String(error?.message ?? error)
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

  if (shiki) console.log(`SKIP source-syntax category probes: Shiki unavailable (${shiki})`)
  else {
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
  }

  const typed = await verify({ type: KEYSTROKES, after: 'const total', pace: 0.06 })
  assert.ok(Array.isArray(typed.keystrokes), `Typing ran: ${JSON.stringify(typed)}`)
  // The first keystrokes warm caches (the first edit message, layout of the line).
  const costs: number[] = typed.keystrokes.slice(5)
  const sorted = [...costs].sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)],
    worst = sorted[sorted.length - 1]
  console.log(
    `Native syntax typing (3,000-line TSX): p95 ${p95.toFixed(2)} ms, worst ${worst.toFixed(2)} ms, highlighted ${typed.highlighted}/${typed.revision}`
  )
  assert.ok(p95 < 16, `Main-thread work per keystroke p95 ${p95.toFixed(2)} ms ≥ 16 ms`)
  if (!shiki) assert.equal(typed.highlighted, typed.revision, 'The last keystroke is highlighted')

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
    JSON.stringify({ shiki: shiki || 'loaded', keystrokes: typed.keystrokes, p95, worst }, null, 2)
  )
  console.log(
    `Native syntax highlighting: ${shiki ? 'probes skipped' : 'TSX categories'}, typing under 16 ms, light/dark captures pass.`
  )
}

/** Discards the typed draft, closes the editor and deletes the sample. */
export async function restoreSourceSyntax(host: NativeBridge, fixture: string) {
  const perform = (action: string) =>
    host.request('sourcePerform', { action: { root: fixture, action } })
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
