// Regressions for the manager's reproduced decoder trap and silent pin eviction.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SKILLS_LIMITS } from '../src/shared/skills-registry.ts'
import { code, compileSkills, files, killAll, ok, start } from './helpers/skills-fixture.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'trezi-skills-boundaries-'))
const binary = join(scratch, 'fixture')
try {
  compileSkills(binary)
  const profile = join(scratch, 'corruption')
  mkdirSync(profile)
  let fx = await start(binary, profile)
  ok(await fx.mutate('create', { files: files('boundary') }))
  await fx.close()
  const path = join(profile, 'skills/manifest.json')
  const original = readFileSync(path)
  for (const [field, value] of [
    ['files', 1e100],
    ['files', 1.5],
    ['files', SKILLS_LIMITS.maxFiles + 1],
    ['bytes', 1e100],
    ['bytes', 1.5],
    ['bytes', SKILLS_LIMITS.maxPackageBytes + 1]
  ]) {
    const manifest = JSON.parse(original)
    manifest.skills[0][field] = value
    const damaged = JSON.stringify(manifest)
    writeFileSync(path, damaged)
    fx = await start(binary, profile)
    assert.equal(code(await fx.call('list')), 'recoveryRequired', `${field}=${value}`)
    assert.equal(readFileSync(path, 'utf8'), damaged, 'corrupt input is preserved')
    await fx.close()
  }
  writeFileSync(path, original)
  fx = await start(binary, profile)
  assert.equal(ok(await fx.call('list')).skills.length, 1)
  await fx.close()
  console.log('SKILLS-BOUNDARIES corrupt numeric counters are refused without process traps PASS')

  const capacityProfile = join(scratch, 'capacity')
  const directory = join(capacityProfile, 'skills/snapshots')
  mkdirSync(directory, { recursive: true })
  const snapshotPath = (session) =>
    join(directory, `${createHash('sha256').update(session).digest('hex')}.json`)
  for (let i = 0; i < SKILLS_LIMITS.maxSnapshots; i++) {
    const session = `saved-${i}`
    writeFileSync(
      snapshotPath(session),
      JSON.stringify({
        format: 'trezi-skills-snapshot-v1',
        session,
        createdAt: i + 1,
        pins: []
      })
    )
  }
  const oldest = readFileSync(snapshotPath('saved-0'))
  fx = await start(binary, capacityProfile)
  assert.equal(code(await fx.call('snapshot', { session: 'overflow' })), 'conflict')
  assert.equal(existsSync(snapshotPath('overflow')), false)
  assert.deepEqual(
    readFileSync(snapshotPath('saved-0')),
    oldest,
    'oldest resumable pins remain unchanged'
  )
  assert.equal(ok(await fx.call('snapshot', { session: 'saved-0' })).created, false)
  assert.equal(readdirSync(directory).length, SKILLS_LIMITS.maxSnapshots)
  await fx.close()
  console.log('SKILLS-BOUNDARIES capacity refuses new sessions without evicting saved pins PASS')

  const walkProfile = join(scratch, 'walk-profile')
  const folder = join(scratch, 'many-empty-folders')
  mkdirSync(walkProfile)
  mkdirSync(folder)
  writeFileSync(join(folder, 'SKILL.md'), files('walk')[0].text)
  for (let i = 0; i < SKILLS_LIMITS.maxDirectoryEntries; i++) mkdirSync(join(folder, `empty-${i}`))
  fx = await start(binary, walkProfile)
  assert.equal(code(await fx.mutate('import', { folder })), 'invalidRequest')
  assert.deepEqual(
    ok(await fx.call('list')).skills,
    [],
    'over-budget import never activates a partial package'
  )
  await fx.close()
  console.log(
    'SKILLS-BOUNDARIES local traversal counts empty directories before accumulating names PASS'
  )
} finally {
  killAll()
  rmSync(scratch, { recursive: true, force: true })
}
