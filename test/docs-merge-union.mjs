/**
 * The repo's .gitattributes makes docs/TASKS.md, docs/PROGRESS.md and CHANGELOG.md union-merge:
 * two branches that each append different lines merge cleanly and keep both sets.
 * Uses a disposable repo carrying this checkout's .gitattributes.
 *
 * Run with: bun test/docs-merge-union.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const repo = mkdtempSync(join(tmpdir(), 'trezi-union-'))
const git = (...args) => {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Trezi Test',
      '-c',
      'user.email=test@trezi.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args
    ],
    { cwd: repo, encoding: 'utf8' }
  )
  return { ...result, ok: result.status === 0 }
}
const must = (...args) => {
  const r = git(...args)
  assert.ok(r.ok, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

try {
  must('init', '-q', '-b', 'main')
  copyFileSync(join(root, '.gitattributes'), join(repo, '.gitattributes'))
  mkdirSync(join(repo, 'docs'))
  const files = ['docs/TASKS.md', 'docs/PROGRESS.md', 'CHANGELOG.md']
  for (const file of files) writeFileSync(join(repo, file), '# Log\n\n- [x] Base entry\n')
  must('add', '-A')
  must('commit', '-q', '-m', 'base')
  const append = (branch, lines) => {
    must('checkout', '-q', '-b', branch, 'main')
    for (const file of files)
      writeFileSync(
        join(repo, file),
        readFileSync(join(repo, file), 'utf8') + lines.join('\n') + '\n'
      )
    must('commit', '-q', '-am', branch)
  }
  const first = ['- [ ] Branch A task one', '- [x] Branch A task two']
  const second = ['- [ ] Branch B task one', '- [ ] Branch B task two', '- [x] Branch B task three']
  append('a', first)
  append('b', second)
  must('checkout', '-q', 'a')
  const merge = git('merge', '--no-edit', 'b')
  assert.ok(merge.ok, `Union merge must not conflict: ${merge.stdout}${merge.stderr}`)
  assert.equal(must('status', '--porcelain'), '', 'Merge leaves a clean tree')
  for (const file of files) {
    assert.equal(must('check-attr', 'merge', file).trim(), `${file}: merge: union`)
    const merged = readFileSync(join(repo, file), 'utf8')
    for (const line of ['- [x] Base entry', ...first, ...second])
      assert.ok(merged.includes(`${line}\n`), `${file} kept "${line}"`)
    assert.equal(
      merged.split('\n').filter((line) => line === '- [x] Base entry').length,
      1,
      `${file} base entry not duplicated`
    )
  }
  console.log(
    'Docs union merge: TASKS.md, PROGRESS.md and CHANGELOG.md appends from two branches merged cleanly, both kept.'
  )
} finally {
  rmSync(repo, { recursive: true, force: true })
}
