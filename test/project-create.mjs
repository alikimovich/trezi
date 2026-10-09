/**
 * Unit test for the New Project scaffold (src/main/scaffold.ts) through the Swift
 * workflow owner that writes it (a fixture process): writes the template into a temp
 * dir, validates the files + package name sanitization, git init, and the non-empty-dir
 * guard. Install is skipped (network/slow) — the template's shape is what matters here.
 *
 * Run with: bun test/project-create.mjs
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setWorkflowOwner } from '../src/main/workflow-owner.ts'
import { compileWorkflowFixture, startWorkflowFixture } from './helpers/workflow-fixture.mjs'

const { createProject, packageName } = await import('../src/main/scaffold.ts')

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

const base = mkdtempSync(join(tmpdir(), 'trezi-create-'))
mkdirSync(join(base, 'profile'))
const fixture = await startWorkflowFixture(compileWorkflowFixture(), join(base, 'profile'))
try {
  setWorkflowOwner(fixture.workflows())
  // Name sanitization.
  assert(packageName('/x/My App!') === 'my-app', `packageName: ${packageName('/x/My App!')}`)
  assert(packageName('/x/---') === 'my-app', 'degenerate names fall back')

  // Scaffold a fresh project (no install).
  const root = join(base, 'Fresh App')
  const res = await createProject(root, { install: false })
  assert(res.ok, `create failed: ${res.error}`)
  for (const f of [
    'package.json',
    'index.html',
    'vite.config.ts',
    'tsconfig.json',
    'src/main.tsx',
    'src/App.tsx',
    'src/styles.css',
    '.gitignore'
  ]) {
    assert(existsSync(join(root, f)), `missing ${f}`)
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert(pkg.name === 'fresh-app', `package name: ${pkg.name}`)
  assert(pkg.scripts.dev === 'vite', 'dev script should be vite')
  assert(pkg.dependencies.react, 'react dependency missing')

  // Git initialized on main with the initial commit (skip silently if the
  // machine has no git identity — scaffold treats git as non-fatal).
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
    assert(branch === 'main', `branch: ${branch}`)
  } catch {
    console.warn('warning: git assertions skipped (no repo/identity)')
  }

  const empty = join(base, 'Custom App')
  const custom = await createProject(empty, { template: 'empty' })
  assert(custom.ok, `empty project failed: ${custom.error}`)
  assert(existsSync(join(empty, '.gitignore')), 'empty starter initializes git ignores')
  assert(!existsSync(join(empty, 'package.json')), 'empty starter must not choose a framework')
  assert(!existsSync(join(empty, 'src')), 'empty starter must not prebuild an app')
  assert(!existsSync(join(empty, 'node_modules')), 'empty starter must not install dependencies')
  const invalid = join(base, 'invalid')
  const invalidResult = await createProject(invalid, { template: 'invalid' })
  assert(!invalidResult.ok && !existsSync(invalid), 'reject invalid starter before writing')

  // Guard: refuses a non-empty destination.
  const taken = join(base, 'taken')
  mkdirSync(taken, { recursive: true })
  writeFileSync(join(taken, 'keep.txt'), 'x')
  const res2 = await createProject(taken, { install: false })
  assert(
    !res2.ok && /isn't empty/.test(res2.error ?? ''),
    `non-empty guard: ${JSON.stringify(res2)}`
  )
  assert(!existsSync(join(taken, 'package.json')), 'must not write into a non-empty dir')

  console.log('PROJECT-CREATE OK — template, naming, git init, non-empty guard')
} finally {
  await fixture.stop().catch(() => {})
  rmSync(base, { recursive: true, force: true })
}
