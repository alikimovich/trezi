import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectPackageManager } from '../src/main/project-dependencies.ts'
import { environmentChanges } from '../src/shared/environment-changes.ts'

assert.deepEqual(environmentChanges(['src/App.tsx', 'README.md']), {
  restart: false,
  install: false
})
for (const file of [
  'package.json',
  'bun.lock',
  'bun.lockb',
  'packages/web/package.json',
  'pnpm-workspace.yaml'
]) {
  assert.deepEqual(environmentChanges([file]), { restart: true, install: true }, file)
}
for (const file of ['next.config.ts', 'svelte.config.js', 'vite.config.mts', '.env.local']) {
  assert.deepEqual(environmentChanges([file]), { restart: true, install: false }, file)
}
const root = mkdtempSync(join(tmpdir(), 'trezi-package-manager-'))
try {
  writeFileSync(join(root, 'bun.lock'), '')
  assert.equal(await projectPackageManager(root), 'bun')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0' }))
  assert.equal(
    await projectPackageManager(root),
    'pnpm',
    'explicit manager wins over stale migration lockfile'
  )
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ packageManager: 'malicious shell string' })
  )
  assert.equal(await projectPackageManager(root), 'bun', 'only known executable names accepted')
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log('ENVIRONMENT-CHANGES OK')
