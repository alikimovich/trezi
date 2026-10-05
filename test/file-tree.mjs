/**
 * file-tree.ts unit test (pure — no Electron). listProjectFiles feeds the pop-out
 * editor's `@pierre/trees` sidebar, so it must return repo-relative, POSIX-separated
 * file paths (the tree keys on path strings), sorted, with build/VCS dirs excluded.
 *
 * Asserts: a git repo lists tracked AND untracked-but-not-ignored files while a
 * .gitignore'd path is dropped; a non-git folder falls back to a filesystem walk
 * that skips node_modules and friends; both paths are POSIX-separated and sorted.
 * Uses real temp dirs (one git, one plain).
 *
 * Run with: bun run test:file-tree
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listProjectFiles } from '../src/main/file-tree.ts'

const base = mkdtempSync(join(tmpdir(), 'file-tree-'))
let failed = 0
const ok = (cond, msg) => {
  if (!cond) failed++, console.error('  ✗', msg)
}

try {
  // --- git repo: tracked + untracked, .gitignore respected, node_modules absent ---
  const repo = join(base, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\nbuilt.log\n')
  writeFileSync(join(repo, 'README.md'), '# hi')
  writeFileSync(join(repo, 'src', 'index.ts'), 'export {}')
  writeFileSync(join(repo, 'node_modules', 'dep', 'x.js'), '1')
  writeFileSync(join(repo, 'built.log'), 'ignored')
  const git = (...a) => execFileSync('git', a, { cwd: repo })
  git('init', '-q')
  git('add', 'README.md', 'src/index.ts')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  // Leave an untracked-but-not-ignored file — must still appear.
  writeFileSync(join(repo, 'src', 'untracked.ts'), 'export {}')

  const files = await listProjectFiles(repo)
  ok(files.includes('README.md'), 'tracked file listed')
  ok(files.includes('src/index.ts'), 'tracked nested file listed')
  ok(files.includes('src/untracked.ts'), 'untracked-not-ignored file listed')
  ok(!files.some((f) => f.startsWith('node_modules/')), 'node_modules excluded via .gitignore')
  ok(!files.includes('built.log'), 'gitignored file excluded')
  ok(!files.some((f) => f.includes('\\')), 'git paths are POSIX-separated')
  ok(
    JSON.stringify(files) === JSON.stringify([...files].sort((a, b) => a.localeCompare(b))),
    'git paths sorted'
  )

  // --- non-git folder: fs-walk fallback, heavy dirs skipped ---
  const plain = join(base, 'plain')
  mkdirSync(join(plain, 'sub'), { recursive: true })
  mkdirSync(join(plain, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(plain, 'dist'), { recursive: true })
  writeFileSync(join(plain, 'a.txt'), '1')
  writeFileSync(join(plain, 'sub', 'b.txt'), '2')
  writeFileSync(join(plain, 'node_modules', 'x', 'c.js'), '3')
  writeFileSync(join(plain, 'dist', 'out.js'), '4')

  const walked = await listProjectFiles(plain)
  ok(walked.length === 2, `walk lists exactly the two real files (got ${walked.length})`)
  ok(walked.includes('a.txt') && walked.includes('sub/b.txt'), 'walk lists both real files')
  ok(!walked.some((f) => f.startsWith('node_modules/')), 'walk skips node_modules')
  ok(!walked.some((f) => f.startsWith('dist/')), 'walk skips dist')
  ok(
    JSON.stringify(walked) === JSON.stringify([...walked].sort((a, b) => a.localeCompare(b))),
    'walk paths sorted'
  )

  if (failed === 0) console.log('FILE-TREE OK — git ls-files + fs-walk fallback, POSIX, sorted')
  else console.error(`FILE-TREE: ${failed} assertion(s) failed`)
  process.exitCode = failed === 0 ? 0 : 1
} catch (err) {
  console.error('FILE-TREE FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(base, { recursive: true, force: true })
}
