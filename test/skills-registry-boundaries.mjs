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
import {
  code,
  compileSkills,
  files,
  killAll,
  ok,
  skillMd,
  start
} from './helpers/skills-fixture.mjs'

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

  // A pin outlives the skill's bounded history (SkillsPlan.appending, maxHistory): trimming
  // never repins, and resuming the oldest session keeps its original content through
  // edit, remove, purge and the restart-time sweep.
  const trimProfile = join(scratch, 'trim')
  mkdirSync(trimProfile)
  const revisionFile = (revision) => join(trimProfile, 'skills/revisions', `${revision}.json`)
  fx = await start(binary, trimProfile)
  const created = ok(
    await fx.mutate('create', { files: files('trim', { 'references/note.md': 'ref-v1' }) })
  )
  const { skill } = created
  const v1 = created.skillRevision
  const edit = async (base, text) =>
    ok(await fx.mutate('edit', { skill, base, changes: [{ path: 'references/note.md', text }] }))
      .skillRevision
  assert.equal(ok(await fx.call('snapshot', { session: 'old' })).pins[0].revision, v1)
  // v1 is also the installed revision, which the registry keeps on its own; v2 is held by
  // a pin alone once trimmed, so a second session proves the pin is what keeps it.
  const v2 = await edit(v1, 'ref-v2')
  assert.equal(ok(await fx.call('snapshot', { session: 'mid' })).pins[0].revision, v2)
  const v3 = await edit(v2, 'ref-v3')
  let latest = v3
  // v1..v(max+3) is max+3 entries: the three oldest fall out of the capped history.
  for (let i = 4; i <= SKILLS_LIMITS.maxHistory + 3; i++) latest = await edit(latest, `ref-v${i}`)
  const [summary] = ok(await fx.call('list')).skills
  assert.equal(summary.history.length, SKILLS_LIMITS.maxHistory, 'history is capped')
  const listed = summary.history.map((entry) => entry.revision)
  for (const trimmed of [v1, v2, v3]) assert.ok(!listed.includes(trimmed), 'trimmed from history')
  assert.equal(summary.revision, latest)
  const expectPinned = async (label) => {
    for (const [session, revision, text] of [
      ['old', v1, 'ref-v1'],
      ['mid', v2, 'ref-v2']
    ]) {
      const read = ok(await fx.call('read', { skill, session }))
      assert.equal(read.revision, revision, `${label}: ${session} keeps its revision`)
      assert.equal(read.body, skillMd('trim'), `${label}: ${session} keeps its body`)
      const reference = await fx.call('reference', { skill, revision, path: 'references/note.md' })
      assert.equal(ok(reference).text, text, `${label}: ${session} reference text`)
      assert.ok(existsSync(revisionFile(revision)), `${label}: pinned revision file kept`)
    }
  }
  await expectPinned('trimmed')
  ok(await fx.mutate('remove', { skill }))
  await expectPinned('removed')
  await fx.close()
  fx = await start(binary, trimProfile)
  await expectPinned('removed, after sweep')
  assert.ok(!existsSync(revisionFile(v3)), 'a trimmed revision nobody pins is collected')
  ok(await fx.mutate('purge', { skill }))
  await expectPinned('purged')
  await fx.close()
  fx = await start(binary, trimProfile)
  await expectPinned('purged, after sweep')
  assert.ok(!existsSync(revisionFile(v3)), 'unpinned trimmed revision stays collected')
  assert.ok(!existsSync(revisionFile(latest)), 'unpinned current revision collected after purge')
  assert.equal(code(await fx.call('read', { skill, revision: v3 })), 'notFound')
  await fx.close()
  console.log(
    'SKILLS-BOUNDARIES pinned revisions survive history trimming, remove, purge and sweep PASS'
  )
} finally {
  killAll()
  rmSync(scratch, { recursive: true, force: true })
}
