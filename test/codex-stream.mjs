/**
 * Codex item bookkeeping — the bug here was user-visible and ugly: assistant
 * replies arrived with their opening cut off mid-word ("ve reliable visibility…",
 * "ing else?").
 *
 * Cause: Codex streams whole items and trezi emits the not-yet-sent SUFFIX, but
 * the CLI numbers items PER TURN (`item_0`, `item_1`, … restarting each turn)
 * while the tracker was kept for the whole SESSION. Turn 2's `item_0` therefore
 * inherited turn 1's length and had exactly that many characters sliced off the
 * front. Tool steps had the mirror bug — an id already marked "surfaced" was
 * dropped, so later turns silently lost steps.
 *
 * Run with: bun run test:codex-stream
 */
import { codexItemWarning, createItemTracker } from '../src/main/backends/codex-stream.ts'

let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}

try {
  const advisory =
    'Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter.'
  ok(codexItemWarning(advisory) === null, 'routine skill budget advisory stays out of chat')
  ok(
    codexItemWarning('  ' + advisory + '\n') === null,
    'advisory matching tolerates surrounding whitespace'
  )
  const warning = 'Could not load a skill: ' + 'details '.repeat(40) + '\nCheck its SKILL.md.'
  ok(
    codexItemWarning(warning) === `⚠ ${warning}`,
    'other warnings preserve their complete multiline detail'
  )
  ok(
    codexItemWarning('Skills failed to load.') === '⚠ Skills failed to load.',
    'real skill failures remain visible'
  )
  ok(codexItemWarning('') === null, 'empty warnings do not create activity rows')

  // --- within one turn: readings stream as suffixes -----------------------
  const t = createItemTracker()
  ok(t.delta('item_0', 'Hey') === 'Hey', 'first reading is emitted whole')
  ok(t.delta('item_0', 'Hey there') === ' there', 'a longer reading emits only the new tail')
  ok(t.delta('item_0', 'Hey there') === '', 'an unchanged reading emits nothing')
  ok(t.delta('item_0', 'Hey') === '', 'a SHORTER reading emits nothing (never claw back)')
  ok(t.delta('item_1', 'Other') === 'Other', 'a different id starts from zero')
  ok(t.delta('x', undefined) === '', 'missing text is not an error')

  // --- across turns: THE BUG ----------------------------------------------
  // Turn 1's reply is 82 chars and its item is `item_0`. Turn 2 reuses `item_0`.
  const first = "Hey! I'm ready to help with your Trezi project. What would you like to work on?"
  const turn1 = createItemTracker()
  turn1.delta('item_0', first)

  // Without the reset, this is what the user saw.
  const second = "I don't have reliable visibility into my exact underlying model identifier."
  ok(
    turn1.delta('item_0', second) === '',
    'sanity: an unreset tracker mangles turn 2 (this is the bug being prevented)'
  )

  turn1.reset()
  ok(
    turn1.delta('item_0', second) === second,
    'after reset, turn 2 emits its message IN FULL — no missing opening'
  )

  // A turn-2 message that happens to be LONGER than turn 1's is the case that
  // made this so easy to miss: it still rendered, just silently beheaded.
  const t2 = createItemTracker()
  t2.delta('item_0', 'x'.repeat(82))
  t2.reset()
  const long = `${'y'.repeat(200)}`
  ok(t2.delta('item_0', long) === long, 'a longer turn-2 message is not silently beheaded')

  // --- steps: `first` is per-turn too --------------------------------------
  const s = createItemTracker()
  ok(s.first('item_1') === true, 'a step is surfaced the first time')
  ok(s.first('item_1') === false, 'and only once within a turn')
  s.reset()
  ok(s.first('item_1') === true, 'but the same id in the NEXT turn is a new step')

  // Trackers are independent — one turn resetting must not disturb another.
  const a = createItemTracker()
  const b = createItemTracker()
  a.delta('item_0', 'aaa')
  ok(b.delta('item_0', 'bbb') === 'bbb', 'separate trackers share no state')

  if (failed === 0) {
    console.log('CODEX-STREAM OK — suffix streaming within a turn, clean slate across turns')
  } else {
    process.exitCode = 1
  }
} catch (err) {
  console.error('CODEX-STREAM FAILED:', err?.stack ?? err?.message ?? err)
  process.exitCode = 1
}
