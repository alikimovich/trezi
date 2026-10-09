import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setLandingProblem } from '../main/landing-context'
import type { NativeBridge } from './bridge'
import { nativeChat, postLandingCheck } from './chat-runtime'
import {
  LANDING_CHECK,
  type LandingCheckHost,
  LandingChecks,
  type LandingPage
} from './landing-check'
import { inspectUntil } from './smoke-wait'

const rect = (value: string) => {
  const [x, y, width, height] = (value.match(/-?[\d.]+(e[-+]?\d+)?/g) ?? []).map(Number)
  return { x, y, width, height }
}
const SERVER = 'http://127.0.0.1:5173/'
const LANDED = 'a'.repeat(40)
const PAGE: LandingPage = { blank: false, overlay: null, startedAt: 0, servedRevision: LANDED }

/** LKM-195/LKM-210: landings go through the real check and post path. A passing check
 *  adds no row; each problem (page did not load, dev-server error, blank page, console
 *  errors) is one compact warning row with Ask agent to fix and Show preview. The page
 *  reads are fixtures. */
export async function checkLandingChecks(host: NativeBridge, artifacts: string) {
  const chat = nativeChat.get(nativeChat.active)
  const kept = chat.messages.length
  const landings: (Partial<LandingCheckHost> & { expect: string | null })[] = [
    { expect: null },
    { expect: 'not-loaded', url: () => null },
    { expect: 'server-error', status: () => 500 },
    { expect: 'blank', page: async () => ({ ...PAGE, blank: true }) },
    {
      expect: 'errors',
      errors: async () => [
        { text: 'ReferenceError: HeroBanner is not defined', at: Date.now() + 60_000 }
      ]
    }
  ]
  try {
    for (const { expect: _, ...overrides } of landings) {
      const stub: LandingCheckHost = {
        server: () => SERVER,
        url: () => `${SERVER}work`,
        errors: async () => [],
        status: () => 200,
        page: async () => PAGE,
        head: async () => LANDED,
        turn: () => null,
        verified: () => false,
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: Date.now,
        ...overrides
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
    const problems = landings.flatMap((l) => (l.expect ? [l.expect] : []))
    assert.equal(ids.length, problems.length, 'A pass adds no row; every problem adds one')
    const state = await inspectUntil(
      (m) => host.request(m),
      'chatInspect',
      (s) => ids.every((id) => s.landingChecks?.some((c: { id: string }) => c.id === id))
    )
    const shown = ids.map((id) => state.landingChecks.find((c: { id: string }) => c.id === id))
    assert.deepEqual(
      shown.map((c) => [c.problem, c.line]),
      [
        ['not-loaded', 'The page did not load after landing'],
        ['server-error', 'The dev server answered HTTP 500 after landing'],
        ['blank', 'The page is blank after landing'],
        ['errors', '1 new console error after landing']
      ]
    )
    assert.deepEqual(shown[3].errors, ['ReferenceError: HeroBanner is not defined'])
    await host.request('chatAcceptance', { prepare: true })
    const heights: number[] = []
    for (const mode of ['light', 'dark'] as const) {
      const dark = mode === 'dark'
      const result = await host.request('chatLandingChecks', { dark, messages: ids })
      writeFileSync(join(artifacts, `landing-check-${mode}.png`), Buffer.from(result.png, 'base64'))
      assert.equal(/dark/i.test(result.appearance), dark, `Appearance ${result.appearance}`)
      for (const [index, row] of result.rows.entries()) {
        const frame = rect(row.frame)
        assert.ok(row.inView, `${mode}: row ${row.id} is in view ${row.frame}`)
        // Compact: the reason and the actions; an error line adds one more.
        const limit = shown[index].errors.length ? 90 : 70
        assert.ok(
          frame.height <= limit,
          `${mode}: ${shown[index].problem} row is compact (${frame.height} pt)`
        )
        heights.push(frame.height)
      }
    }
    console.log(
      `Landing checks: pass silent; not-loaded, server-error, blank and errors warning rows (${heights.join('/')} pt) in light and dark.`
    )
  } finally {
    await host.request('chatLandingChecks', { restore: true })
    setLandingProblem(chat.chat, null)
    chat.messages.splice(kept)
    nativeChat.changed(chat)
  }
}
