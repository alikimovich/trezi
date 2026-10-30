import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-384: the History section's rows, from the real `ShellRow.layoutNested`: a toggle with the
// closed-chat count, three closed chats, then "Show N more" and "Show less". The native smoke
// used to skip this path with fewer than four closed chats, so it had never run.
if (process.platform !== 'darwin') {
  console.log('SIDEBAR-HISTORY-ROWS SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('sidebar-history-rows', [
    'test/fixtures/sidebar-history-rows/main.swift',
    'src/native/ProjectCell.swift',
    'src/native/SourceList.swift',
    'src/native/SidebarIcon.swift'
  ])
  const report = JSON.parse(runFixture(binary))
  const ids = (key) => report[key].map((row) => row.id)
  const chats = ['chat:b', 'chat:a']
  const toggle = 'history-toggle:p'
  const closed = (count) => Array.from({ length: count }, (_, index) => `history:${index}`)

  for (const state of ['closed', 'open', 'all'])
    assert.deepEqual(ids(`0-${state}`), chats, `no closed chats: no History toggle (${state})`)

  assert.deepEqual(ids('4-closed'), [...chats, toggle], 'a closed History shows only its toggle')
  const header = report['4-closed'].at(-1)
  assert.deepEqual([header.kind, header.title, header.detail], ['history-toggle', 'History', '4'])

  for (const count of [1, 3]) {
    assert.deepEqual(ids(`${count}-open`), [...chats, toggle, ...closed(count)], `${count} closed`)
    assert.deepEqual(ids(`${count}-all`), ids(`${count}-open`), `${count}: no "Show more" needed`)
  }

  const more = 'history-more:p'
  assert.deepEqual(ids('4-open'), [...chats, toggle, ...closed(3), more], 'three, then the rest')
  assert.equal(report['4-open'].at(-1).title, 'Show 1 more')
  assert.equal(report['7-open'].at(-1).title, 'Show 4 more')
  assert.deepEqual(ids('7-all'), [...chats, toggle, ...closed(7), more], 'every closed chat')
  assert.equal(report['7-all'].at(-1).title, 'Show less')
  assert.equal(report['7-open'].at(-2).detail, '3d', 'a closed chat keeps its age')

  assert.deepEqual(report.unselected, [], 'a project that is not selected nests nothing')

  // The smoke must reach the path, not skip it.
  const smoke = readFileSync('src/native/smoke-sidebar-chats.ts', 'utf8')
  assert.doesNotMatch(smoke, /if \(count > 3\)/, 'the smoke must not skip "Show N more"')
  assert.match(smoke, /assert\.ok\(count > 3/)
  console.log('SIDEBAR-HISTORY-ROWS PASS — toggle, three closed chats, Show N more, Show less')
}
