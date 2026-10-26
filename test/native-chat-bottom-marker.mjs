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
          `${entry.phase}: bottom ${entry.bottom.toFixed(1)} of ${entry.reading.toFixed(1)}, ${entry.settles} settles (last ${entry.settled ? 'settled' : 'unresolved'}), ${entry.settleAttempts} attempts`
      )
      .join('; ')
    // Every failed check names itself and prints actual vs expected, then all samples.
    const check = (entry, name, pass, actual, expected) =>
      assert.ok(
        pass,
        `${entry.phase}: ${name}: actual ${JSON.stringify(actual)}, expected ${expected}\nall samples: ${describe}`
      )
    assert.deepEqual(
      samples.map((entry) => entry.phase),
      ['load', 'streamed', 'completed'],
      `sampled phases: actual ${JSON.stringify(samples.map((entry) => entry.phase))}`
    )
    for (const entry of samples) {
      // The follow ended: a settle ran for this phase, then nothing settled or pinned for
      // 30 run-loop turns. A pre-fix chat ran out its attempts and pinned again, endlessly.
      check(
        entry,
        'settle ended',
        entry.ended && !entry.settling,
        entry,
        'ended and not settling within 60 s'
      )
      check(entry, 'settles for the phase', entry.settles >= 1, entry.settles, '>= 1')
      // Its last reading was settled: it did not run out its attempts unresolved.
      check(entry, 'last settle settled', entry.settled === true, entry.settled, 'true')
      // Pinned to the end, the marker sits at the reading edge.
      check(entry, 'end marker measured', entry.bottom > 0, entry.bottom, '> 0')
      check(
        entry,
        'end marker at the reading edge',
        Math.abs(entry.bottom - entry.reading) <= 2,
        entry.bottom,
        `${entry.reading} ± 2`
      )
      // One settle is at most 4 runs of 20 attempts (ChatLatestSettle.follow).
      check(entry, 'settle attempts', entry.settleAttempts < 80, entry.settleAttempts, '< 80')
    }
    console.log(`NATIVE-CHAT-BOTTOM-MARKER PASS — ${describe}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
