// LKM-364: the editor's read-only Changes list. Committed changes since the merge-base
// with the default branch stay apart from staged, unstaged and untracked ones, with +/-
// counts and a labelled base; Git only reads; edge cases (no Git, no upstream, detached,
// unborn, rename/delete/binary, large, subfolder project) are labelled; a click opens
// LKM-363's editor path, per project, keeping drafts.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchDiff, DIFF_LIMITS, gitRead, READ_ONLY_GIT } from '../src/main/branch-diff.ts'
import { NativeEditorController } from '../src/native/editor-controller.ts'

const temp = mkdtempSync(join(tmpdir(), 'trezi-branch-diff-'))
const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(temp, 'gitconfig'),
  GIT_AUTHOR_NAME: 'Trezi Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Trezi Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid'
}
writeFileSync(ENV.GIT_CONFIG_GLOBAL, '')
const repo = (name) => {
  const dir = join(temp, name)
  mkdirSync(dir, { recursive: true })
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ENV }).trim()
  const write = (file, text) => {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return { dir, git, write }
}
const lines = (n, prefix = 'line') =>
  `${Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n')}\n`
const section = (diff, kind) => diff.sections.find((s) => s.kind === kind)
const byPath = (diff, kind) => Object.fromEntries(section(diff, kind).files.map((f) => [f.path, f]))
// Every read goes through the allowlisted runner; the recording proves which commands ran.
const recorded = []
const recording = (root, args, max) => {
  recorded.push(args[0])
  return gitRead(root, args, max)
}

try {
  // --- The runner reads only ---------------------------------------------------------------
  for (const verb of [
    'commit',
    'add',
    'reset',
    'checkout',
    'stash',
    'push',
    'update-index',
    'status',
    'restore',
    'apply'
  ])
    await assert.rejects(gitRead(temp, [verb]), /is not a read/, verb)
  assert.deepEqual([...READ_ONLY_GIT].sort(), [
    'diff',
    'ls-files',
    'merge-base',
    'rev-parse',
    'symbolic-ref'
  ])

  // --- Not a Git project ---------------------------------------------------------------------
  const plain = repo('plain')
  plain.write('a.txt', 'a\n')
  const none = await branchDiff(plain.dir, recording)
  assert.equal(none.git, false)
  assert.deepEqual(none.sections, [])
  assert.equal(none.base, null)
  assert.match(none.message, /not in a Git repository/)
  assert.throws(() => statSync(join(plain.dir, '.git')), 'nothing was initialised')

  // --- A feature branch off origin/main ------------------------------------------------------
  const { dir, git, write } = repo('project')
  git('init', '-q', '-b', 'main')
  write('a.txt', lines(10))
  write('b.txt', 'b\n')
  write('c.txt', 'c\n')
  write('old name.txt', lines(5, 'kept'))
  write('gone.txt', 'gone\n')
  write('many.txt', lines(200))
  git('add', '-A')
  git('commit', '-qm', 'base')
  const fork = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', fork)
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git('checkout', '-qb', 'feature')
  write('a.txt', lines(10).replace('line 3\n', 'line three\nline 3b\n'))
  git('mv', 'old name.txt', 'new name.txt')
  git('rm', '-q', 'gone.txt')
  writeFileSync(join(dir, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  // 66 separate one-line edits (every third line): more hunks than one file lists.
  const every3 = Array.from({ length: 200 }, (_, i) =>
    i % 3 === 2 ? `edited ${i + 1}` : `line ${i + 1}`
  )
  write('many.txt', `${every3.join('\n')}\n`)
  git('add', '-A')
  git('commit', '-qm', 'feature work')
  // origin/main moves on after the fork: its change is not this branch's.
  git(
    'update-ref',
    'refs/remotes/origin/main',
    git('commit-tree', `${fork}^{tree}`, '-p', fork, '-m', 'later on main')
  )
  write('b.txt', 'b\nstaged\n')
  git('add', 'b.txt')
  write('c.txt', 'c changed\n')
  write('untracked.txt', lines(3))
  writeFileSync(join(dir, 'untracked.bin'), Buffer.from([0, 0, 1]))
  write('.gitignore', 'ignored.log\n')
  write('ignored.log', 'x\n')

  const state = () => ({
    index: readFileSync(join(dir, '.git/index')),
    indexTime: statSync(join(dir, '.git/index')).mtimeMs,
    head: readFileSync(join(dir, '.git/HEAD'), 'utf8'),
    refs: git('for-each-ref', '--format=%(refname) %(objectname)'),
    // The check itself must not refresh the index (plain `git status` may rewrite it).
    status: git('--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    lock: (() => {
      try {
        return statSync(join(dir, '.git/index.lock')) && 'locked'
      } catch {
        return 'none'
      }
    })()
  })
  const before = state()
  recorded.length = 0
  const diff = await branchDiff(dir, recording)
  assert.deepEqual(state(), before, 'the index, HEAD, refs and work tree are untouched')
  assert.ok(
    recorded.length && recorded.every((verb) => READ_ONLY_GIT.has(verb)),
    recorded.join(' ')
  )

  assert.equal(diff.git, true)
  assert.equal(diff.branch, 'feature')
  assert.equal(diff.detached, false)
  assert.equal(diff.head, git('rev-parse', '--short=7', 'HEAD'))
  assert.deepEqual(diff.base, {
    ref: 'origin/main',
    sha: fork.slice(0, 7),
    label: `Base: merge-base with origin/main @ ${fork.slice(0, 7)}`,
    fallback: false
  })
  assert.deepEqual(
    diff.sections.map((s) => s.kind),
    ['committed', 'staged', 'unstaged', 'untracked']
  )
  for (const s of diff.sections) assert.ok(s.label, `${s.kind} is labelled`)
  assert.match(section(diff, 'committed').label, new RegExp(`${fork.slice(0, 7)}.*origin/main`))
  assert.match(section(diff, 'staged').label, /uncommitted/)

  const committed = byPath(diff, 'committed')
  assert.deepEqual(Object.keys(committed).sort(), [
    'a.txt',
    'gone.txt',
    'img.bin',
    'many.txt',
    'new name.txt'
  ])
  assert.deepEqual(
    { ...committed['a.txt'], hunks: committed['a.txt'].hunks },
    {
      path: 'a.txt',
      status: 'modified',
      added: 2,
      removed: 1,
      binary: false,
      hunks: [{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 2 }]
    }
  )
  assert.equal(committed['new name.txt'].status, 'renamed')
  assert.equal(committed['new name.txt'].from, 'old name.txt')
  assert.deepEqual([committed['new name.txt'].added, committed['new name.txt'].removed], [0, 0])
  assert.equal(committed['gone.txt'].status, 'deleted')
  assert.deepEqual([committed['gone.txt'].added, committed['gone.txt'].removed], [0, 1])
  assert.deepEqual(
    [committed['img.bin'].status, committed['img.bin'].binary, committed['img.bin'].added],
    ['added', true, null]
  )
  assert.equal(committed['many.txt'].hunks.length, DIFF_LIMITS.hunks, 'hunks are bounded')
  assert.equal(section(diff, 'committed').truncated, true)
  // a.txt 2 + many.txt 66; the rename, the deletion and the binary add none.
  assert.equal(section(diff, 'committed').added, 2 + 66)
  assert.equal(section(diff, 'committed').removed, 1 + 1 + 66)

  assert.deepEqual(Object.keys(byPath(diff, 'staged')), ['b.txt'])
  assert.deepEqual(
    [byPath(diff, 'staged')['b.txt'].added, byPath(diff, 'staged')['b.txt'].removed],
    [1, 0]
  )
  assert.deepEqual(Object.keys(byPath(diff, 'unstaged')), ['c.txt'])
  assert.deepEqual(byPath(diff, 'unstaged')['c.txt'].hunks, [
    { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }
  ])
  const untracked = byPath(diff, 'untracked')
  assert.deepEqual(Object.keys(untracked).sort(), ['.gitignore', 'untracked.bin', 'untracked.txt'])
  assert.deepEqual([untracked['untracked.txt'].added, untracked['untracked.txt'].removed], [3, 0])
  assert.equal(untracked['untracked.bin'].binary, true)

  // --- Detached HEAD: still compared with the merge-base, and said so ----------------------
  git('checkout', '-q', '--detach')
  const detached = await branchDiff(dir)
  assert.equal(detached.detached, true)
  assert.equal(detached.branch, '')
  assert.match(detached.message, /Detached HEAD at [0-9a-f]{7}/)
  assert.equal(detached.base.ref, 'origin/main')
  git('checkout', '-q', 'feature')

  // --- A project in a subfolder sees only its own files ------------------------------------
  write('site/index.html', '<p>a</p>\n')
  git('add', 'site/index.html')
  write('site/page.css', 'p {}\n')
  const sub = await branchDiff(join(dir, 'site'))
  assert.deepEqual(
    sub.sections.map((s) => [s.kind, s.files.map((f) => f.path)]),
    [
      ['committed', []],
      ['staged', ['index.html']],
      ['unstaged', []],
      ['untracked', ['page.css']]
    ]
  )

  // --- No origin: the local default branch, then HEAD with a clear label ------------------
  const local = repo('local-main')
  local.git('init', '-q', '-b', 'main')
  local.write('x.txt', 'x\n')
  local.git('add', '-A')
  local.git('commit', '-qm', 'x')
  local.git('checkout', '-qb', 'topic')
  local.write('x.txt', 'x\ny\n')
  local.git('commit', '-qam', 'y')
  const localDiff = await branchDiff(local.dir)
  assert.equal(localDiff.base.ref, 'main')
  assert.equal(localDiff.base.fallback, false)
  assert.deepEqual(Object.keys(byPath(localDiff, 'committed')), ['x.txt'])

  const lone = repo('no-upstream')
  lone.git('init', '-q', '-b', 'trunk')
  lone.write('t.txt', 't\n')
  lone.git('add', '-A')
  lone.git('commit', '-qm', 't')
  lone.write('t.txt', 't\nu\n')
  const loneDiff = await branchDiff(lone.dir)
  assert.equal(loneDiff.base.fallback, true)
  assert.equal(loneDiff.base.ref, 'HEAD')
  assert.match(
    loneDiff.base.label,
    /HEAD @ [0-9a-f]{7}.*no default branch found.*origin\/main, main/
  )
  assert.deepEqual(section(loneDiff, 'committed').files, [])
  assert.match(section(loneDiff, 'committed').label, /no base branch/)
  assert.deepEqual(Object.keys(byPath(loneDiff, 'unstaged')), ['t.txt'])

  // --- Before the first commit ---------------------------------------------------------------
  const fresh = repo('unborn')
  fresh.git('init', '-q', '-b', 'main')
  fresh.write('first.txt', 'one\ntwo\n')
  fresh.git('add', 'first.txt')
  const unborn = await branchDiff(fresh.dir)
  assert.equal(unborn.head, '')
  assert.equal(unborn.base, null)
  assert.match(unborn.message, /No commits yet/)
  assert.deepEqual(
    unborn.sections.map((s) => s.kind),
    ['staged', 'unstaged', 'untracked']
  )
  assert.deepEqual(byPath(unborn, 'staged')['first.txt'].added, 2)

  // --- Large: a bounded file list ------------------------------------------------------------
  const big = repo('large')
  big.git('init', '-q', '-b', 'main')
  for (let i = 0; i < DIFF_LIMITS.files + 20; i++)
    big.write(`f/${String(i).padStart(4, '0')}.txt`, 'x\n')
  const large = await branchDiff(big.dir)
  assert.equal(section(large, 'untracked').files.length, DIFF_LIMITS.files)
  assert.equal(section(large, 'untracked').truncated, true)

  // --- The editor: per project, read-only, LKM-363's open path, drafts kept -----------------
  const outside = join(temp, 'outside.txt')
  writeFileSync(outside, 'secret\n')
  symlinkSync(outside, join(dir, 'escape.txt'))
  const beforeEditor = state()
  const calls = []
  const states = []
  let slow = null
  const reads = {
    [dir]: () => branchDiff(dir),
    [lone.dir]: () => (slow ? slow.promise : branchDiff(lone.dir))
  }
  const editor = new NativeEditorController(
    async (channel, root, source) => {
      calls.push(channel)
      if (channel === 'source:tree') return []
      if (channel === 'source:read') {
        const file = source.replace(/:\d+(?::\d+)?$/, '')
        return { file, code: readFileSync(join(root, file), 'utf8'), line: 1 }
      }
    },
    (s) => states.push(structuredClone(s)),
    undefined,
    (root) => reads[root]()
  )
  const at = (root) => editor.session(root).state
  await editor.action({ root: dir, action: 'panel', panel: 'changes' })
  assert.equal(at(dir).panel, 'changes')
  assert.equal(at(dir).diff.root, dir)
  assert.equal(at(dir).diffBusy, false)
  assert.equal(at(lone.dir).diff, null, 'another project has no list of its own yet')
  assert.equal(at(lone.dir).panel, 'files')

  // A file click opens its first hunk; a hunk click that hunk, both highlighted exactly.
  await editor.action({ root: dir, action: 'diff-open', source: 'a.txt', section: 'committed' })
  assert.equal(at(dir).source, 'a.txt')
  assert.deepEqual(at(dir).range, { startLine: 3, endLine: 4 })
  await editor.action({
    root: dir,
    action: 'diff-open',
    source: 'many.txt',
    section: 'committed',
    hunk: 1
  })
  assert.deepEqual(at(dir).range, { startLine: 6, endLine: 6 })
  // A dirty draft stays: the range is found in it, and nothing is saved.
  const draft = `// draft\n${readFileSync(join(dir, 'a.txt'), 'utf8')}`
  await editor.action({ root: dir, action: 'open', source: 'a.txt' })
  await editor.action({ root: dir, action: 'edit', source: 'a.txt', revision: 99, text: draft })
  await editor.action({ root: dir, action: 'diff-open', source: 'a.txt', section: 'committed' })
  assert.equal(at(dir).text, draft)
  assert.equal(at(dir).dirty, true)
  assert.deepEqual(at(dir).range, { startLine: 4, endLine: 5 })
  // Untracked and binary files open at the top; deleted, unlisted and escaping ones refuse.
  await editor.action({
    root: dir,
    action: 'diff-open',
    source: 'untracked.txt',
    section: 'untracked'
  })
  assert.equal(at(dir).source, 'untracked.txt')
  await editor.action({ root: dir, action: 'diff-open', source: 'gone.txt', section: 'committed' })
  assert.match(at(dir).error, /gone\.txt was deleted/)
  await editor.action({ root: dir, action: 'diff-open', source: 'b.txt', section: 'committed' })
  assert.match(at(dir).error, /no longer in the Changes list/)
  at(dir).diff.sections[3].files.push({
    path: 'escape.txt',
    status: 'untracked',
    added: 1,
    removed: 0,
    binary: false,
    hunks: []
  })
  at(dir).diff.sections[3].files.push({
    path: '../outside.txt',
    status: 'untracked',
    added: 1,
    removed: 0,
    binary: false,
    hunks: []
  })
  for (const source of ['escape.txt', '../outside.txt']) {
    const opened = at(dir).source
    await editor.action({ root: dir, action: 'diff-open', source, section: 'untracked' })
    assert.match(at(dir).error, /Not opened in the editor/, source)
    assert.equal(at(dir).source, opened, `${source} opened nothing`)
  }
  const writes = calls.filter(
    (c) => !['source:tree', 'source:read', 'source:drafts', 'source:save-draft'].includes(c)
  )
  assert.deepEqual(writes, [], 'viewing and opening changes only read')
  assert.deepEqual(state(), beforeEditor, 'still no Git or file change')

  // Project switch: each project's list is its own; a stale read never lands.
  let release
  slow = { promise: new Promise((resolve) => (release = resolve)) }
  const stale = editor.action({ root: lone.dir, action: 'panel', panel: 'changes' })
  slow = null
  await editor.action({ root: lone.dir, action: 'diff-refresh' })
  release({ ...loneDiff, message: 'stale' })
  await stale
  assert.equal(at(lone.dir).diff.root, lone.dir)
  assert.notEqual(at(lone.dir).diff.message, 'stale', 'the older read was dropped')
  assert.equal(at(dir).diff.root, dir, 'the first project keeps its own list')
  assert.ok(
    states.every((s) => !s.diff || s.diff.root === s.root),
    'a published list always belongs to its own project'
  )
  console.log(
    'BRANCH-DIFF OK — merge-base base label, committed vs staged/unstaged/untracked, +/- counts, rename/delete/binary, bounded, non-git, no upstream, detached, unborn, subfolder, read-only git, per-project editor open with drafts kept'
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}
