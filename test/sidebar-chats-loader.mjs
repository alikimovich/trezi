// LKM-618: the sidebar's one chat-list loading line, hosted for real (`SidebarChatsLoaderCell`):
// the existing pixel cat runs the row's width and back, facing its way, entirely in Core
// Animation; Reduce Motion holds it still; hidden or discarded, nothing is left running.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeCatAssets } from '../scripts/native-cat-assets.mjs'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

if (process.platform !== 'darwin') {
  console.log('SIDEBAR-CHATS-LOADER SKIP — macOS AppKit required for the row')
} else {
  const binary = swiftBuild('sidebar-chats-loader', [
    'test/fixtures/sidebar-chats-loader/main.swift',
    'src/native/SidebarChatsLoader.swift',
    'src/native/Cat.swift',
    'src/native/SidebarTitleShimmer.swift',
    'src/native/SidebarChats.swift',
    'src/native/SidebarChatsAccessibility.swift',
    'src/native/SidebarMarquee.swift',
    'src/native/SidebarIcon.swift',
    'src/native/ProjectCell.swift',
    'src/native/SourceList.swift'
  ])
  const dir = mkdtempSync(join(tmpdir(), 'trezi-sidebar-loader-'))
  let report
  try {
    const assets = join(dir, 'cat.json')
    writeFileSync(assets, JSON.stringify(nativeCatAssets(process.cwd())))
    // TREZI_LOADER_STRIP=<png>: also write a strip of the frames the cat showed, for a look.
    const strip = process.env.TREZI_LOADER_STRIP
    report = JSON.parse(runFixture(binary, strip ? [assets, strip] : [assets]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const line = 'chats-loading:p'
  assert.deepEqual(report.nested, ['chat:a', line], 'one line after the known chats')
  assert.deepEqual(
    report.nestedHistory,
    ['chat:a', line, 'history-toggle:p', 'history:h'],
    'before History'
  )
  assert.deepEqual(report.plain, [], 'no line without chatsLoading')
  assert.deepEqual(
    report.interaction,
    { selectable: false, menu: [], archive: false, target: 'chat:a' },
    'not selectable, no menu or Archive, and the selection stays on the real chat'
  )

  const { wide, resized, cramped, reduced, restored, hidden, unhidden, detached } = report
  assert.equal(wide.mode, 'run')
  assert.deepEqual([...wide.animations].sort(), ['facing', 'run', 'travel'])
  assert.equal(wide.catSize, 16, 'small: the size of a sidebar icon')
  assert.equal(wide.travel, wide.trackWidth - wide.catSize, 'the whole row, one cat wide short')
  assert.ok(wide.trackX >= 0 && wide.trackX + wide.trackWidth <= wide.cellWidth, 'inside its row')
  assert.equal(wide.to - wide.from, wide.travel, 'runs the full track and back')
  assert.ok(wide.repeats && wide.period > 0)
  assert.deepEqual(wide.facing.map(Math.abs), [1, 1], 'plain or mirrored, never squashed')
  assert.equal(wide.facing[0], -wide.facing[1], 'one facing per leg')
  assert.deepEqual(wide.facingKeys, [0, 0.5, 1], 'it turns at each end')
  assert.equal(wide.frames, 2, 'the two run frames of the existing cat')
  assert.ok(wide.painted)
  assert.deepEqual(
    [wide.label, wide.role, wide.element, wide.childElements],
    ['Loading chats', 'AXStaticText', true, false],
    'one static VoiceOver status'
  )
  assert.equal(resized.travel, resized.trackWidth - 16, 'a narrower sidebar shortens the run')
  assert.ok(resized.travel < wide.travel && resized.period < wide.period, 'at the same speed')
  assert.equal(cramped.mode, 'still', 'no room to run: still, never clipped into controls')
  assert.deepEqual(cramped.animations, [])
  // The shared clock: each animation begins on a whole cycle of the layer clock, so its phase is
  // exactly time mod period however late its commit landed, and a rebuilt row is on the same phase.
  assert.ok(wide.begin > 0 && wide.begin === wide.facingBegin, 'travel and facing share one begin')
  assert.ok(
    Math.abs(wide.begin / wide.period - Math.round(wide.begin / wide.period)) < 1e-6,
    'begins on a whole cycle of the clock'
  )
  const [firstPhase, rebuiltPhase, clockPhase] = report.rebuiltPhases
  assert.ok(Math.abs(firstPhase - rebuiltPhase) < 1e-6, 'a rebuilt row keeps the phase')
  assert.ok(Math.abs(firstPhase - clockPhase) < 1e-6, 'the phase is the shared clock')
  assert.deepEqual([reduced.mode, reduced.animations, reduced.painted], ['still', [], true])
  assert.equal(reduced.label, 'Loading chats', 'Reduce Motion keeps the status')
  assert.equal(restored.mode, 'run')
  assert.deepEqual([hidden.mode, hidden.animations], ['none', []], 'hidden: nothing runs')
  assert.equal(unhidden.mode, 'run')
  assert.deepEqual([detached.mode, detached.animations], ['none', []], 'unmounted: stopped')

  // LKM-705: the cat runs forwards. Judged from what it shows, not from the sign it is given.
  // The art itself, read straight from the SVGs: the head sits right of the body (the tail trails
  // at the lower left), so the bare run art faces right.
  const art = nativeCatAssets(process.cwd())
  for (const [index, frame] of art.run.entries()) {
    const sums = [0, 0, 0, 0]
    for (const [x, y, w, h] of frame.pixels) {
      for (let row = y; row < y + h; row++) {
        const k = row < 16 ? 0 : 2
        sums[k] += w * (x + w / 2)
        sums[k + 1] += w
      }
    }
    assert.ok(
      sums[0] / sums[1] - sums[2] / sums[3] > 1,
      `run frame ${index + 1}: the head leads to the right`
    )
  }
  const legs = report.legs
  assert.ok(
    legs.artLead.length === 2 && legs.artLead.every((value) => value > 0.5),
    'the fixture measure agrees'
  )
  // Every sample, live or held at a known time: the shown position follows the shared clock
  // (phase = time mod period), and the rasterized shown frame's head points the way it goes.
  const expected = (phase) => legs.from + legs.travel * (phase < 0.5 ? 2 * phase : 2 - 2 * phase)
  const ahead = { right: 0, left: 0 }
  assert.ok(legs.live.length >= 6, 'live samples')
  assert.ok(
    Math.abs(legs.begin / legs.period - Math.round(legs.begin / legs.period)) < 1e-6,
    'the runner begins on a whole cycle of the clock'
  )
  for (const sample of [...legs.samples, ...legs.live]) {
    const wrap = Math.abs(sample.phase - sample.clockPhase)
    assert.ok(
      wrap < 1e-6 || Math.abs(wrap - 1) < 1e-6,
      `the animation's own phase is the clock's at ${sample.phase.toFixed(3)}`
    )
    assert.ok(
      Math.abs(sample.x - expected(sample.phase)) < 2,
      `on the clock at phase ${sample.phase.toFixed(3)}`
    )
    const edge = Math.min(sample.phase, Math.abs(sample.phase - 0.5), 1 - sample.phase)
    if (edge < 0.002) continue // the turn itself
    const right = sample.phase < 0.5
    assert.ok(
      right ? sample.lead > 0.3 : sample.lead < -0.3,
      `faces its way at phase ${sample.phase.toFixed(3)}`
    )
    ahead[right ? 'right' : 'left']++
  }
  assert.ok(
    ahead.right >= 6 && ahead.left >= 6,
    `both legs sampled (${ahead.right} right, ${ahead.left} left)`
  )
  // Consecutive samples on one leg: the real position delta agrees with the facing.
  for (const [index, sample] of legs.samples.entries()) {
    const next = legs.samples[index + 1]
    if (!next || Math.floor(sample.phase * 2) !== Math.floor(next.phase * 2) || next.t <= sample.t)
      continue
    const dx = next.x - sample.x
    if (Math.abs(dx) > 0.2)
      assert.equal(Math.sign(dx), Math.sign(sample.lead), 'moves the way it faces')
  }
  // Each turn: the samples nearest either side of the far end (and of the start) face opposite ways.
  for (const turn of [0.5, 1]) {
    const before = legs.samples.filter((s) => s.phase < turn && s.phase > turn - 0.01)
    const after = legs.samples.filter((s) =>
      turn === 1 ? s.phase < 0.01 : s.phase > turn && s.phase < turn + 0.01
    )
    assert.ok(before.length && after.length, `samples around the turn at ${turn}`)
    assert.ok(
      before.every((s) => Math.sign(s.lead) === (turn === 0.5 ? 1 : -1)),
      `before the turn at ${turn}`
    )
    assert.ok(
      after.every((s) => Math.sign(s.lead) === (turn === 0.5 ? -1 : 1)),
      `after the turn at ${turn}`
    )
  }
  const [old, rehosted] = legs.rehost
  assert.ok(
    Math.abs(legs.rehostPhases[0] - legs.rehostPhases[1]) < 1e-6,
    'a rehosted row is on the same phase of the shared clock'
  )
  assert.ok(
    Math.abs(old.x - rehosted.x) < 1 && old.scaleX === rehosted.scaleX,
    'a rehosted row shows the same place and facing'
  )
  assert.equal(report.released, true, 'nothing keeps a discarded line alive')
  console.log(
    'Sidebar chats loader: one noninteractive line, running cat, resize, Reduce Motion and cleanup passed'
  )
}
