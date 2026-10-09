import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { dispatchIPC } from './platform'
import { waitFor } from './smoke-wait'

export const WRAP_SAMPLE = 'wrap-sample.ts'
const PROBE = 'const long'
const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
/** Line 3 is 300 characters, indented four spaces. */
const LONG = `${`    ${PROBE} = '${words}`.padEnd(299, ' x')}'`
const SAMPLE = `export function sample() {\n  const a = 1\n${LONG}\n  return a\n}\n`

/**
 * Soft wrap in the native editor (LKM-192): a 300-character line wraps inside the
 * visible width with no horizontal scroller, hangs at its own indent and is numbered
 * once; Wrap Lines turns it off from the View menu and back on from the "…" menu, and
 * the remembered state reaches the editor; Home/End move by logical line.
 */
export async function checkSourceWrap(host: NativeBridge, fixture: string, artifacts: string) {
  assert.equal(LONG.length, 300)
  // biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
  const wrap = (params: Record<string, unknown> = {}): Promise<any> =>
    host.request('sourceWrap', { root: fixture, probe: PROBE, ...params })
  writeFileSync(join(fixture, WRAP_SAMPLE), SAMPLE)
  await dispatchIPC('main', {
    type: 'invoke',
    channel: 'source:popout',
    args: [fixture, WRAP_SAMPLE]
  })
  await waitFor(async () => {
    const s = await host.request('sourceInspect')
    return s.popped && s.source === WRAP_SAMPLE && s.text === SAMPLE
  }, 'wrap sample open')
  await host.request('sourceResize', { root: fixture, width: 1000, height: 700 })

  let on = await wrap()
  await waitFor(async () => {
    on = await wrap()
    return on.fragments?.length > 1 && on.state === true
  }, 'long line wraps').catch(() => assert.fail(`The long line wraps: ${JSON.stringify(on)}`))
  const text = JSON.stringify(on)
  assert.ok(on.wraps && on.state === true, `Wrap Lines is on by default: ${text}`)
  assert.ok(!on.hasHorizontalScroller && !on.horizontalVisible, `No horizontal scroller: ${text}`)
  assert.ok(on.documentWidth <= on.clipWidth + 0.5, `The text fits the visible width: ${text}`)
  assert.equal(on.length, 300)
  for (const row of on.fragments)
    assert.ok(row.usedMaxX <= on.containerWidth + 0.5, `A visual line overflows: ${text}`)
  // Continuation lines hang at the line's own indent, where its code starts.
  for (const row of on.fragments.slice(1))
    assert.ok(Math.abs(row.x - on.codeX) < 1, `Continuation hangs at ${on.codeX}: ${text}`)
  // The ruler numbers each logical line once, at its first visual line.
  const labels: { line: number; y: number }[] = on.labels
  assert.deepEqual(
    labels.map((label) => label.line),
    labels.map((_, i) => labels[0].line + i),
    `Ruler numbers are consecutive: ${text}`
  )
  const at = (line: number) => labels.find((label) => label.line === line)
  assert.equal(on.line, 3)
  assert.ok(Math.abs((at(3)?.y ?? -1) - on.fragments[0].y) < 0.5, `Line 3's number: ${text}`)
  assert.ok(Math.abs((at(4)?.y ?? -1) - on.nextY) < 0.5, `Line 4's number after the wrap: ${text}`)
  for (const row of on.fragments.slice(1))
    assert.ok(
      !labels.some((label) => Math.abs(label.y - row.y) < 0.5),
      `A continuation is numbered: ${text}`
    )

  const keys = await wrap({ keys: true })
  assert.equal(
    keys.home,
    keys.start,
    `Home goes to the logical line start: ${JSON.stringify(keys)}`
  )
  assert.equal(keys.endKey, keys.end, `End goes to the logical line end: ${JSON.stringify(keys)}`)
  assert.ok(
    keys.down >= keys.secondStart && keys.down <= keys.secondEnd,
    `Arrow down moves one visual line: ${JSON.stringify(keys)}`
  )

  const offscreen = process.env.TREZI_NATIVE_BACKGROUND_TEST === '1'
  if (offscreen)
    console.log('SKIP foreground wrap capture: TREZI_NATIVE_BACKGROUND_TEST (offscreen saved)')
  else
    await waitFor(async () => {
      const s = await host.request('sourceVerification', { root: fixture, prepare: true })
      return s.active && s.key && s.visible
    }, 'wrap capture foreground')
  const image = await host.request('sourceSyntax', { root: fixture, capture: 'light', offscreen })
  writeFileSync(join(artifacts, 'source-wrap.png'), Buffer.from(image.png, 'base64'))

  // View → Wrap Lines turns it off; the remembered preference comes back as the state.
  const view = await wrap({ choose: 'view' })
  assert.ok(view.enabled && view.checked && view.sent, `View → Wrap Lines: ${JSON.stringify(view)}`)
  let off = await wrap()
  await waitFor(async () => {
    off = await wrap()
    return off.state === false && !off.wraps
  }, 'Wrap Lines off').catch(() => assert.fail(`Wrap Lines off: ${JSON.stringify(off)}`))
  assert.ok(off.hasHorizontalScroller, `Horizontal scrolling is back: ${JSON.stringify(off)}`)
  assert.equal(off.fragments.length, 1, 'The long line is one visual line')
  assert.ok(
    off.documentWidth > off.clipWidth,
    `The text is wider than the view: ${JSON.stringify(off)}`
  )

  // The "…" menu shows it unchecked and turns it back on.
  const more = await wrap({ choose: 'more' })
  assert.ok(more.enabled && !more.checked, `… → Wrap Lines: ${JSON.stringify(more)}`)
  await waitFor(async () => {
    const s = await wrap()
    return s.state === true && s.wraps && s.fragments.length > 1 && !s.hasHorizontalScroller
  }, 'Wrap Lines on again')
  writeFileSync(
    join(artifacts, 'source-wrap.json'),
    JSON.stringify({ on, keys, view, off: { ...off, labels: undefined }, more }, null, 2)
  )
  console.log(
    'Native soft wrap: 300-character line wraps without a horizontal scroller, hanging indent, ruler numbers, Home/End, Wrap Lines from View and … menus pass.'
  )
}

/** Turns Wrap Lines back on, closes the editor and deletes the sample. */
export async function restoreSourceWrap(host: NativeBridge, fixture: string) {
  const perform = (action: string, extra: Record<string, unknown> = {}) =>
    host.request('sourcePerform', { action: { root: fixture, action, ...extra } })
  const state = await host.request('sourceWrap', { root: fixture, probe: PROBE }).catch(() => null)
  if (state && state.state === false) await perform('wrap', { wrap: true })
  if ((await host.request('sourceInspect')).popped) await perform('dock')
  if ((await host.request('sourceInspect')).visible) await perform('hide')
  rmSync(join(fixture, WRAP_SAMPLE), { force: true })
}
