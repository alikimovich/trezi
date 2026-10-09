/**
 * Legacy sidecar migration (2026-07 dsgn→trezi rename), run by the real Swift editing
 * owner (`EditingProject.swift`, the only one since LKM-111 removed the TS copy).
 *
 *  - `.dsgn/annotations.json` + `.dsgn/tokens.json` move into `.trezi/`
 *  - the old stamping helpers stay in `.dsgn/` (the repo's build config may
 *    still reference them)
 *  - an existing `.trezi/` file is never clobbered
 *  - a repo with no `.dsgn/` gets NO spurious `.trezi/` dir
 *
 * Run with: bun test/sidecar-migrate.mjs
 */
import './helpers/with-service-owners.mjs'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editingOwner } from '../src/main/editing-owner.ts'

const migrateLegacySidecar = (root) => editingOwner().migrateSidecar(root)
const work = mkdtempSync(join(tmpdir(), 'trezi-sidecar-'))

try {
  // Full legacy sidecar: data files move, helper stays.
  const a = join(work, 'a')
  mkdirSync(join(a, '.dsgn'), { recursive: true })
  writeFileSync(join(a, '.dsgn', 'annotations.json'), '[{"id":"a1"}]')
  writeFileSync(join(a, '.dsgn', 'tokens.json'), '{"colors":{}}')
  writeFileSync(join(a, '.dsgn', 'dsgn-source.cjs'), '// helper')
  await migrateLegacySidecar(a)
  assert.equal(readFileSync(join(a, '.trezi', 'annotations.json'), 'utf8'), '[{"id":"a1"}]')
  assert.equal(readFileSync(join(a, '.trezi', 'tokens.json'), 'utf8'), '{"colors":{}}')
  assert(!existsSync(join(a, '.dsgn', 'annotations.json')), 'legacy annotations left behind')
  assert(existsSync(join(a, '.dsgn', 'dsgn-source.cjs')), 'helper must NOT move')
  // Idempotent: a second run is a clean no-op.
  await migrateLegacySidecar(a)
  assert.equal(readFileSync(join(a, '.trezi', 'annotations.json'), 'utf8'), '[{"id":"a1"}]')

  // A `.trezi/` file already present wins — never clobbered by legacy data.
  const b = join(work, 'b')
  mkdirSync(join(b, '.dsgn'), { recursive: true })
  mkdirSync(join(b, '.trezi'), { recursive: true })
  writeFileSync(join(b, '.dsgn', 'annotations.json'), '["old"]')
  writeFileSync(join(b, '.trezi', 'annotations.json'), '["new"]')
  await migrateLegacySidecar(b)
  assert.equal(readFileSync(join(b, '.trezi', 'annotations.json'), 'utf8'), '["new"]')
  assert(existsSync(join(b, '.dsgn', 'annotations.json')), 'shadowed legacy file should stay put')

  // No `.dsgn/` at all → no `.trezi/` conjured out of nothing.
  const c = join(work, 'c')
  mkdirSync(c, { recursive: true })
  await migrateLegacySidecar(c)
  assert(!existsSync(join(c, '.trezi')), 'must not create .trezi without legacy data')

  console.log('SIDECAR-MIGRATE OK — data moves, helpers stay, no clobber, no spurious dir')
} catch (err) {
  console.error('SIDECAR-MIGRATE FAILED:', err?.message ?? err)
  process.exitCode = 1
} finally {
  rmSync(work, { recursive: true, force: true })
}
