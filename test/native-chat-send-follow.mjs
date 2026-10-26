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
// `latestRealizes` and `messageFramesFilter` hooks added).
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
    const { cases, forced } = JSON.parse(runFixture(binary))
    const describeForced = forced
      .map(
        (entry) =>
          `${entry.case}${entry.streamed ? ' (streaming)' : ''}: settles ended after ${entry.endedAfter.toFixed(1)} s (${entry.realizes} realize scrolls), then settling ${entry.settlingLate}/${entry.lateSamples}, ${entry.realizesLate} realize scrolls, a second Send realized after ${entry.realizedOnSend.toFixed(2)} s, up jump ${entry.upJump.toFixed(0)} pt (${entry.upJumpDuringSettles.toFixed(0)} pt during the settles), rows ${entry.shownAfterRelease ? 'back' : 'NOT back'}, ${entry.offsetFromEnd.toFixed(0)} pt from the end`
      )
      .join('; ')
    const describe = cases
      .map(
        (entry) =>
          `${entry.case}: shown after ${entry.shownAfter.toFixed(2)} s, missing ${entry.missingAfter1s}/${entry.samples}, up jump ${entry.upJump.toFixed(0)} pt, settling after ${entry.settlingAfterTurn}/30`
      )
      .join('; ')
    for (const entry of cases) {
      if (!entry.cards) {
        assert.ok(
          entry.shownAfter >= 0 && entry.shownAfter <= 1,
          `${entry.case}: sent rows not in view within 1 s (${describe})`
        )
        assert.equal(
          entry.missingAfter1s,
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
      // The bounded settles (each about 1.3 s, jumping through the first row) must end within the
      // fixture's 20 s cap, then stay ended and leave the clip alone instead of restarting from
      // their own closing pin.
      assert.ok(entry.endedAfter >= 0, `${entry.case}: the settle never ended (${describeForced})`)
      // Three unresolved settles realize, each at most 4 runs of 20 steps (ChatLatestSettle).
      assert.ok(
        entry.realizes <= 240,
        `${entry.case}: the realize scrolls are not bounded (${describeForced})`
      )
      // Streaming: every chunk is a content request, which keeps the unresolved count. Past the
      // limit it only scrolls to the latest, so the jumps through the first row stop within the
      // cap while the chunks keep arriving; a count reset by each chunk jumps for the whole turn.
      assert.ok(
        entry.lateSamples > (entry.streamed ? 10 : 20) && entry.settlingLate <= 3,
        `${entry.case}: the settle restarted after it ended (${describeForced})`
      )
      // No realize scroll once ended: a settled reading after realize steps must not restart them.
      assert.equal(
        entry.realizesLate,
        0,
        `${entry.case}: the realize scrolls restarted after they ended (${describeForced})`
      )
      // A new Send is not a streamed chunk: with the bound spent it must realize again.
      assert.ok(
        entry.realizedOnSend >= 0,
        `${entry.case}: a Send after the bound was spent got no realize scroll within 1 s (${describeForced})`
      )
      assert.ok(
        entry.upJump <= 40,
        `${entry.case}: the view kept jumping with no row in view (${describeForced})`
      )
      // Frames measured again: the sent rows are in the reading area, the clip at the end.
      assert.ok(
        entry.shownAfterRelease,
        `${entry.case}: rows did not come back (${describeForced})`
      )
      assert.ok(
        entry.offsetFromEnd <= 2,
        `${entry.case}: the view did not return to the end (${describeForced})`
      )
    }
    console.log(`NATIVE-CHAT-SEND-FOLLOW PASS — ${describe}; no row in view: ${describeForced}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
