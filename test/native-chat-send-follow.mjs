import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-354: after Send the sent prompt or the streaming reply is in the reading
// area within 1 s and stays there while the turn runs, in a new, short and long
// chat, after a chat switch and restore, and when the previous turn still runs.
// Following never jumps back up. When cards after the reply fill the view, no
// message row is in view: every settle step realized, jumping between the first
// row and the end, and each settle's closing pin started the next, so the
// settle never ended. The fixture hosts the real NativeChat offscreen.
// `CHAT_SWIFT` swaps in another Chat.swift (a pre-fix copy, with the model's
// `latestRealizes`, `latestUnresolved`, `messageFramesFilter` and `sendRevision` hooks added).
if (process.platform !== 'darwin') {
  console.log('NATIVE-CHAT-SEND-FOLLOW SKIP — macOS AppKit required')
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
    'ScrollerDrag'
  ].map((name) => `src/native/${name}.swift`)
  // LKM-357: the user's requirement is rows in view within 1 s of Send, enforced as is locally.
  // The fixture times it from the app's own Send moment to the first frames the conversation
  // reports with a sent row in view, so the harness's push and 30 ms sampling are excluded. On CI
  // only, the limit is 2 s: on a Mac the rows show 0.04–0.09 s after Send, but a loaded GitHub
  // runner once read 1.04 s for the long chat (179b3cd3, same code passed on d9793a01 and bb1b04d8),
  // a main-thread stall more than ten times the local value. 2 s is about twice that worst reading.
  // A Send whose rows never show is -1 and fails either way, as does a settle that needs seconds.
  const limit = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true' ? 2 : 1
  const scratch = mkdtempSync(join(tmpdir(), 'trezi-chat-send-follow-'))
  try {
    const binary = swiftBuild(
      'chat-send-follow',
      [
        'test/fixtures/chat-send-follow/main.swift',
        ...sources,
        process.env.CHAT_SWIFT || 'src/native/Chat.swift'
      ],
      { out: join(scratch, 'chat-send-follow') }
    )
    // LKM-365: about 125 s alone, mostly fixed sampling windows; the default 180 s stop was a
    // flake of its own on a loaded runner. A hung case still stops here.
    const { cases, forced } = JSON.parse(runFixture(binary, [], { timeout: 300_000 }))
    const describeForced = forced
      .map(
        (entry) =>
          `${entry.case}${entry.streamed ? ' (streaming)' : ''}: settles ended after ${entry.endedAfter.toFixed(1)} s (${entry.realizes} realize scrolls, ${entry.settles} settles), then settling ${entry.settlingLate}/${entry.lateSamples}, ${entry.realizesLate} realize scrolls, a second Send realized after ${entry.realizedOnSend.toFixed(2)} s, up jump ${entry.upJump.toFixed(0)} pt (${entry.upJumpDuringSettles.toFixed(0)} pt during the settles), rows ${entry.shownAfterRelease ? 'back' : 'NOT back'}, ${entry.offsetFromEnd.toFixed(0)} pt from the end`
      )
      .join('; ')
    // LKM-365: the failing case's own timeline, in seconds after its Send, so a CI failure can be
    // read from the log alone. Settle ends as t:realize scrolls so far(unresolved in a row), realize
    // scrolls (first, last, count), and after the end each realize scroll as t:#n@offset and each
    // move back up as t:-pt (the first 20 of each).
    const timeline = (entry) => {
      const { settleEnds, realizeTimes, lateRealizes, lateMoves } = entry.timeline
      const list = (items, format) =>
        items.length
          ? `${items.slice(0, 20).map(format).join(' ')}${items.length > 20 ? ` …(+${items.length - 20})` : ''}`
          : 'none'
      const fixed = (value, digits = 2) => Number(value).toFixed(digits)
      return [
        `${entry.case} timeline: ended at ${fixed(entry.endedAfter)} s (the old 1.5 s quiet window ${entry.quietAt >= 0 ? `at ${fixed(entry.quietAt)} s` : 'never'})`,
        `settle ends ${list(settleEnds, ([t, n, u]) => `${fixed(t)}:${n}(${u})`)}`,
        `realize scrolls before the end ${realizeTimes.length ? `${fixed(realizeTimes[0])}…${fixed(realizeTimes.at(-1))} s (${realizeTimes.length} turns)` : 'none'}`,
        `realize scrolls after the end ${list(lateRealizes, ([t, n, offset]) => `${fixed(t)}:#${n}@${fixed(offset, 0)}`)}`,
        `moves up after the end ${list(lateMoves, ([t, pt]) => `${fixed(t)}:-${fixed(pt, 0)}pt`)}`
      ].join('; ')
    }
    const forcedFailure = (entry, what) =>
      `${entry.case}: ${what} (${timeline(entry)}) (all cases: ${describeForced})`
    const missing = (entry) => entry.missingTimes.filter((t) => t > limit).length
    const describe = cases
      .map(
        (entry) =>
          `${entry.case}: Send at ${entry.sentAt.toFixed(3)} s${entry.appSend ? '' : ' (NOT recorded by the app)'}, shown at ${entry.shownAt.toFixed(3)} s, after ${entry.shownAfter.toFixed(3)} s (harness sample ${entry.sampledAfter.toFixed(2)} s), threshold ${limit} s, missing ${missing(entry)}/${entry.samples}, up jump ${entry.upJump.toFixed(0)} pt, settling after ${entry.settlingAfterTurn}/30`
      )
      .join('; ')
    for (const entry of cases) {
      if (!entry.cards) {
        // Timed from the app's own Send moment (see `limit`), not from the harness.
        assert.ok(entry.appSend, `${entry.case}: the app recorded no Send (${describe})`)
        assert.ok(
          entry.shownAfter >= 0 && entry.shownAfter <= limit,
          `${entry.case}: sent rows not in view within ${limit} s of the Send (${describe})`
        )
        assert.equal(
          missing(entry),
          0,
          `${entry.case}: sent rows left the view while streaming (${describe})`
        )
      }
      // A following view only moves down; the realize jump went to the first row.
      assert.ok(entry.upJump <= 40, `${entry.case}: the view jumped back up (${describe})`)
      // A settle that never ends steps every frame; one may still close a few frames in.
      assert.ok(
        entry.settlingAfterTurn <= 3,
        `${entry.case}: the settle still runs after the turn (${describe})`
      )
    }
    // The reporter's state (blank chat, scrollbar between offsets 0 and 18): no message row is
    // measured in view, with no cards, questions or footer. The frames stay missing.
    for (const entry of forced) {
      // The bounded settles (each about 1.3 s, jumping through the first row) must end, then stay
      // ended and leave the clip alone instead of restarting from their own closing pin. Ended
      // (LKM-365) is the app's signal that the bound is spent (more unresolved settles in a row
      // than ChatLatestSettle.unresolvedRestarts), not a quiet time: on the loaded 1-shard main CI
      // a 1.5 s pause mid-bound read as ended. Unended (LKM-359) means more than 240 realize
      // scrolls ran; the bound is in steps, which a loaded runner only makes slower, and the
      // fixture's 90 s cap only stops a hung run.
      assert.ok(entry.endedAfter >= 0, forcedFailure(entry, 'the settle never ended'))
      // Three unresolved settles realize, each at most 4 runs of 20 steps (ChatLatestSettle).
      assert.ok(entry.realizes <= 240, forcedFailure(entry, 'the realize scrolls are not bounded'))
      // Streaming: every chunk is a content request, which keeps the unresolved count. Past the
      // limit it only scrolls to the latest, so the jumps through the first row stop while the
      // chunks keep arriving; a count reset by each chunk jumps for the whole turn. The fixture
      // samples at least 30 (20 streaming) times and 1.5 s (3 s) after the end.
      assert.ok(
        entry.lateSamples >= (entry.streamed ? 20 : 30) && entry.settlingLate <= 3,
        forcedFailure(entry, 'the settle restarted after it ended')
      )
      // No realize scroll once ended: a settled reading after realize steps must not restart them.
      assert.equal(
        entry.realizesLate,
        0,
        forcedFailure(entry, 'the realize scrolls restarted after they ended')
      )
      // A new Send is not a streamed chunk: with the bound spent it must realize again, before its
      // own settles spend the bound again.
      assert.ok(
        entry.realizedOnSend >= 0,
        forcedFailure(entry, 'a Send after the bound was spent got no realize scroll')
      )
      assert.ok(
        entry.upJump <= 40,
        forcedFailure(entry, 'the view kept jumping with no row in view')
      )
      // Frames measured again: the sent rows are in the reading area, the clip at the end.
      assert.ok(entry.shownAfterRelease, forcedFailure(entry, 'rows did not come back'))
      assert.ok(
        entry.offsetFromEnd <= 2,
        forcedFailure(entry, 'the view did not return to the end')
      )
    }
    console.log(`NATIVE-CHAT-SEND-FOLLOW PASS — ${describe}; no row in view: ${describeForced}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
