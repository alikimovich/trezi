// LKM-453: the opt-in chat recovery acceptance's rules (src/native/chat-recovery-acceptance.ts),
// GREEN on what the shipping conflict card shows and RED on what they exist to catch: a card
// that is not busy while its request is held, an enabled mutation, a second error card, a
// long or missing outcome, a report that crossed chats or kept a secret, and the RED render
// delay itself. The card's buttons are found by the acceptance's own host code
// (src/native/ChatRecoveryAcceptance.swift) on the real NativeChat in a window that is never
// shown, and its click and Space events must reach the right button and nothing else. The
// native run itself (`bun run acceptance:chat-recovery`) needs the foreground and is an
// operator step.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redact } from '../src/main/product-log.ts'
import {
  BUSY_MARKER,
  busyProblems,
  CHAT_RECOVERY_RED_MODES,
  delayRenders,
  failureProblems,
  idleProblems,
  PLANTED,
  reportProblems,
  stillHeldProblems
} from '../src/native/chat-recovery-acceptance.ts'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

const reading = [0, 120, 440, 520]
const button = (label, action, disabled, x) => ({
  label,
  action,
  disabled,
  frame: [x, 200, 60, 22]
})
const measure = (over = {}) => ({
  present: true,
  title: 'Problem',
  detail: 'Problem: The changes are still held after the checks and reconciliation.',
  busy: false,
  actions: ['Discard', 'Retry', 'Resolve', 'Copy support report'],
  disabled: [false, false, false, false],
  buttons: [
    button('Discard', 'discard', false, 120),
    button('Retry', 'landing-retry', false, 190),
    button('Resolve', 'resolve', false, 260),
    button('Copy support report', 'recovery-report', false, 330)
  ],
  problem: null,
  spinners: [],
  reading,
  cards: ['conflict'],
  ...over
})
const busy = (kind) => {
  const label = kind === 'retry' ? 'Retrying…' : 'Resolving…'
  return measure({
    busy: true,
    actions: kind === 'retry' ? ['Discard', label, 'Resolve'] : ['Discard', 'Retry', label],
    disabled: [true, true, true],
    buttons: [
      button('Discard', 'discard', true, 120),
      button(kind === 'retry' ? label : 'Retry', 'landing-retry', true, 190),
      button(kind === 'retry' ? 'Resolve' : label, 'resolve', true, 260)
    ],
    spinners: [[80, 300, 16, 16]]
  })
}

// GREEN: the shipping card while each request is held, and after it.
assert.deepEqual(busyProblems(busy('retry'), 'retry'), [])
assert.deepEqual(busyProblems(busy('resolve'), 'resolve'), [])
assert.deepEqual(idleProblems(measure()), [])
assert.deepEqual(failureProblems(measure()), [])
assert.deepEqual(
  stillHeldProblems(measure({ detail: 'The changes are still held. Review the reason below.' })),
  []
)
// RED: what a delayed or missing busy state looks like at the held boundary.
assert.match(busyProblems(measure(), 'retry').join('; '), /not busy.*Retrying….*spinner/)
assert.match(busyProblems(busy('retry'), 'resolve').join('; '), /no Resolving…/)
const enabled = busy('retry')
enabled.buttons[0].disabled = false
assert.deepEqual(busyProblems(enabled, 'retry'), ['Discard is enabled'])
// scripts/chat-recovery-acceptance.mjs meets RED only on this failure.
assert.equal(BUSY_MARKER, 'busy state before the reply')
assert.match(busyProblems(measure({ present: false }), 'retry').join(), /not shown/)
assert.match(busyProblems(measure({ problem: 'no row' }), 'retry').join(), /not found: no row/)
const outside = measure()
outside.buttons[2].frame = [430, 200, 60, 22]
assert.match(idleProblems(outside).join(), /Resolve is outside the reading area/)
// RED: a settled card that still spins, offers a busy label, or adds an error card.
assert.match(idleProblems(busy('retry')).join('; '), /still busy.*busy label.*spinner.*disabled/)
assert.match(idleProblems(measure({ cards: ['conflict', 'error'] })).join(), /error card/)
assert.match(
  stillHeldProblems(measure({ detail: 'The changes are still held.\nfixture.ts' })).join(),
  /one concise line/
)
assert.match(stillHeldProblems(measure({ detail: 'Problem: x' })).join(), /still held/)
assert.match(failureProblems(measure({ title: 'Held' })).join(), /Problem/)
assert.match(
  failureProblems(measure({ actions: ['Discard', 'Retry', 'Resolve'] })).join(),
  /Copy support report/
)

// The report: the shipping redaction keeps neither planted value; RED keeps them or crosses chats.
const reason = `Problem: Fixture recovery failed ${PLANTED.key} token=${PLANTED.token}`
const written = redact(JSON.stringify({ chat: 'chat-a', reason }, null, 2))
const scope = { chat: 'chat-a', others: ['chat-b'] }
assert.deepEqual(reportProblems(written, 0o600, scope), [])
assert.match(
  reportProblems(JSON.stringify({ chat: 'chat-a', reason }), 0o600, scope).join(),
  /planted secret.*redacted nothing/
)
assert.match(reportProblems(written, 0o644, scope).join(), /mode 644/)
assert.match(
  reportProblems(written.replace('chat-a', 'chat-b'), 0o600, scope).join(),
  /another chat.*another chat/
)
assert.match(reportProblems('not json [redacted]', 0o600, scope).join(), /not JSON/)
assert.deepEqual(reportProblems(null, null, scope), ['no readable support report'])

// RED `delay-busy`: the busy render precedes services.invoke, so the gate must
// already be armed when the pointer or key event enters the card.
assert.deepEqual([...CHAT_RECOVERY_RED_MODES], ['delay-busy'])
const shown = []
const services = { render: (state) => shown.push(state) }
const original = services.render
let armed = false
const gate = delayRenders(services, () => armed)
services.render('idle')
armed = true // before input; recoveryRequest publishes busy before it reaches invoke
services.render('busy')
services.render('still busy')
assert.deepEqual(shown, ['idle'], 'no busy state renders before the held reply')
armed = false
gate.flush()
assert.deepEqual(shown, ['idle', 'still busy'], 'the latest held render is published on release')
services.render('settled')
gate.flush()
assert.deepEqual(shown, ['idle', 'still busy', 'settled'])
gate.restore()
assert.equal(services.render, original)

if (process.platform !== 'darwin') {
  console.log('CHAT-RECOVERY-ACCEPTANCE PASS (rules); card locator SKIP — macOS AppKit required')
} else {
  const sources = [
    'ChatCommentRow',
    'ChatLandingCheck',
    'ChatLiveChange',
    'ChatIncident',
    'ChatAgentCard',
    'ChatUiModel',
    'ChatUi',
    'ChatScrollStyle',
    'ChatLatestButton',
    'ChatEnvironment',
    'ChatReveal',
    'ChatIsland',
    'IslandEditing',
    'ShadowIsland',
    'ChatActivity',
    'ChatActivityClock',
    'Cat',
    'ChatDivider',
    'ChatMarkdown',
    'ChatRichText',
    'ChatTextView',
    'ChatQuestion',
    'SnappedSlider',
    'ChatAttachments',
    'AttachmentThumbnail',
    'Composer',
    'ComposerProject',
    'ComposerVerification',
    'ComposerAttachments',
    'ComposerQueue',
    'ComposerBeam',
    'ComposerSending',
    'ScrollerDrag',
    'ChatRecoveryAcceptance',
    'Chat'
  ].map((name) => `src/native/${name}.swift`)
  const scratch = mkdtempSync(join(tmpdir(), 'trezi-chat-recovery-acceptance-'))
  try {
    const binary = swiftBuild(
      'chat-recovery-acceptance',
      ['test/fixtures/chat-recovery-acceptance/main.swift', ...sources],
      { out: join(scratch, 'chat-recovery-acceptance') }
    )
    const output = runFixture(binary, [], { timeout: 120_000 })
    const cases = Object.fromEntries(
      output
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .map((entry) => [entry.case, entry])
    )
    const all = JSON.stringify(cases)
    const { idle, question, problem } = cases
    const busyRetry = cases['busy-retry']
    const busyResolve = cases['busy-resolve']
    assert.ok(idle && busyRetry && busyResolve && problem && question, `every case ran: ${output}`)
    // The idle card: its three buttons in one row, in order, apart, where the user reads.
    assert.equal(idle.problem, null, `idle locator: ${all}`)
    assert.deepEqual(
      idle.buttons.map((b) => b.label),
      ['Discard', 'Retry', 'Resolve']
    )
    const frames = idle.buttons.map((b) => b.frame)
    for (let i = 1; i < frames.length; i++) {
      assert.ok(Math.abs(frames[i][1] - frames[0][1]) <= 2, `one row: ${all}`)
      assert.ok(frames[i][0] >= frames[i - 1][0] + frames[i - 1][2] - 0.5, `apart: ${all}`)
    }
    assert.deepEqual(idleProblems(idle), [], `idle card: ${all}`)
    // The acceptance's click and Space reach exactly the button they name.
    assert.deepEqual(idle.click, { found: true, emitted: ['landing-retry'] }, `click: ${all}`)
    // Held: a busy label, a spinner, every mutation disabled, and no click gets through.
    // SwiftUI drops a disabled button's key-view proxy, so the keyboard cannot reach it
    // and its frame is derived; the same card drawn enabled must put it there.
    assert.deepEqual(busyProblems(busyRetry, 'retry'), [], `busy Retry card: ${all}`)
    assert.deepEqual(busyProblems(busyResolve, 'resolve'), [], `busy Resolve card: ${all}`)
    assert.deepEqual(busyRetry.click, { found: true, emitted: [] }, `busy click: ${all}`)
    assert.deepEqual(busyRetry.discard, { found: true, emitted: [] }, `busy Discard: ${all}`)
    assert.deepEqual(busyRetry.resolve, { found: true, emitted: [] }, `busy Resolve: ${all}`)
    assert.deepEqual(busyRetry.key, { found: true, focusable: false }, `busy key: ${all}`)
    assert.deepEqual(busyResolve.click, { found: true, emitted: [] }, `busy Resolve: ${all}`)
    const busyProblem = cases['problem-busy']
    assert.deepEqual(busyProblems(busyProblem, 'retry'), [], `busy Problem card: ${all}`)
    assert.deepEqual(busyProblem.copy, { found: true, emitted: ['recovery-report'] }, all)
    assert.deepEqual(busyProblem.click, { found: true, emitted: [] }, `busy Problem: ${all}`)
    for (const name of ['busy-retry', 'busy-resolve', 'problem-busy']) {
      const derived = cases[name].buttons
      const drawn = cases[`${name}-drawn`].buttons
      assert.deepEqual(
        derived.map((b) => b.label),
        drawn.map((b) => b.label),
        `${name}: ${all}`
      )
      for (const [i, b] of derived.entries()) {
        assert.equal(
          b.frameSource,
          b.disabled ? 'derived from the last all-enabled row' : 'key-view proxy',
          `${name} ${b.label}: ${all}`
        )
        for (const [k, value] of b.frame.entries())
          assert.ok(
            Math.abs(value - drawn[i].frame[k]) <= 1.5,
            `${name}: ${b.label} derived at ${b.frame}, drawn at ${drawn[i].frame} (${all})`
          )
      }
    }
    // A Problem card: the copy glyph leads its row, the four actions follow it.
    assert.equal(problem.problem, null, `problem locator: ${all}`)
    assert.deepEqual(
      problem.buttons.map((b) => b.label),
      ['Discard', 'Retry', 'Resolve', 'Copy support report']
    )
    assert.equal(problem.rows[0].length, 5, `glyph and four actions: ${all}`)
    assert.deepEqual(problem.click, { found: true, emitted: ['landing-retry'] }, `Problem: ${all}`)
    // A question after the card: the locator refuses to guess.
    assert.match(String(question.problem), /question card follows/)
    assert.deepEqual(question.buttons, [])
    // The offscreen unit window is not the foreground key window. It can check the
    // focus and event construction, but only the opt-in foreground acceptance can
    // require SwiftUI to dispatch the posted Space to Resolve.
    assert.equal(idle.key.found, true, `key target: ${all}`)
    assert.equal(idle.key.focused, true, `key focus: ${all}`)
    if (idle.keyWindow && idle.keyboardNavigation)
      assert.deepEqual(idle.key.emitted, ['resolve'], `key dispatch: ${all}`)
    else assert.deepEqual(idle.key.emitted, [], `offscreen key dispatch: ${all}`)
    console.log('CHAT-RECOVERY-ACCEPTANCE PASS')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
