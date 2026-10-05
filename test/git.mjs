/**
 * Branch management against a real temp git repo, through the Swift repository owner.
 * Run by test/repository-owner.mjs with the owner preloaded.
 */
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkoutBranch,
  ensureBranch,
  getCurrentBranch,
  isGitRepo,
  normalizeBranchName,
  switchBranch
} from '../src/main/git.ts'

// --- pure name coercion: always a git-ref-safe trezi/<…> ---
assert.equal(normalizeBranchName('feature x'), 'trezi/feature-x')
assert.equal(normalizeBranchName('trezi/foo'), 'trezi/foo')
assert.equal(normalizeBranchName('  weird~^:?*name  '), 'trezi/weird-name')
assert.equal(normalizeBranchName('trezi/'), 'trezi/work')
assert.equal(normalizeBranchName('/a/b/'), 'trezi/a/b')

// --- not a git repo: a clean no-op ---
const nonRepo = mkdtempSync(join(tmpdir(), 'trezi-nonrepo-'))
assert.equal(await isGitRepo(nonRepo), false)
assert.deepEqual(await ensureBranch(nonRepo), { isRepo: false, branch: null, created: false })
rmSync(nonRepo, { recursive: true, force: true })

// --- a real repo on `main` ---
const dir = mkdtempSync(join(tmpdir(), 'trezi-repo-'))
const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' })
g('init', '-b', 'main')
g('config', 'user.email', 't@example.com')
g('config', 'user.name', 'Test')
writeFileSync(join(dir, 'f.txt'), 'hi')
g('add', '.')
g('commit', '-m', 'init')
assert.equal(await getCurrentBranch(dir), 'main')

// ensureBranch from main → creates trezi/main and checks it out
assert.deepEqual(await ensureBranch(dir), {
  isRepo: true,
  branch: 'trezi/main',
  created: true,
  files: []
})
assert.equal(await getCurrentBranch(dir), 'trezi/main')

// ensureBranch when already on a trezi/* branch → keep it, don't recreate
assert.deepEqual(await ensureBranch(dir), { isRepo: true, branch: 'trezi/main', created: false })

// ensureBranch on a legacy pre-rename dsgn/* branch → keep it too (never nest
// a trezi/dsgn/… branch on top of old work)
g('checkout', '-b', 'dsgn/old-work')
assert.deepEqual(await ensureBranch(dir), { isRepo: true, branch: 'dsgn/old-work', created: false })
g('checkout', 'trezi/main')

// switch to a new named branch (coerced + created)
assert.deepEqual(await switchBranch(dir, 'feature-y'), {
  isRepo: true,
  branch: 'trezi/feature-y',
  created: true,
  files: []
})
assert.equal(await getCurrentBranch(dir), 'trezi/feature-y')

// switch back to an existing branch → not created
assert.deepEqual(await switchBranch(dir, 'trezi/main'), {
  isRepo: true,
  branch: 'trezi/main',
  created: false,
  files: []
})

// Switching environments reports manifests in either direction, including deletion.
g('checkout', 'trezi/feature-y')
writeFileSync(join(dir, 'package.json'), '{"scripts":{"dev":"vite"}}')
g('add', '.')
g('commit', '-m', 'framework branch')
assert.deepEqual((await checkoutBranch(dir, 'main')).files, ['package.json'])
assert.deepEqual((await switchBranch(dir, 'feature-y')).files, ['package.json'])
const failed = await checkoutBranch(dir, 'missing-branch')
assert.ok(failed.error)
assert.equal(failed.files, undefined)
rmSync(dir, { recursive: true, force: true })
console.log('GIT OK — normalize, non-repo, ensure (create/keep), switch (create/existing)')
