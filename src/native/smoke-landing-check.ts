import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capturePreview } from '../main/preview-state'
import type { NativeBridge } from './bridge'
import { nativeChat, postLandingCheck } from './chat-runtime'
import { LANDING_CHECK, type LandingCheckHost, LandingChecks } from './landing-check'
import { inspectUntil } from './smoke-wait'

const rect = (value: string) => {
  const [x, y, width, height] = (value.match(/-?[\d.]+(e[-+]?\d+)?/g) ?? []).map(Number)
  return { x, y, width, height }
}
const SERVER = 'http://127.0.0.1:5173/'
// A 2x2 PNG, only when the preview has no frame to capture.
const FALLBACK =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOo6DlR0XOCAUIBADEeBzEmDH0yAAAAAElFTkSuQmCC'

/** LKM-195: three landings (clean, console errors, preview not running) go through the
 *  real check and post path and render as compact rows with the preview's thumbnail.
 *  The console output is a fixture; the thumbnail is the real preview capture. */
export async function checkLandingChecks(host: NativeBridge, artifacts: string) {
  const chat = nativeChat.get(nativeChat.active)
  const kept = chat.messages.length
  const image = await capturePreview()
  const jpeg = image && !image.isEmpty() ? image.toJPEG(70).toString('base64') : ''
  const landings: { errors: { text: string; at: number }[]; server: string | null }[] = [
    { errors: [], server: SERVER },
    {
      errors: [{ text: 'ReferenceError: HeroBanner is not defined', at: Date.now() + 60_000 }],
      server: SERVER
    },
    { errors: [], server: null }
  ]
  try {
    for (const landing of landings) {
      const stub: LandingCheckHost = {
        server: () => landing.server,
        url: () => `${SERVER}work`,
        errors: async () => landing.errors,
        capture: async () => jpeg || FALLBACK,
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: Date.now
      }
      const checks = new LandingChecks(stub, postLandingCheck, {
        ...LANDING_CHECK,
        settleMs: 0,
        readyMs: 0,
        pollMs: 0
      })
      await checks.landed(
        chat.chat,
        chat.root || '/smoke',
        ['src/App.tsx'],
        chat.messages.at(-1)?.id
      )
    }
    const ids = chat.messages.slice(kept).map((m) => m.id)
    assert.equal(ids.length, landings.length, 'Every landing posts one row')
    const state = await inspectUntil(
      (m) => host.request(m),
      'chatInspect',
      (s) => ids.every((id) => s.landingChecks?.some((c: { id: string }) => c.id === id))
    )
    const shown = ids.map((id) => state.landingChecks.find((c: { id: string }) => c.id === id))
    assert.deepEqual(
      shown.map((c) => [c.status, c.line, c.thumbnail]),
      [
        ['clean', 'Checked after landing: no console errors', true],
        ['errors', 'Checked after landing: 1 console error', true],
        ['unchecked', 'Not checked after landing: the preview is not running', false]
      ]
    )
    assert.deepEqual(shown[1].errors, ['ReferenceError: HeroBanner is not defined'])
    await host.request('chatAcceptance', { prepare: true })
    const heights: number[] = []
    for (const mode of ['light', 'dark'] as const) {
      const dark = mode === 'dark'
      const result = await host.request('chatLandingChecks', { dark, messages: ids })
      writeFileSync(join(artifacts, `landing-check-${mode}.png`), Buffer.from(result.png, 'base64'))
      assert.equal(/dark/i.test(result.appearance), dark, `Appearance ${result.appearance}`)
      for (const row of result.rows) {
        const frame = rect(row.frame)
        assert.ok(row.inView, `${mode}: row ${row.id} is in view ${row.frame}`)
        heights.push(frame.height)
      }
      const [clean, errors, unchecked] = result.rows.map((row: any) => rect(row.frame).height)
      // Compact: the thumbnail sets a clean row's height; the unchecked row is one line.
      assert.ok(clean <= 60, `${mode}: clean row is compact (${clean} pt)`)
      assert.ok(unchecked <= 40, `${mode}: unchecked row is one line (${unchecked} pt)`)
      assert.ok(errors <= 90, `${mode}: error row is compact (${errors} pt)`)
    }
    console.log(
      `Landing checks: clean, errors and unchecked rows (${heights.join('/')} pt) in light and dark; thumbnail ${jpeg ? 'from the preview' : 'fallback'}.`
    )
  } finally {
    await host.request('chatLandingChecks', { restore: true })
    chat.messages.splice(kept)
    nativeChat.changed(chat)
  }
}
