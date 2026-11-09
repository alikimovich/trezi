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
    report = JSON.parse(runFixture(binary, [assets]))
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
  assert.deepEqual(wide.facing, [-1, 1], 'mirrored running right, plain running left')
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
  assert.ok(Math.abs(report.offsets[0] - report.offsets[1]) < 0.5, 'a rebuilt row keeps the phase')
  assert.deepEqual([reduced.mode, reduced.animations, reduced.painted], ['still', [], true])
  assert.equal(reduced.label, 'Loading chats', 'Reduce Motion keeps the status')
  assert.equal(restored.mode, 'run')
  assert.deepEqual([hidden.mode, hidden.animations], ['none', []], 'hidden: nothing runs')
  assert.equal(unhidden.mode, 'run')
  assert.deepEqual([detached.mode, detached.animations], ['none', []], 'unmounted: stopped')
  assert.equal(report.released, true, 'nothing keeps a discarded line alive')
  console.log(
    'Sidebar chats loader: one noninteractive line, running cat, resize, Reduce Motion and cleanup passed'
  )
}
