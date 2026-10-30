import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runFixture, swiftBuild } from './helpers/swift-build.mjs'

// LKM-384, LKM-388: the History section's rows, from the real `ShellRow.layoutNested`: nothing by
// default; once revealed, a header with the closed-chat count, three closed chats, then "Show N
// more" and "Show less". The project menu's item comes from the real `SidebarHistoryState`. The
// native smoke used to skip this path with fewer than four closed chats, so it had never run.
if (process.platform !== 'darwin') {
  console.log('SIDEBAR-HISTORY-ROWS SKIP — macOS AppKit required')
} else {
  const binary = swiftBuild('sidebar-history-rows', [
    'test/fixtures/sidebar-history-rows/main.swift',
    'src/native/ProjectCell.swift',
    'src/native/SourceList.swift',
    'src/native/SidebarIcon.swift',
    'src/native/SidebarChatsAccessibility.swift'
  ])
  const report = JSON.parse(runFixture(binary))
  const ids = (key) => report[key].map((row) => row.id)
  const chats = ['chat:b', 'chat:a']
  const toggle = 'history-toggle:p'
  const closed = (count) => Array.from({ length: count }, (_, index) => `history:${index}`)

  for (const state of ['closed', 'open', 'all'])
    assert.deepEqual(ids(`0-${state}`), chats, `no closed chats: no History row (${state})`)

  for (const count of [1, 3, 4, 7])
    assert.deepEqual(ids(`${count}-closed`), chats, `${count}: the default shows no History row`)
  const header = report['4-open'][2]
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

  // The menu item: Show, then Hide; hiding forgets "Show N more"; one project never moves another.
  const item = (title, enabled = true) => ({ title, enabled })
  const { states } = report
  assert.deepEqual(states.hidden, item('Show History'))
  assert.deepEqual(states.revealed, item('Hide History'))
  assert.deepEqual(states.hiddenAgain, { ...item('Show History'), open: [], all: [] })
  assert.deepEqual(states.isolated.p, item('Hide History'))
  assert.deepEqual(states.isolated.q, item('Show History'))
  assert.deepEqual(states.isolated.open, ['p'])
  assert.deepEqual(states.isolated.rowsOfOther, chats, 'p revealed: q keeps the default rows')

  // Empty history: selected, nothing to show, so the item is disabled, even if it was revealed.
  assert.deepEqual(states.empty, item('Show History', false))
  assert.deepEqual(states.emptied, item('Show History', false))
  // Not selected: its closed chats may not be loaded yet, so the item stays enabled.
  assert.deepEqual(states.emptyUnselected, item('Show History'))
  assert.deepEqual(states.revealedUnselected, item('Hide History'))

  // The menu comes from that state, on the "…" and the row's context menu alike.
  const shell = readFileSync('src/native/Shell.swift', 'utf8')
  assert.match(shell, /menu\.insertItem\(sidebarHistoryItem\(row\), at: 1\)/)
  const swift = readFileSync('src/native/SidebarChats.swift', 'utf8')
  assert.match(swift, /projectMenu\(row\)\.popUp\(/, 'the "…" builds its menu on each press')

  // The smoke must reach the path, not skip it.
  const smoke = readFileSync('src/native/smoke-sidebar-chats.ts', 'utf8')
  assert.doesNotMatch(smoke, /if \(count > 3\)/, 'the smoke must not skip "Show N more"')
  assert.match(smoke, /assert\.ok\(count > 3/)
  console.log(
    'SIDEBAR-HISTORY-ROWS PASS — hidden by default, header, three closed chats, Show N more, Show less, menu item per project, empty history'
  )
}
