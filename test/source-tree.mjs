// LOCAL-WEBKIT-3: a snapshot's `tree` is the Git tree the same bytes commit to. It is
// checked against Git's own answer (a private index: read-tree HEAD, add -A, excluded
// paths back to HEAD, write-tree) across edits, nested adds, deletions, emptied
// directories, the exec bit, symlinks, file/directory swaps, excluded `.env.local`, an
// unborn repository, and it must not change when those bytes are committed.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sourceSnapshot } from '../src/main/source-snapshot.ts'
import { candidateTree } from '../src/main/source-tree.ts'

const scratch = mkdtempSync(join(tmpdir(), 'trezi-source-tree-'))
const git = (repo, args, env = {}) =>
  execFileSync('git', ['-C', repo, ...args], {
    stdio: 'pipe',
    env: { ...process.env, ...env }
  })
    .toString()
    .trim()
const commit = (repo) =>
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c', '--allow-empty'])

/** Git's own candidate tree, written through a throwaway index. */
function gitTree(repo) {
  const index = join(scratch, `index-${Math.random().toString(36).slice(2)}`)
  const env = { GIT_INDEX_FILE: index }
  let head = ''
  try {
    head = git(repo, ['rev-parse', '--verify', '-q', 'HEAD'])
  } catch {}
  if (head) git(repo, ['read-tree', 'HEAD'], env)
  git(repo, ['add', '-A'], env)
  // The owner's unstageExcluded: these paths keep HEAD's entry.
  const staged = git(
    repo,
    ['diff', '--cached', '--name-only', '-z', ...(head ? ['HEAD'] : [])],
    env
  )
  for (const path of staged.split('\0').filter(Boolean)) {
    if (!/(^|\/)(\.env(\.[^/]*)?|node_modules)(\/|$)/.test(path)) continue
    if (/\.env\.(example|sample|template)$/.test(path)) continue
    git(repo, ['rm', '-q', '--cached', '--ignore-unmatch', '--', path], env)
    if (head) git(repo, ['reset', '-q', 'HEAD', '--', path], env)
  }
  const tree = git(repo, ['write-tree'], env)
  rmSync(index, { force: true })
  return tree
}

async function same(repo, label) {
  const snap = await sourceSnapshot(repo)
  assert.ok(snap.id, `${label}: snapshot id`)
  assert.equal(snap.tree, gitTree(repo), `${label}: tree matches Git`)
  return snap
}

try {
  // Unborn repository: no HEAD yet.
  const unborn = join(scratch, 'unborn')
  mkdirSync(join(unborn, 'src/deep'), { recursive: true })
  git(scratch, ['init', '-q', unborn])
  writeFileSync(join(unborn, 'a.txt'), 'a\n')
  writeFileSync(join(unborn, 'src/deep/b.ts'), 'export {}\n')
  await same(unborn, 'unborn')

  const repo = join(scratch, 'repo')
  git(scratch, ['init', '-q', repo])
  mkdirSync(join(repo, 'src/a/b'), { recursive: true })
  mkdirSync(join(repo, 'docs'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), 'readme\n')
  writeFileSync(join(repo, 'src/a/b/one.ts'), 'one\n')
  writeFileSync(join(repo, 'src/a/two.ts'), 'two\n')
  writeFileSync(join(repo, 'src/a-b.ts'), 'sibling sorts before a/\n')
  writeFileSync(join(repo, 'docs/guide.md'), 'guide\n')
  writeFileSync(join(repo, 'swap'), 'file then dir\n')
  mkdirSync(join(repo, 'dir2file'))
  writeFileSync(join(repo, 'dir2file/x'), 'x\n')
  writeFileSync(join(repo, '.env.example'), 'KEY=\n')
  git(repo, ['add', '-A'])
  commit(repo)

  const clean = await same(repo, 'clean')
  assert.equal(clean.tree, git(repo, ['rev-parse', 'HEAD^{tree}']), 'clean tree is HEAD tree')

  writeFileSync(join(repo, 'src/a/b/one.ts'), 'one changed\n')
  await same(repo, 'modify nested')
  mkdirSync(join(repo, 'src/new/deeper'), { recursive: true })
  writeFileSync(join(repo, 'src/new/deeper/three.ts'), 'three\n')
  await same(repo, 'nested add')
  unlinkSync(join(repo, 'docs/guide.md'))
  await same(repo, 'emptied directory')
  writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\n')
  chmodSync(join(repo, 'run.sh'), 0o755)
  chmodSync(join(repo, 'src/a/two.ts'), 0o755)
  await same(repo, 'exec bit')
  // Git's rule is the owner execute bit alone: 0744 is 100755, 0654 is 100644. The id
  // and the cached tree must both follow it, or a chmod would keep a stale cached tree.
  writeFileSync(join(repo, 'mode.sh'), '#!/bin/sh\n')
  chmodSync(join(repo, 'mode.sh'), 0o744)
  const owner = await same(repo, 'mode 0744')
  chmodSync(join(repo, 'mode.sh'), 0o654)
  const group = await same(repo, 'mode 0654')
  assert.notEqual(group.id, owner.id, '0744 -> 0654 changes the snapshot id')
  assert.notEqual(group.tree, owner.tree, '0744 -> 0654 changes the candidate tree')
  chmodSync(join(repo, 'mode.sh'), 0o744)
  assert.equal((await same(repo, 'mode 0744 again')).tree, owner.tree, 'and back')
  unlinkSync(join(repo, 'mode.sh'))
  symlinkSync('src/a/two.ts', join(repo, 'link'))
  await same(repo, 'symlink')
  unlinkSync(join(repo, 'swap'))
  mkdirSync(join(repo, 'swap'))
  writeFileSync(join(repo, 'swap/inner.txt'), 'now a dir\n')
  rmSync(join(repo, 'dir2file'), { recursive: true })
  writeFileSync(join(repo, 'dir2file'), 'now a file\n')
  await same(repo, 'file/dir swaps')
  writeFileSync(join(repo, '.env.local'), 'SECRET=1\n')
  writeFileSync(join(repo, '.env.example'), 'KEY=\nOTHER=\n')
  const dirty = await same(repo, 'excluded .env.local')

  // Committing the same bytes (as the owner's completeTurn does) keeps the tree.
  git(repo, ['add', '-A'])
  git(repo, ['rm', '-q', '--cached', '.env.local'])
  commit(repo)
  const after = await sourceSnapshot(repo)
  assert.notEqual(after.id, dirty.id, 'the snapshot id names HEAD')
  assert.equal(after.tree, dirty.tree, 'commit keeps the candidate tree')
  assert.equal(git(repo, ['rev-parse', 'HEAD^{tree}']), dirty.tree, 'HEAD^{tree} is the candidate')

  // A path Git cannot round-trip through the batch reader is refused, never guessed.
  await assert.rejects(
    candidateTree(repo, git(repo, ['rev-parse', 'HEAD']), [
      { path: 'bad\nname', mode: '100644', oid: '0'.repeat(40) }
    ])
  )
  console.log('source-tree: PASS')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
