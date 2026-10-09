/**
 * LKM-130: Resolve (stageResolve) and the explicit landing (applyParked) end in a
 * resolvable conflict, never an error, when `git apply --3way` refuses the chat's
 * patch as a whole: add/add, modify/delete, delete/modify, rename/delete, a rename
 * with an overlapping edit, a file live renamed, all at once with an ordinary content
 * conflict and a binary file, and on the live checkout. The conflicted files carry
 * markers, the agent's reconciled result lands, and Discard restores the prior state.
 * Run through test/repository-owner.mjs (the Swift owner preloaded), like chat-worktrees.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  applyParked,
  completeTurn,
  createChatWorktree,
  discardParked,
  stageResolve
} from '../src/main/chat-worktrees.ts'

const base = mkdtempSync(join(tmpdir(), 'trezi-resolve-'))
const worktreesDir = join(base, 'worktrees')
let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const read = (root, file) => readFileSync(join(root, file), 'utf8')
const put = (root, file, content) => {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), content)
}
const markers = (text) =>
  /^<<<<<<< .+$/m.test(text) && /^=======$/m.test(text) && /^>>>>>>> .+$/m.test(text)
const PAGE = 'src/app/demo-themer/page.tsx'
const CSS = 'src/components/Header.module.css'
const css = (first) => `.header {\n  color: ${first};\n  padding: 4px;\n  margin: 0;\n}\n`

let repos = 0
function makeRepo(files) {
  const repo = join(base, `repo${++repos}`)
  mkdirSync(repo, { recursive: true })
  g(repo, 'init', '-q', '-b', 'main')
  g(repo, 'config', 'user.name', 'Test')
  g(repo, 'config', 'user.email', 'test@local')
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n.env\n')
  for (const [file, content] of Object.entries(files)) put(repo, file, content)
  g(repo, 'add', '-A')
  g(repo, 'commit', '-q', '-m', 'init')
  return repo
}

/** A chat whose turn parked against a concurrent live edit, as the conflict card shows it. */
async function parked(files, chatEdits, liveEdits) {
  const repo = makeRepo(files)
  const wt = await createChatWorktree(repo, `resolve${repos}`, worktreesDir)
  chatEdits(wt.path)
  liveEdits(repo)
  const turn = await completeTurn(repo, wt, 'chat turn')
  ok(turn.outcome === 'parked', `repo${repos}: the turn parks: ${turn.outcome}`)
  return { repo, wt }
}

async function resolve(label, wt, repo) {
  try {
    return await stageResolve(repo, wt)
  } catch (error) {
    ok(false, `${label}: Resolve must not fail: ${error?.message ?? error}`)
    return { conflicted: [], files: [], clean: true }
  }
}

try {
  // add/add — the chat creates a page the project got meanwhile.
  {
    const { repo, wt } = await parked(
      { 'README.md': 'base\n' },
      (root) => put(root, PAGE, 'export default () => "chat"\n'),
      (root) => put(root, PAGE, 'export default () => "live"\n')
    )
    const prep = await resolve('add/add', wt, repo)
    ok(
      !prep.clean && prep.conflicted.includes(PAGE),
      `add/add is a conflict: ${JSON.stringify(prep)}`
    )
    const text = read(wt.path, PAGE)
    ok(
      markers(text) && text.includes('"chat"') && text.includes('"live"'),
      `add/add markers carry both versions: ${text}`
    )
    put(wt.path, PAGE, 'export default () => "chat and live"\n')
    const done = await completeTurn(repo, wt, 'reconcile add/add')
    ok(done.outcome === 'merged', `the reconciled add/add lands: ${done.outcome}`)
    ok(
      read(repo, PAGE) === 'export default () => "chat and live"\n',
      'the live page is the reconciled one'
    )
  }

  // modify/delete — the chat edits a page that was deleted live. Git refuses the whole
  // patch ("does not exist in index"); the merge fallback marks it explicitly.
  {
    const { repo, wt } = await parked(
      { [PAGE]: 'export default () => "base"\n' },
      (root) => put(root, PAGE, 'export default () => "chat"\n'),
      (root) => rmSync(join(root, PAGE))
    )
    const prep = await resolve('modify/delete', wt, repo)
    ok(
      !prep.clean && prep.conflicted.includes(PAGE),
      `modify/delete is a conflict: ${JSON.stringify(prep)}`
    )
    const text = read(wt.path, PAGE)
    ok(
      markers(text) && /^<<<<<<< live \(deleted\)$/m.test(text) && text.includes('"chat"'),
      `modify/delete names the deleted side and keeps the chat's edit: ${text}`
    )
    put(wt.path, PAGE, 'export default () => "chat"\n')
    const done = await completeTurn(repo, wt, 'keep the page')
    ok(done.outcome === 'merged', `keeping the chat's page lands: ${done.outcome}`)
    ok(
      read(repo, PAGE) === 'export default () => "chat"\n',
      'the page is back on live with the chat edit'
    )
  }

  // delete/modify — the chat deletes a stylesheet the user edited live.
  {
    const { repo, wt } = await parked(
      { [CSS]: css('red') },
      (root) => rmSync(join(root, CSS)),
      (root) => put(root, CSS, css('blue'))
    )
    const prep = await resolve('delete/modify', wt, repo)
    ok(
      !prep.clean && prep.conflicted.includes(CSS),
      `delete/modify is a conflict: ${JSON.stringify(prep)}`
    )
    const text = read(wt.path, CSS)
    ok(
      markers(text) && text.includes('blue') && /^>>>>>>> chat \(deleted\)$/m.test(text),
      `delete/modify keeps the live edit against the chat's deletion: ${text}`
    )
    // Discard after Resolve: the worktree goes back to the project's state, which is untouched.
    await discardParked(wt)
    ok(read(wt.path, CSS) === css('blue'), 'Discard restored the live version in the worktree')
    ok(g(wt.path, 'status', '--porcelain').trim() === '', 'Discard left a clean worktree')
    ok(read(repo, CSS) === css('blue'), 'the live checkout never changed')
    ok(
      g(repo, 'for-each-ref', '--format=%(refname)', 'refs/trezi/recovery/').includes('discarded'),
      'the discarded conflict state is kept under a recovery ref'
    )
  }

  // rename/delete — the chat renames (and edits) a file that was deleted live.
  {
    const renamed = 'src/components/Nav.module.css'
    const { repo, wt } = await parked(
      { [CSS]: css('red') },
      (root) => {
        rmSync(join(root, CSS))
        put(root, renamed, css('red').replace('margin: 0', 'margin: 2px'))
      },
      (root) => rmSync(join(root, CSS))
    )
    const prep = await resolve('rename/delete', wt, repo)
    ok(
      !prep.clean && prep.conflicted.includes(renamed),
      `rename/delete is a conflict: ${JSON.stringify(prep)}`
    )
    const text = read(wt.path, renamed)
    ok(
      markers(text) && /^<<<<<<< live \(deleted\)$/m.test(text) && text.includes('margin: 2px'),
      `rename/delete markers: ${text}`
    )
    ok(!existsSync(join(wt.path, CSS)), 'the deleted source stays deleted')
  }

  // A rename with an overlapping live edit to the source: markers in the new name.
  {
    const renamed = 'src/components/Nav.module.css'
    const { repo, wt } = await parked(
      { [CSS]: css('red') },
      (root) => {
        rmSync(join(root, CSS))
        put(root, renamed, css('green'))
      },
      (root) => put(root, CSS, css('blue'))
    )
    const prep = await resolve('rename/edit', wt, repo)
    ok(
      !prep.clean && prep.conflicted.includes(renamed),
      `a renamed file with overlapping edits is a conflict: ${JSON.stringify(prep)}`
    )
    const text = read(wt.path, renamed)
    ok(
      markers(text) && text.includes('green') && text.includes('blue'),
      `rename markers carry both edits: ${text}`
    )
    ok(!existsSync(join(wt.path, CSS)), 'the old name is gone')
  }

  // The chat edits a file the user renamed live: the edit follows the rename, cleanly.
  {
    const moved = 'src/components/Nav.module.css'
    const { repo, wt } = await parked(
      { [CSS]: css('red') },
      (root) => put(root, CSS, css('red').replace('margin: 0', 'margin: 2px')),
      (root) => {
        rmSync(join(root, CSS))
        put(root, moved, css('red'))
      }
    )
    const prep = await resolve('live rename', wt, repo)
    ok(prep.clean, `an edit to a file live renamed merges: ${JSON.stringify(prep)}`)
    ok(
      read(wt.path, moved).includes('margin: 2px') && !existsSync(join(wt.path, CSS)),
      'the chat edit landed in the renamed file'
    )
  }

  // Everything at once, as in the reported chat: one refused patch, every file resolvable.
  {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
    const { repo, wt } = await parked(
      { [CSS]: css('red'), 'README.md': 'one\ntwo\nthree\n', 'logo.png': png, 'old.txt': 'gone\n' },
      (root) => {
        put(root, PAGE, 'export default () => "chat"\n')
        put(root, CSS, css('green'))
        put(root, 'README.md', 'one\nCHAT\nthree\n')
        writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]))
        rmSync(join(root, 'old.txt'))
      },
      (root) => {
        put(root, PAGE, 'export default () => "live"\n')
        rmSync(join(root, CSS))
        put(root, 'README.md', 'one\nLIVE\nthree\n')
        writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 5, 5, 5]))
      }
    )
    const prep = await resolve('mixed', wt, repo)
    for (const file of [PAGE, CSS, 'README.md']) {
      ok(
        prep.conflicted.includes(file) && markers(read(wt.path, file)),
        `mixed: ${file} is conflicted with markers: ${JSON.stringify(prep)}`
      )
    }
    ok(
      !prep.conflicted.includes('logo.png'),
      'mixed: the binary file is not listed as marker-bearing'
    )
    ok(
      readFileSync(join(wt.path, 'logo.png')).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9])
      ),
      "mixed: a binary file changed on both sides keeps the chat's version (existing policy)"
    )
    ok(!existsSync(join(wt.path, 'old.txt')), 'mixed: the uncontested deletion is laid')
    ok(
      read(repo, 'README.md') === 'one\nLIVE\nthree\n',
      'mixed: Resolve never touches the live checkout'
    )
    await discardParked(wt)
    ok(
      read(wt.path, PAGE) === 'export default () => "live"\n' && !existsSync(join(wt.path, CSS)),
      'mixed: Discard restores the live state'
    )
  }

  // The explicit landing on the live checkout: add/add + modify/delete is a conflict with
  // markers in the project (as a textual overlap always was), not "couldn't apply".
  {
    const { repo, wt } = await parked(
      { [CSS]: css('red'), 'README.md': 'base\n' },
      (root) => {
        put(root, PAGE, 'export default () => "chat"\n')
        put(root, CSS, css('green'))
      },
      (root) => {
        put(root, PAGE, 'export default () => "live"\n')
        rmSync(join(root, CSS))
      }
    )
    const applied = await applyParked(repo, wt)
    ok(
      !applied.ok && applied.conflict,
      `the landing reports a conflict: ${JSON.stringify(applied)}`
    )
    ok(
      /page\.tsx/.test(applied.error ?? '') && /Header\.module\.css/.test(applied.error ?? ''),
      `the conflict names the files: ${applied.error}`
    )
    ok(
      markers(read(repo, PAGE)) && markers(read(repo, CSS)),
      'the live files carry markers for the user'
    )
  }

  if (failed === 0)
    console.log(
      'RESOLVE-CONFLICTS OK — add/add, modify/delete, delete/modify, renames, mixed, live landing, discard'
    )
  else console.error(`RESOLVE-CONFLICTS: ${failed} assertion(s) failed`)
  process.exitCode = failed === 0 ? 0 : 1
} catch (err) {
  console.error('RESOLVE-CONFLICTS FAILED:', err?.stack ?? err)
  process.exitCode = 1
} finally {
  rmSync(base, { recursive: true, force: true })
}
