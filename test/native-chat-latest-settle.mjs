import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// LKM-139: following the latest row never leaves the transcript blank. The
// fixture hosts the conversation's lazy stack, AppKit pin and ChatLatestSettle
// offscreen; `--no-settle` is the pre-fix negative control.
if (process.platform !== 'darwin') {
  console.log('NATIVE-CHAT-LATEST-SETTLE SKIP — macOS AppKit required')
} else {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const scratch = mkdtempSync(join(tmpdir(), 'trezi-chat-latest-settle-'))
  const cache = join(root, 'out/native/module-cache')
  mkdirSync(cache, { recursive: true })
  const run = (args) => {
    const result = spawnSync(args[0], args.slice(1), {
      cwd: root,
      encoding: 'utf8',
      timeout: 180_000
    })
    assert.equal(
      result.status,
      0,
      `${args[0]}: ${result.error || result.signal || ''}\n${result.stdout}\n${result.stderr}`
    )
    return result.stdout
  }
  const describe = (summary) =>
    summary.samples
      .map(
        (entry) =>
          `${entry.scenario} ${entry.phase}: ${entry.visibleRows} rows, ${entry.drawnLayers} layers${entry.latestVisible ? ', latest' : ''}`
      )
      .join('; ')
  try {
    const binary = join(scratch, 'chat-latest-settle')
    run([
      'xcrun',
      'swiftc',
      '-module-cache-path',
      cache,
      'test/fixtures/chat-latest-settle/main.swift',
      ...['ChatScrollStyle', 'ChatEnvironment'].map((name) => `src/native/${name}.swift`),
      '-o',
      binary
    ])
    // LKM-149: never settled while the latest row is below the reading edge (it
    // is re-measured after a relayout), an unresolved pin escalates to a
    // relayout, and history footers are 28 pt.
    const cases = JSON.parse(run([binary, '--cases']))
    assert.equal(cases.atEdge, 'settled')
    assert.equal(cases.markerBelow, 'bottom')
    assert.equal(
      cases.latestBelowEdge,
      'relayout',
      'marker at the edge but the latest row below it must not settle'
    )
    assert.equal(cases.latestUnrealized, 'relayout', 'an unmeasured latest row must not settle')
    assert.equal(cases.noRowInView, 'realize:latest')
    assert.deepEqual(cases.escalations, [
      'bottom',
      'bottom',
      'bottom',
      'relayout',
      'bottom',
      'bottom',
      'relayout'
    ])
    assert.equal(cases.settledEscalates, true, 'settled never escalates')
    assert.deepEqual(
      cases.footer,
      { history: 28, latestDone: 44, running: 44, runningNotLast: 44 },
      'history footers are one 28 pt row; the running turn and the latest response keep the counter line'
    )
    const before = JSON.parse(run([binary, '--no-settle']))
    assert.ok(
      before.blanks > 0,
      `negative control: the AppKit pin alone should leave the transcript blank (${describe(before)})`
    )
    const after = JSON.parse(run([binary]))
    assert.equal(after.blanks, 0, `transcript blank while following (${describe(after)})`)
    assert.equal(after.overs, 0, `offset past the end (${describe(after)})`)
    for (const entry of after.samples) {
      assert.ok(
        entry.latestVisible,
        `${entry.scenario} ${entry.phase}: latest row not in view (${describe(after)})`
      )
      assert.ok(
        entry.latestAboveEdge,
        `${entry.scenario} ${entry.phase}: latest row ends below the reading edge (${describe(after)})`
      )
      // 4 runs x 20 attempts: reaching it means the settle gave up instead of settling.
      assert.ok(
        entry.settleAttempts < 80,
        `${entry.scenario} ${entry.phase}: settle exhausted its attempts (${entry.settleAttempts})`
      )
    }
    const worst = Math.max(...after.samples.map((entry) => entry.offset - entry.maxOffset))
    console.log(
      `NATIVE-CHAT-LATEST-SETTLE PASS — without the settle ${before.blanks}/${before.samples.length} samples blank; with it ${after.samples.length} samples show rows and the latest row after load, send, mid-stream and streamed (offset - maxOffset ≤ ${worst.toFixed(1)}pt)`
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
