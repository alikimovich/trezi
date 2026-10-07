// LKM-194: conflict markers and failed installs never refuse a chat turn.
// - markers: detection, the first marker line, a package.json "version" conflict (plain
//   and diff3) with the higher SemVer, and the git-grep scan of a real repository;
// - prompt: the facts the agent gets with the user's message;
// - card: the turn's `dependencies` event shows "Conflicts in package.json" with Show
//   conflict and Resolve with agent (or a failed install with Fix with agent), and its
//   actions open the file at the marker or send the resolution turn.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  firstMarkerLine,
  hasConflictMarkers,
  manifestMarkers,
  markerConflict,
  markerVersion
} from '../src/main/conflict-markers.ts'
import { recoveryAction, recoveryCards } from '../src/native/chat-recovery.ts'
import { newChat, reduce } from '../src/native/chat-state.ts'
import {
  compareSemver,
  dependencyNotice,
  resolveConflictPrompt,
  versionConflict
} from '../src/shared/dependency-issue.ts'

// ── SemVer ──
assert.ok(compareSemver('0.2.8', '0.2.7') > 0)
assert.ok(compareSemver('1.0.0', '0.10.0') > 0)
assert.ok(compareSemver('0.10.0', '0.9.9') > 0)
assert.ok(compareSemver('1.0.0-beta.2', '1.0.0') < 0)
assert.ok(compareSemver('1.0.0-beta.10', '1.0.0-beta.2') > 0)
assert.equal(compareSemver('v1.2.3', '1.2.3'), 0)
assert.equal(compareSemver('latest', '1.0.0'), null)
assert.deepEqual(versionConflict('0.2.7', '0.2.8'), {
  ours: '0.2.7',
  theirs: '0.2.8',
  keep: '0.2.8'
})
assert.deepEqual(versionConflict('1.0.0', '0.9.0'), {
  ours: '1.0.0',
  theirs: '0.9.0',
  keep: '1.0.0'
})
assert.equal(versionConflict('1.0.0', '1.0.0'), null)

// ── Markers ──
const marked =
  '{\n  "name": "shop",\n<<<<<<< HEAD\n  "version": "0.2.7"\n=======\n  "version": "0.2.8"\n>>>>>>> origin/trezi/main\n}\n'
assert.ok(hasConflictMarkers(marked))
assert.ok(!hasConflictMarkers('<<<<<<< only an example\n'))
assert.equal(firstMarkerLine(marked), 3)
assert.deepEqual(markerVersion(marked), { ours: '0.2.7', theirs: '0.2.8', keep: '0.2.8' })
const diff3 =
  '{\n<<<<<<< ours\n  "version": "0.3.0",\n||||||| base\n  "version": "0.2.6",\n=======\n  "version": "0.2.9",\n>>>>>>> theirs\n}\n'
assert.deepEqual(markerVersion(diff3), { ours: '0.3.0', theirs: '0.2.9', keep: '0.3.0' })
assert.equal(
  markerVersion('<<<<<<< a\n  "name": "x"\n=======\n  "name": "y"\n>>>>>>> b\n'),
  null,
  'no version line, no version conflict'
)

const base = mkdtempSync(join(tmpdir(), 'trezi-dependency-issue-'))
try {
  const repo = join(base, 'repo')
  mkdirSync(join(repo, 'docs'), { recursive: true })
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'package.json'), marked)
  writeFileSync(join(repo, 'docs', 'git.md'), 'A conflict starts with\n<<<<<<< HEAD\nin Git.\n')
  writeFileSync(
    join(repo, 'app.ts'),
    '<<<<<<< HEAD\nconst a = 1\n=======\nconst a = 2\n>>>>>>> b\n'
  )
  g('add', 'package.json', 'docs/git.md')
  // app.ts is untracked: a synced new file still counts.
  assert.deepEqual(await manifestMarkers(repo), ['package.json'])
  const conflict = await markerConflict(repo)
  assert.deepEqual(conflict, {
    files: ['package.json', 'app.ts'],
    line: 3,
    manifests: true,
    version: { ours: '0.2.7', theirs: '0.2.8', keep: '0.2.8' }
  })
  writeFileSync(join(repo, 'package.json'), '{ "version": "0.2.8" }\n')
  rmSync(join(repo, 'app.ts'))
  assert.equal(await markerConflict(repo), null, 'a lone marker in a doc is no conflict')

  // ── Prompt facts ──
  const notice = dependencyNotice({ conflict })
  assert.match(notice, /conflict markers .* in: package\.json, app\.ts/)
  assert.match(notice, /keep 0\.2\.8 \(the higher SemVer\)/)
  assert.match(notice, /Dependencies were not installed/)
  assert.match(
    dependencyNotice({ install: 'bun install exited with code 1' }),
    /^Dependencies are not installed in this workspace: bun install exited with code 1/
  )
  assert.match(resolveConflictPrompt(conflict), /keep 0\.2\.8[\s\S]*git_merge_continue/)

  // ── Card ──
  const chat = newChat('chat-a')
  reduce(chat, { type: 'dependencies', issue: { conflict } })
  const [card] = recoveryCards(chat)
  assert.equal(card.id, 'dependency-conflict')
  assert.equal(card.title, 'Conflicts in 2 files')
  assert.match(card.detail, /Dependencies were not installed/)
  assert.match(card.detail, /keep 0\.2\.8, the higher one/)
  assert.deepEqual(
    card.actions.map((a) => a.label),
    ['Show conflict', 'Resolve with agent']
  )
  reduce(chat, {
    type: 'dependencies',
    issue: { conflict: { ...conflict, files: ['package.json'] } }
  })
  assert.equal(recoveryCards(chat)[0].title, 'Conflicts in package.json')

  const effects = [],
    runs = []
  const controller = {
    services: { invoke: async () => ({ ok: true }), effect: (e) => effects.push(e) },
    run: async (_chat, submission) => runs.push(submission.text)
  }
  assert.ok(await recoveryAction(controller, chat, 'dependency-show'))
  assert.deepEqual(effects, [{ type: 'source', source: 'package.json:3' }])
  chat.paused = true
  assert.ok(await recoveryAction(controller, chat, 'dependency-resolve'))
  assert.equal(chat.paused, false)
  assert.match(runs[0], /Resolve the unresolved Git conflict markers in package\.json/)
  assert.match(runs[0], /keep 0\.2\.8/)

  // A failed install: its reason, Fix with agent, Dismiss.
  reduce(chat, { type: 'dependencies', issue: { install: 'bun install exited with code 1' } })
  const [install] = recoveryCards(chat)
  assert.equal(install.title, 'Dependencies aren’t installed')
  assert.equal(install.detail, 'bun install exited with code 1')
  await recoveryAction(controller, chat, 'dependency-fix')
  assert.match(runs[1], /could not be installed[\s\S]*bun install exited with code 1/)
  await recoveryAction(controller, chat, 'dependency-dismiss')
  assert.deepEqual(recoveryCards(chat), [])
  // The next turn without an issue clears the card.
  reduce(chat, { type: 'dependencies', issue: { install: 'x' } })
  reduce(chat, { type: 'dependencies', issue: null })
  assert.deepEqual(recoveryCards(chat), [])
} finally {
  rmSync(base, { recursive: true, force: true })
}
console.log('DEPENDENCY-ISSUE OK')
