/**
 * live-commit.ts through the Swift repository owner (test/repository-owner.mjs runs it
 * with the owner preloaded). Every agent turn that changes files
 * now lands as ONE commit on the user's live checkout, so a session reads as progress
 * in `git log` and any turn can be `git revert`ed on its own.
 *
 * Asserts: a turn's files commit with the given subject + a Trezi body; an
 * unrelated dirty file is NOT swept in; the user's own STAGED work stays staged and out
 * of the commit; a file the turn created is committed; `.trezi/` sidecar paths are
 * filtered; a no-op (content already at HEAD) commits nothing; an empty file list, a
 * non-repo directory and a repo SUBDIRECTORY are all skipped without throwing; and
 * `commitTitle` collapses/caps a multi-line prompt. Then the real `chat-isolation.ts`
 * turn path (no Electron — its window/store seam is injected): two turns in a worktree
 * produce two live commits and a clean live checkout. Finally `publish-scope.ts`: a
 * fully-committed session is still in publish scope (the regression per-turn commits
 * would otherwise cause).
 * Uses real temp git repos.
 *
 * Run with: bun test/repository-owner.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterTurn,
  beforeTurn,
  discardParkedChat,
  initChatIsolation,
  isolatedCwd,
  releaseChat
} from '../src/main/chat-isolation.ts'
import { commitLiveTurn, commitTitle, committableFiles } from '../src/main/live-commit.ts'
import { aheadOfBase, changedSince, defaultBase } from '../src/main/publish-scope.ts'

const base = mkdtempSync(join(tmpdir(), 'trezi-lc-'))
let failed = 0
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failed++
  }
}
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const log = (repo, fmt = '%s') => g(repo, 'log', `--pretty=${fmt}`).trim().split('\n')
/** Files in the tip commit. */
const commitFiles = (repo) =>
  g(repo, 'show', '--name-only', '--pretty=format:', 'HEAD').trim().split('\n').filter(Boolean)
// NB: no .trim() — the porcelain status code is 2 columns and a leading SPACE is
// meaningful (" M" = modified but unstaged vs "M " = staged).
const porcelain = (repo) =>
  g(repo, 'status', '--porcelain').replace(/\n$/, '').split('\n').filter(Boolean)
const branchExists = (repo, branch) => g(repo, 'branch', '--list', branch).trim().length > 0
const waitFor = async (condition) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

let n = 0
function makeRepo(files = { 'a.txt': 'a\n' }) {
  const repo = join(base, `repo${n++}`)
  mkdirSync(repo, { recursive: true })
  g(repo, 'init', '-q', '-b', 'main')
  g(repo, 'config', 'user.name', 'Test')
  g(repo, 'config', 'user.email', 'test@local')
  // Real projects gitignore these; a worktree symlinks them in, and an UNIGNORED
  // (here: dangling) symlink would be committed on the branch and then refuse the
  // whole auto-apply batch — an artifact of the fixture, not of the code under test.
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n.env\n')
  for (const [f, content] of Object.entries(files)) writeFileSync(join(repo, f), content)
  g(repo, 'add', '-A')
  g(repo, 'commit', '-q', '-m', 'init')
  return repo
}

try {
  // --- 1. The happy path: the turn's files become one commit, nothing else moves. ---
  {
    const repo = makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'other.txt': 'other\n' })
    writeFileSync(join(repo, 'a.txt'), 'a edited by the agent\n')
    writeFileSync(join(repo, 'b.txt'), 'b edited by the agent\n')
    writeFileSync(join(repo, 'other.txt'), 'the user typed this by hand\n')
    const res = await commitLiveTurn(repo, ['a.txt', 'b.txt'], {
      title: 'make the header blue',
      body: 'Trezi turn 1 (trezi/chat-abc).'
    })
    ok(res.committed, 'turn commits')
    ok(res.sha && res.sha.length >= 7, 'returns the new HEAD sha')
    ok(res.sha === g(repo, 'rev-parse', 'HEAD').trim(), 'sha is HEAD')
    ok(log(repo)[0] === 'make the header blue', `subject is the prompt (got ${log(repo)[0]})`)
    ok(
      g(repo, 'log', '-1', '--pretty=%b').includes('Trezi turn 1 (trezi/chat-abc).'),
      'body carries the turn/branch trailer'
    )
    ok(
      g(repo, 'log', '-1', '--pretty=%an').trim() === 'Trezi',
      'commits as Trezi even without repo identity'
    )
    const inCommit = commitFiles(repo)
    ok(
      inCommit.length === 2 && inCommit.includes('a.txt') && inCommit.includes('b.txt'),
      `only the turn's files are in the commit (got ${inCommit.join(',')})`
    )
    ok(
      porcelain(repo).join('') === ' M other.txt',
      `the hand edit stays uncommitted (got ${JSON.stringify(porcelain(repo))})`
    )
    ok(res.files.length === 2, 'reports the committed files')
  }

  // --- 2. The user's own STAGED work is left staged, not swallowed by the turn. ---
  {
    const repo = makeRepo({ 'a.txt': 'a\n', 'mine.txt': 'mine\n' })
    writeFileSync(join(repo, 'mine.txt'), 'my work in progress\n')
    g(repo, 'add', 'mine.txt') // the user staged their own change
    writeFileSync(join(repo, 'a.txt'), 'agent edit\n')
    const res = await commitLiveTurn(repo, ['a.txt'], { title: 'tweak a' })
    ok(res.committed, 'commits alongside a dirty index')
    ok(commitFiles(repo).join(',') === 'a.txt', 'staged user file is not in the commit')
    ok(porcelain(repo).join('') === 'M  mine.txt', 'the user file is still staged')
  }

  // --- 3. A file the turn CREATED (untracked) is committed. ---
  {
    const repo = makeRepo()
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'new.tsx'), 'export const New = () => null\n')
    const res = await commitLiveTurn(repo, ['src/new.tsx'], { title: 'add a component' })
    ok(res.committed && commitFiles(repo).join(',') === 'src/new.tsx', 'new file is committed')
    ok(porcelain(repo).length === 0, 'tree is clean afterwards')
  }

  // --- 4. The trezi sidecar never reaches the user's history. ---
  {
    ok(
      committableFiles(['.trezi/annotations.json', '.trezi', 'a.txt', 'a.txt', '', ' b.txt ']).join(
        ','
      ) === 'a.txt,b.txt',
      'committableFiles drops sidecar paths, blanks and duplicates'
    )
    ok(
      committableFiles([
        '.env',
        '.env.local',
        'node_modules/pkg/index.js',
        'tsconfig.tsbuildinfo',
        '.dsgn/state.json',
        '.env.example',
        'src/app.tsx'
      ]).join(',') === '.env.example,src/app.tsx',
      'live commits reject secrets/generated paths but allow env templates'
    )
    const repo = makeRepo()
    mkdirSync(join(repo, '.trezi'), { recursive: true })
    writeFileSync(join(repo, '.trezi', 'annotations.json'), '[]\n')
    writeFileSync(join(repo, 'a.txt'), 'agent edit\n')
    await commitLiveTurn(repo, ['.trezi/annotations.json', 'a.txt'], { title: 'edit' })
    ok(commitFiles(repo).join(',') === 'a.txt', 'sidecar is excluded from the commit')
    ok(porcelain(repo).join('') === '?? .trezi/', 'sidecar stays untracked')
  }

  // --- 5. Nothing to record → no empty commits piling up in the history. ---
  {
    const repo = makeRepo()
    const before = log(repo).length
    const noFiles = await commitLiveTurn(repo, [], { title: 'nothing happened' })
    ok(!noFiles.committed, 'an empty file list commits nothing')
    const unchanged = await commitLiveTurn(repo, ['a.txt'], { title: 'no-op' })
    ok(!unchanged.committed, 'a file identical to HEAD commits nothing')
    ok(log(repo).length === before, 'no empty commit was created')
  }

  // --- 6. Non-repo and non-root projects are skipped (never touch an enclosing repo). ---
  {
    const plain = join(base, 'not-a-repo')
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, 'a.txt'), 'a\n')
    const res = await commitLiveTurn(plain, ['a.txt'], { title: 'edit' })
    ok(!res.committed, 'a non-git folder is skipped without throwing')

    const repo = makeRepo()
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true })
    writeFileSync(join(repo, 'packages', 'app', 'x.txt'), 'x\n')
    const sub = await commitLiveTurn(join(repo, 'packages', 'app'), ['x.txt'], { title: 'edit' })
    ok(!sub.committed, 'a subdirectory of a repo is skipped')
    ok(log(repo).length === 1, 'the enclosing repo got no commit')
  }

  // --- 7. Subject shaping. ---
  {
    ok(commitTitle('  make it   blue\nand rounded  ') === 'make it blue', 'first line, collapsed')
    ok(commitTitle('') === 'Trezi chat edit', 'empty prompt gets a fallback subject')
    const long = commitTitle('x'.repeat(200))
    ok(long.length === 72 && long.endsWith('…'), `long subject is capped (got ${long.length})`)
  }

  // --- 8. The real chat-isolation wiring: two turns in a worktree → two live commits.
  // Drives `chat-isolation.ts` itself (no Electron — its window/store seam is injected),
  // so the turn-end hook, the merge and the commit are exercised together. Also proves a
  // per-turn commit doesn't look like drift to the NEXT turn's sync (turn 2 must merge,
  // not park). ---
  {
    const repo = makeRepo({ 'a.txt': 'a\n' })
    const store = { get: () => undefined, save: () => {}, remove: () => {} }
    initChatIsolation({
      worktreesDir: () => join(base, 'wt'),
      store: () => store,
      getWindow: () => null
    })
    const key = 'live-commit-test'
    const cwd = await isolatedCwd(repo, key)
    ok(cwd !== repo, `the chat got its own worktree (got ${cwd})`)
    const branch = `trezi/chat-${cwd.split('/').at(-1)}`
    ok(!branchExists(repo, branch), 'an idle chat does not retain a stale branch')

    /** afterTurn is fire-and-forget (queued on the chat's chain) — wait for the commit. */
    const waitForCommits = async (want) => {
      for (let i = 0; i < 200; i++) {
        if (log(repo).length >= want) return true
        await new Promise((r) => setTimeout(r, 25))
      }
      return false
    }

    await beforeTurn(key, 'first')
    ok(branchExists(repo, branch), 'the branch is attached before the turn can edit')
    writeFileSync(join(cwd, 'a.txt'), 'turn one\n')
    afterTurn(key, 'make the header blue', [])
    ok(await waitForCommits(2), 'turn 1 committed on the live checkout')
    ok(
      await waitFor(() => !branchExists(repo, branch)),
      'a successfully landed turn deletes its branch'
    )
    ok(log(repo)[0] === 'Update a.txt', `turn 1 subject describes the change (got ${log(repo)[0]})`)

    await beforeTurn(key, 'next')
    ok(branchExists(repo, branch), 'the next turn recreates the recovery branch')
    writeFileSync(join(cwd, 'b.txt'), 'turn two\n')
    afterTurn(key, 'add a footer', [])
    ok(await waitForCommits(3), 'turn 2 committed too (it merged, i.e. did not park)')
    ok(log(repo)[0] === 'Add b.txt', `turn 2 subject describes the change (got ${log(repo)[0]})`)
    ok(commitFiles(repo).join(',') === 'b.txt', 'turn 2 commits only its own file')
    ok(porcelain(repo).length === 0, 'the live checkout is clean between turns')
    ok(
      await waitFor(() => !branchExists(repo, branch)),
      'the second successful landing deletes the branch again'
    )

    await releaseChat(key)
  }

  // --- 9. Two chats landing together share one repository writer. Both commits must
  // survive; before the repo queue, their per-chat chains raced through the same live
  // index and one commit was commonly swallowed by commitLiveTurn's best-effort catch. ---
  {
    const repo = makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
    const store = { get: () => undefined, save: () => {}, remove: () => {} }
    initChatIsolation({
      worktreesDir: () => join(base, 'wt-concurrent'),
      store: () => store,
      getWindow: () => null
    })
    const one = 'concurrent-one'
    const two = 'concurrent-two'
    const [cwdOne, cwdTwo] = await Promise.all([isolatedCwd(repo, one), isolatedCwd(repo, two)])
    await Promise.all([beforeTurn(one, 'edit a'), beforeTurn(two, 'edit b')])
    writeFileSync(join(cwdOne, 'a.txt'), 'one\n')
    writeFileSync(join(cwdTwo, 'b.txt'), 'two\n')
    afterTurn(one, 'concurrent one', [])
    afterTurn(two, 'concurrent two', [])
    for (let i = 0; i < 200 && log(repo).length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    ok(log(repo).length === 3, `both concurrent turns committed (got ${log(repo).length - 1})`)
    ok(g(repo, 'show', 'HEAD:a.txt') === 'one\n', 'chat one landed')
    ok(g(repo, 'show', 'HEAD:b.txt') === 'two\n', 'chat two landed')
    ok(porcelain(repo).length === 0, 'concurrent landings leave no live index debris')
    ok(
      await waitFor(() => g(repo, 'branch', '--list', 'trezi/chat-*').trim() === ''),
      'successful concurrent landings leave no chat branches'
    )
    await Promise.all([releaseChat(one), releaseChat(two)])
  }

  // --- 10. Failed terminal outcomes park partial work and keep it out of live. ---
  {
    const repo = makeRepo({ 'a.txt': 'a\n' })
    const store = { get: () => undefined, save: () => {}, remove: () => {} }
    initChatIsolation({
      worktreesDir: () => join(base, 'wt-failed'),
      store: () => store,
      getWindow: () => null
    })
    const key = 'failed-terminal'
    const cwd = await isolatedCwd(repo, key)
    const branch = `trezi/chat-${cwd.split('/').at(-1)}`
    await beforeTurn(key, 'partial edit')
    writeFileSync(join(cwd, 'a.txt'), 'partial\n')
    afterTurn(key, 'partial edit', [], 'failed')
    ok(
      await waitFor(() => {
        try {
          return g(repo, 'show', `${branch}:a.txt`) === 'partial\n'
        } catch {
          return false
        }
      }),
      'failed work is committed durably on its recovery branch'
    )
    ok(g(repo, 'show', 'HEAD:a.txt') === 'a\n', 'failed work is not committed live')
    ok(porcelain(repo).length === 0, 'failed work is not written into the live checkout')
    ok((await discardParkedChat(key)).ok, 'the failed parked turn can be discarded')
    ok(await waitFor(() => !branchExists(repo, branch)), 'discard deletes the failed-turn branch')
    await releaseChat(key)
  }

  // --- 10b. LKM-189: a parked turn and the next one re-squash into one commit whose
  // message is regenerated for the combined diff, through a mocked background model;
  // the prompt never reaches the subject and the trailers close the body. ---
  {
    const repo = makeRepo({ 'a.txt': 'a\n' })
    const store = { get: () => undefined, save: () => {}, remove: () => {} }
    const asked = []
    initChatIsolation({
      worktreesDir: () => join(base, 'wt-described'),
      store: () => store,
      getWindow: () => null,
      describe: () => async (prompt) => {
        asked.push(prompt)
        const files = [...prompt.matchAll(/^(?:added|modified|deleted) (\S+)$/gm)].map((m) => m[1])
        return `Change ${files.join(' and ')}\n\n- Rework the fixture files`
      }
    })
    const key = 'described-squash'
    const cwd = await isolatedCwd(repo, key)
    const branch = `trezi/chat-${cwd.split('/').at(-1)}`
    await beforeTurn(key, 'first')
    writeFileSync(join(cwd, 'a.txt'), 'held\n')
    await afterTurn(key, 'PRIVATE PROMPT one [Attached files]', [], 'failed')
    ok(
      g(repo, 'log', '-1', '--format=%s', branch).trim() === 'Change a.txt',
      'the parked squash is described'
    )
    await beforeTurn(key, 'second')
    writeFileSync(join(cwd, 'b.txt'), 'new\n')
    await afterTurn(key, 'PRIVATE PROMPT two', [
      { role: 'user', text: 'PRIVATE PROMPT two' },
      { role: 'assistant', text: 'Reworked both fixture files.' }
    ])
    ok(asked.length === 2, `one description per squash (got ${asked.length})`)
    ok(/modified a\.txt/.test(asked[1]) && /added b\.txt/.test(asked[1]), 'combined diff')
    ok(asked[1].includes('Reworked both fixture files.'), "the agent's reply is shown")
    ok(!asked.join('\n').includes('PRIVATE PROMPT'), 'the prompt is never shown')
    ok(log(repo)[0] === 'Change a.txt and b.txt', `combined subject (got ${log(repo)[0]})`)
    ok(commitFiles(repo).sort().join(',') === 'a.txt,b.txt', 'one cumulative live commit')
    const body = g(repo, 'log', '-1', '--format=%b').trim()
    ok(
      body.endsWith(`Trezi-Turn: 2\nTrezi-Chat: ${branch}`) &&
        body.startsWith('- Rework the fixture files'),
      `bullets, then trailers (got ${JSON.stringify(body)})`
    )
    await releaseChat(key)
  }

  // --- 11. Committed turns must stay PUBLISHABLE (`publish-scope.ts`). A session whose
  // turns all committed leaves a spotless working tree, so the old "diff vs HEAD" scope
  // would have reported nothing to publish and shipped an empty file list in the PR. ---
  {
    const repo = makeRepo({ 'a.txt': 'a\n' })
    ok((await defaultBase(repo)) === 'main', 'defaultBase falls back to main with no origin')
    ok((await changedSince(repo)).length === 0, 'a clean checkout on the base branch: nothing')

    g(repo, 'checkout', '-q', '-b', 'trezi/main')
    writeFileSync(join(repo, 'a.txt'), 'turn 1\n')
    await commitLiveTurn(repo, ['a.txt'], { title: 'turn one' })
    writeFileSync(join(repo, 'b.txt'), 'turn 2\n')
    await commitLiveTurn(repo, ['b.txt'], { title: 'turn two' })
    ok(porcelain(repo).length === 0, 'the work is fully committed (nothing vs HEAD)')
    const scope = await changedSince(repo)
    ok(
      scope.length === 2 && scope.includes('a.txt') && scope.includes('b.txt'),
      `both committed turns are still in scope (got ${scope.join(',')})`
    )
    ok((await aheadOfBase(repo, 'main')) === 2, 'ahead-of-base sees the two turn commits')

    // …and an uncommitted hand edit on top still counts (two-dot diff vs the WORKING tree).
    writeFileSync(join(repo, 'c.txt'), 'by hand\n')
    g(repo, 'add', 'c.txt')
    ok((await changedSince(repo)).includes('c.txt'), 'uncommitted work is still in scope')
    ok((await aheadOfBase(repo, 'nope')) === 0, 'an unresolvable base is 0, not a throw')
  }
} finally {
  rmSync(base, { recursive: true, force: true })
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('live-commit: OK')
