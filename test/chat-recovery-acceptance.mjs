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
import { NativeChatController } from '../src/native/chat-controller.ts'
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
  frame: [x, 200, 160, 22]
})
// LKM-590: the settled card offers one primary recovery; the rest is in its More menu.
const measure = (over = {}) => ({
  present: true,
  title: 'Problem',
  detail: 'Problem: The changes are still held after the checks and reconciliation.',
  busy: false,
  actions: ['Combine with project edits'],
  disabled: [false],
  menu: ['Copy support report', 'Try applying again', 'Discard held changes…'],
  buttons: [button('Combine with project edits', 'resolve', false, 240)],
  problem: null,
  spinners: [],
  reading,
  cards: ['conflict'],
  ...over
})
const busy = (kind) =>
  measure({
    title: kind === 'retry' ? 'Trying to apply again…' : 'Combining with project edits…',
    detail: 'Trezi is working on the held changes. Nothing is needed from you yet.',
    busy: true,
    actions: [],
    disabled: [],
    menu: [],
    buttons: [],
    spinners: [[80, 300, 16, 16]]
  })

// GREEN: the shipping card while each request is held, and after it.
assert.deepEqual(busyProblems(busy('retry'), 'retry'), [])
assert.deepEqual(busyProblems(busy('resolve'), 'resolve'), [])
assert.deepEqual(idleProblems(measure()), [])
assert.deepEqual(failureProblems(measure()), [])
assert.deepEqual(
  stillHeldProblems(
    measure({ title: 'This turn’s changes didn’t land', detail: 'The changes are still held. x' })
  ),
  []
)
// RED: what a delayed or missing busy state looks like at the held boundary.
assert.match(busyProblems(measure(), 'retry').join('; '), /status.*not busy.*spinner.*drawn/)
assert.match(busyProblems(busy('retry'), 'resolve').join('; '), /Combining with project edits…/)
// RED: the old disabled cluster, or Discard offered, while Trezi works.
const cluster = busy('retry')
cluster.actions = ['Discard', 'Retry', 'Resolve']
cluster.buttons = [button('Discard', 'discard', true, 120)]
assert.match(busyProblems(cluster, 'retry').join(), /recovery actions are drawn/)
assert.match(
  busyProblems({ ...busy('retry'), menu: ['Discard held changes…'] }, 'retry').join(),
  /Discard is offered/
)
// scripts/chat-recovery-acceptance.mjs meets RED only on this failure.
assert.equal(BUSY_MARKER, 'busy state before the reply')
assert.match(busyProblems(measure({ present: false }), 'retry').join(), /not shown/)
assert.match(busyProblems(measure({ problem: 'no row' }), 'retry').join(), /not found: no row/)
const outside = measure()
outside.buttons[0].frame = [430, 200, 60, 22]
assert.match(idleProblems(outside).join(), /Combine with project edits is outside the reading area/)
// RED: a settled card that still spins, offers several peers, hides Discard, or adds an error card.
assert.match(
  idleProblems(busy('retry')).join('; '),
  /still busy.*working title.*spinner.*0 actions/
)
assert.match(
  idleProblems(measure({ actions: ['Discard', 'Retry', 'Resolve'] })).join(),
  /3 actions drawn/
)
assert.match(idleProblems(measure({ menu: [] })).join(), /Discard is not in More/)
assert.match(idleProblems(measure({ cards: ['conflict', 'error'] })).join(), /error card/)
assert.match(
  stillHeldProblems(measure({ detail: 'The changes are still held.\nfixture.ts' })).join(),
  /not one line/
)
assert.match(stillHeldProblems(measure({ detail: 'Problem: x' })).join(), /still held/)
assert.match(failureProblems(measure({ title: 'Held' })).join(), /Problem/)
assert.match(
  failureProblems(measure({ menu: ['Discard held changes…'] })).join(),
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

// LKM-458: the cards the real chat controller draws while a recovery request is held, as
// the acceptance meets them. The parked card states its Problem with a written report and
// a copy glyph; the request clears both (chat-actions.ts `recoveryRequest`), so the busy
// card drops the trailing Copy support report and the glyph. The a2c03fbb locator matched
// the whole action list and refused this card at the first held Retry.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const renders = []
const answers = {}
const controller = new NativeChatController({
  invoke: async (channel) => {
    if (channel === 'agent:workspace-snapshot')
      return {
        projects: [
          {
            root: '/fixture/project',
            chats: [
              {
                sessionKey: 'a',
                record: { transcript: [] },
                isRunning: false,
                options: { provider: 'claude' }
              }
            ]
          }
        ]
      }
    if (channel === 'providers:choices') return []
    return answers[channel] ?? { ok: true }
  },
  render: (state) => renders.push(structuredClone(state)),
  effect: () => {}
})
await controller.command({
  type: 'context',
  context: {
    chat: 'a',
    root: '/fixture/project',
    selection: null,
    turn: {},
    setup: { needed: false, dismissed: false, status: null },
    tokens: { needed: false, dismissed: false },
    notes: [],
    spawns: []
  }
})
const conflictCard = () => renders.at(-1).cards.find((c) => c.id === 'conflict')
const park = async () => {
  controller.event({
    projectKey: 'a',
    type: 'isolation',
    state: 'parked',
    files: ['src/recovery-fixture.ts']
  })
  for (
    let i = 0;
    i < 200 && !conflictCard()?.menu?.some((a) => a.action === 'recovery-report');
    i++
  )
    await tick()
  return conflictCard()
}
const heldCard = async (action) => {
  const channel = action === 'resolve' ? 'agent:resolve-conflict' : 'agent:retry-landing'
  let release
  answers[channel] = new Promise((resolve) => {
    release = resolve
  })
  const pending = controller.action({ chat: 'a', action, id: 'conflict' })
  const card = conflictCard()
  release({ ok: true, state: 'parked', conflicted: [], prompt: null })
  await pending
  delete answers[channel]
  return card
}
const parkedCard = await park()
const busyRetry = await heldCard('landing-retry')
await park()
const busyResolve = await heldCard('resolve')
// LKM-590: the parked card offers one recovery and keeps the rest in More; while a request
// is held the card shows progress and no row at all (no disabled cluster to press).
assert.deepEqual(
  parkedCard.actions.map((a) => [a.action, a.role]),
  [['resolve', 'primary']]
)
assert.deepEqual(
  parkedCard.menu.map((a) => a.action),
  ['recovery-report', 'landing-retry', 'discard-ask'],
  'the parked card offers its report'
)
assert.ok(parkedCard.fullDetail, 'the parked card copies its full detail (from More)')
for (const [card, title] of [
  [busyRetry, 'Trying to apply again…'],
  [busyResolve, 'Combining with project edits…']
]) {
  assert.equal(card.busy, true)
  assert.equal(card.title, title)
  assert.deepEqual(card.actions, [])
  assert.equal(card.menu, undefined)
  assert.equal(card.fullDetail, undefined)
}
const realCards = JSON.stringify({ parked: parkedCard, busyRetry, busyResolve })

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
    'ChatTextReply',
    'ChatQuotes',
    'ChatQuestion',
    'SnappedSlider',
    'ChatAttachments',
    'AttachmentThumbnail',
    'Composer',
    'ComposerProject',
    'ComposerVerification',
    'ComposerAttachments',
    'ComposerQuotes',
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
    const output = runFixture(binary, [realCards], { timeout: 120_000 })
    const cases = Object.fromEntries(
      output
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .map((entry) => [entry.case, entry])
    )
    const all = JSON.stringify(cases)
    const { idle, failed, question, problem } = cases
    const busyRetry = cases['busy-retry']
    const busyResolve = cases['busy-resolve']
    assert.ok(
      idle && failed && busyRetry && busyResolve && problem && question,
      `every case ran: ${output}`
    )
    // The idle card: its one primary button, where the user reads, then the More menu.
    assert.equal(idle.problem, null, `idle locator: ${all}`)
    assert.deepEqual(
      idle.buttons.map((b) => b.label),
      ['Combine with project edits']
    )
    assert.deepEqual(idleProblems(idle), [], `idle card: ${all}`)
    // The full label is drawn, never truncated (the screenshot's "Resol…"): the button is
    // at least as wide as its text.
    assert.ok(idle.buttons[0].frame[2] >= 150, `full primary label: ${all}`)
    // More is one pop-up button in the same row, after the primary, inside the reading area.
    const [primary] = idle.buttons.map((b) => b.frame)
    assert.equal(idle.more.length, 1, `one More menu: ${all}`)
    const [more] = idle.more
    assert.ok(Math.abs(more[1] + more[3] / 2 - (primary[1] + primary[3] / 2)) <= 3, `row: ${all}`)
    assert.ok(more[0] >= primary[0] + primary[2] - 0.5, `More after the primary: ${all}`)
    assert.ok(more[0] + more[2] <= idle.reading[0] + idle.reading[2] + 0.5, `inside: ${all}`)
    assert.deepEqual(busyRetry.more, [], `no More while Trezi works: ${all}`)
    // The acceptance's click and Space reach exactly the button they name.
    assert.deepEqual(idle.click, { found: true, emitted: ['resolve'] }, `click: ${all}`)
    assert.deepEqual(failed.click, { found: true, emitted: ['landing-retry'] }, `failed: ${all}`)
    assert.deepEqual(idleProblems(failed), [], `failed card: ${all}`)
    // Held: a working title, a spinner and no recovery row.
    assert.deepEqual(busyProblems(busyRetry, 'retry'), [], `busy Retry card: ${all}`)
    assert.deepEqual(busyProblems(busyResolve, 'resolve'), [], `busy Resolve card: ${all}`)
    assert.deepEqual(busyRetry.buttons, [])
    // The real controller's parked and held cards, short and scrolled to the pinned end.
    for (const name of ['real-parked', 'real-parked-tall'])
      assert.deepEqual(idleProblems(cases[name]), [], `${name}: ${all}`)
    assert.deepEqual(busyProblems(cases['real-retry'], 'retry'), [], `real retry: ${all}`)
    assert.deepEqual(busyProblems(cases['real-resolve'], 'resolve'), [], `real resolve: ${all}`)
    assert.notEqual(cases['real-parked-tall'].end, cases['real-parked'].end, `tall end: ${all}`)
    // A Problem card (LKM-597): one copy place. The card has a More menu, so its full detail
    // copies from there ("Copy details", beside "Copy support report") and its row draws
    // no copy glyph: only the primary and More.
    assert.equal(problem.problem, null, `problem locator: ${all}`)
    assert.equal(problem.copyGlyph, false, `no standalone copy glyph beside More: ${all}`)
    assert.deepEqual(problem.rows[0]?.length, 1, `one proxy (the primary) in the row: ${all}`)
    assert.equal(problem.more.length, 1, `one More menu: ${all}`)
    assert.deepEqual(
      problem.menu.filter((label) => label.startsWith('Copy')),
      ['Copy details', 'Copy support report'],
      `named copies, in More only: ${all}`
    )
    // A card with a collapsed detail and no More menu keeps its single copy glyph.
    const copyOnly = cases['copy-only']
    assert.equal(copyOnly?.copyGlyph, true, `copy-only glyph: ${all}`)
    assert.equal(copyOnly.problem, null, `copy-only locator: ${all}`)
    assert.deepEqual(copyOnly.rows[0]?.length, 1, `copy-only row: ${all}`)
    assert.deepEqual(copyOnly.more, [], `copy-only has no More: ${all}`)
    assert.deepEqual(
      problem.buttons.map((b) => b.label),
      ['Combine with project edits']
    )
    assert.deepEqual(failureProblems(problem), [], `problem card: ${all}`)
    assert.deepEqual(problem.click, { found: true, emitted: ['resolve'] }, `Problem: ${all}`)
    // A question after the card: the locator refuses to guess.
    assert.match(String(question.problem), /question card follows/)
    assert.deepEqual(question.buttons, [])
    // The offscreen unit window is not the foreground key window. It can check the
    // focus and event construction, but only the opt-in foreground acceptance can
    // require SwiftUI to dispatch the posted Space to the primary action.
    assert.equal(idle.key.found, true, `key target: ${all}`)
    assert.equal(idle.key.focused, true, `key focus: ${all}`)
    if (idle.keyWindow && idle.keyboardNavigation) {
      assert.deepEqual(idle.key.emitted, ['resolve'], `key dispatch: ${all}`)
    } else {
      assert.ok(
        idle.key.emitted.length === 0 ||
          (idle.key.emitted.length === 1 && idle.key.emitted[0] === 'resolve'),
        `offscreen key dispatch: ${all}`
      )
    }
    console.log('CHAT-RECOVERY-ACCEPTANCE PASS')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
