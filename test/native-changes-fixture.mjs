// LKM-366: the `changes-panel` native smoke's temp Git project (src/native/smoke-changes-fixture.ts)
// against the real `branchDiff` and `openDiff`, without a desktop: the merge-base label,
// committed apart from staged/unstaged/untracked with the rows the smoke expects, file and
// hunk clicks open the ranges the smoke asserts, a deleted file is refused, and reading and
// opening leave HEAD, branches, index and work tree unchanged.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchDiff } from '../src/main/branch-diff.ts'
import { openDiff } from '../src/native/editor-diff.ts'
import {
  CHANGES_ROWS,
  git,
  gitState,
  writeChangesProject
} from '../src/native/smoke-changes-fixture.ts'

// SourceDiffList.section's row text: status letter, title (`from → path`), counts.
const letters = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U' }
const rowText = (file) =>
  [
    letters[file.status] ?? 'M',
    file.from ? `${file.from} → ${file.path}` : file.path,
    file.binary ? 'binary' : `+${file.added}`,
    file.binary ? '' : `−${file.removed}`
  ].join(' ')

const temp = mkdtempSync(join(tmpdir(), 'trezi-changes-fixture-'))
try {
  const project = join(temp, 'Changes Project')
  writeChangesProject(project)
  const before = gitState(project)
  const diff = await branchDiff(project)
  const base = git(project, 'rev-parse', '--short=7', 'main')
  assert.equal(diff.branch, 'feature')
  assert.equal(diff.head, git(project, 'rev-parse', '--short=7', 'HEAD'))
  assert.equal(diff.base.label, `Base: merge-base with main @ ${base}`)
  assert.deepEqual(
    diff.sections.map((s) => [s.kind, s.label]),
    [
      ['committed', `Committed since ${base} (main)`],
      ['staged', 'Staged (uncommitted)'],
      ['unstaged', 'Unstaged (uncommitted)'],
      ['untracked', 'Untracked (uncommitted)']
    ]
  )
  for (const section of diff.sections)
    assert.deepEqual(section.files.map(rowText).sort(), CHANGES_ROWS[section.kind], section.kind)

  // The editor's clicks, through a controller that records what it would open.
  const opens = []
  const session = { state: { root: project, diff, error: '' } }
  const controller = {
    publish: () => {},
    open: async (root, source, _text, _focus, range) => opens.push({ root, source, range })
  }
  const click = async (section, source, hunk) => {
    opens.length = 0
    session.state.error = ''
    await openDiff(controller, session, { action: 'diff-open', section, source, hunk })
    return opens[0] ?? session.state.error
  }
  const lines = (opened) => [opened.source, opened.range?.startLine, opened.range?.endLine]
  assert.deepEqual(lines(await click('committed', 'feature.css')), ['feature.css:1', 1, 3])
  const hunk = await click('committed', 'app.css', 0)
  assert.deepEqual(lines(hunk), ['app.css:5', 5, 6])
  assert.equal(hunk.range.code, '.app line 5 { changed }\n.app line 6 { changed }')
  assert.deepEqual(lines(await click('staged', 'staged.txt', 0)), ['staged.txt:3', 3, 3])
  assert.deepEqual(lines(await click('untracked', 'untracked.txt')), [
    'untracked.txt:1',
    undefined,
    undefined
  ])
  assert.deepEqual(lines(await click('committed', 'logo.bin')), [
    'logo.bin:1',
    undefined,
    undefined
  ])
  assert.equal(
    await click('committed', 'remove-me.txt'),
    'remove-me.txt was deleted, so there is no file to open.'
  )
  assert.deepEqual(gitState(project), before, 'Reading and opening changes nothing in Git')
  console.log(
    'Changes fixture: merge-base label, four sections with the smoke’s rows and counts, file/hunk opens at 1–3, 5–6, 3–3, deleted refused, Git state unchanged.'
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}
