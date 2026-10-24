import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-312: following the latest row reads the end marker and settles. The fixture
// hosts the real NativeChat (its sticky-request overlay included) offscreen. The
// marker's position read above that overlay was always 0, so every follow ran out
// its attempts, each a lazy-stack relayout; while streaming that held the main
// thread at 100% CPU. `CHAT_SWIFT` swaps in another Chat.swift (a pre-fix copy).
if (process.platform !== 'darwin') {
  console.log('NATIVE-CHAT-BOTTOM-MARKER SKIP — macOS AppKit required')
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
  const scratch = mkdtempSync(join(tmpdir(), 'trezi-chat-bottom-marker-'))
  try {
    const binary = swiftBuild(
      'chat-bottom-marker',
      [
        'test/fixtures/chat-bottom-marker/main.swift',
        ...sources,
        process.env.CHAT_SWIFT || 'src/native/Chat.swift'
      ],
      { out: join(scratch, 'chat-bottom-marker') }
    )
    const { samples } = JSON.parse(runFixture(binary))
    const describe = samples
      .map(
        (entry) =>
          `${entry.phase}: bottom ${entry.bottom.toFixed(1)} of ${entry.reading.toFixed(1)}, ${entry.settleAttempts} attempts`
      )
      .join('; ')
    for (const entry of samples) {
      // Pinned to the end, the marker sits at the reading edge.
      assert.ok(
        entry.bottom > 0 && Math.abs(entry.bottom - entry.reading) <= 2,
        `${entry.phase}: end marker not measured at the reading edge (${describe})`
      )
      // One run is 20 attempts: reaching it means the settle never settled.
      assert.ok(entry.settleAttempts < 20, `${entry.phase}: follow did not settle (${describe})`)
    }
    console.log(`NATIVE-CHAT-BOTTOM-MARKER PASS — ${describe}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
