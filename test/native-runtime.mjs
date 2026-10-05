import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSmokeGroups } from '../src/native/smoke-groups.ts'

function assertSidebarEvidence(dir, since) {
  const fresh = (name) => {
    const path = join(dir, name)
    assert.ok(
      statSync(path, { throwIfNoEntry: false })?.mtimeMs >= since,
      `Native suite did not write fresh ${name}`
    )
    return path
  }
  for (const width of [260, 180])
    for (const row of [0, 1])
      for (const state of ['rest', 'hover']) {
        const stem = `sidebar-${width}-${row}-${state}`
        assert.ok(statSync(fresh(`${stem}.png`)).size > 1000, `${stem}.png is empty`)
        const evidence = JSON.parse(readFileSync(fresh(`${stem}.json`), 'utf8'))
        assert.equal(evidence.rows.length, 2, `${stem}.json rows`)
        assert.ok(
          evidence.rows.every((r) => r.folder && r.template),
          `${stem}.json folder rows`
        )
      }
  const interactions = JSON.parse(readFileSync(fresh('sidebar-interactions.json'), 'utf8'))
  const checks = interactions.filter((entry) => entry.drag)
  assert.deepEqual(
    checks.map((entry) => entry.width),
    [260, 180],
    'Menu/reorder checks at both widths'
  )
  assert.ok(
    checks.every(
      (entry) =>
        entry.menu.opened && entry.memoryOpened && entry.drag.accepted && entry.focusRestored
    ),
    'Menu/reorder evidence'
  )
  JSON.parse(readFileSync(fresh('sidebar-selection.json'), 'utf8'))
  console.log(
    'Native sidebar evidence: 8 fresh foreground captures plus selection, menu and reorder records.'
  )
}

if (process.platform !== 'darwin') {
  console.log('NATIVE-RUNTIME SKIP — macOS native host required.')
} else if (spawnSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' }).status !== 0) {
  console.log('NATIVE-RUNTIME SKIP — Xcode command-line tools are not installed.')
} else {
  const cwd = fileURLToPath(new URL('../', import.meta.url))
  // `--only=group,group` is forwarded to the smoke; see src/native/smoke-groups.ts.
  const groups = parseSmokeGroups(process.argv.slice(2))
  const started = Date.now()
  const result = spawnSync('bun', ['run', 'dev:native', '--test', ...process.argv.slice(2)], {
    cwd,
    stdio: 'inherit',
    timeout: 300000
  })
  if (result.error) throw result.error
  // A passing smoke run must have produced fresh sidebar folder evidence for review.
  if (result.status === 0 && groups.has('sidebar'))
    assertSidebarEvidence(join(cwd, 'test/artifacts/native'), started)
  const host = fileURLToPath(
    new URL('../out/native/Trezi.app/Contents/MacOS/TreziHost', import.meta.url)
  )
  for (const args of [[], ['/tmp']]) {
    const direct = spawnSync(host, args, { encoding: 'utf8', timeout: 10000 })
    if (direct.error) throw direct.error
    assert.equal(direct.signal, null, 'Direct launch must not crash or trigger Crash Reporter')
    assert.equal(direct.status, 64)
    assert.match(direct.stderr, /is started by Trezi/)
    assert.equal(direct.stdout, '')
  }
  console.log('Native host direct launch: missing arguments exit cleanly without a signal.')
  process.exitCode = result.status ?? 1
}
