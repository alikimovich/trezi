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
// `CHAT_SWIFT` swaps in another Chat.swift (a pre-fix copy).
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
    const { cases } = JSON.parse(runFixture(binary))
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
    console.log(`NATIVE-CHAT-SEND-FOLLOW PASS — ${describe}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
