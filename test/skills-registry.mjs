// LKM-284 Trezi Skills registry: the Swift owner (real SkillsOwner + OperationLedger in
// a fixture process) on disposable profiles. Contract parity with the TS types, lazy
// reads, save-as-new-revision edits, enable/providers, recoverable remove/restore and
// purge, session snapshots that never move, the GitHub provenance seam and Bun's client.
// Crashes, damaged data, malicious input and isolation: skills-registry-safety.mjs.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { SkillsError, serviceSkills } from '../src/native/skills-service.ts'
import {
  SKILLS_LIMITS,
  validSkillName,
  validSkillPath,
  validSkillSession
} from '../src/shared/skills-registry.ts'
import {
  code,
  compileSkills,
  files,
  link,
  NOW,
  ok,
  scratchSpace,
  skillMd
} from './helpers/skills-fixture.mjs'

const space = scratchSpace('trezi-skills-registry-')
const { binary, start, profile, registry } = space

try {
  // --- Contract parity: the TS mirror of the Swift limits and validators ---
  {
    const swift = readFileSync('src/service/SkillsPackage.swift', 'utf8')
    for (const [key, value] of Object.entries(SKILLS_LIMITS)) {
      const match = swift.match(new RegExp(`static let ${key} = ([0-9 *]+)\\n`))
      assert.ok(match, `${key} is a Swift limit`)
      assert.equal(
        match[1].split('*').reduce((a, b) => a * Number(b), 1),
        value,
        key
      )
    }
    assert.ok(validSkillName('pdf-tools') && !validSkillName('-x') && !validSkillName('Caps'))
    assert.ok(validSkillPath('references/guide.md') && !validSkillPath('../x'))
    for (const bad of ['.hidden', 'a/./b', 'a\\b', '/abs', 'a//b', 'x.', 'a/b/c/d/e/f/g'])
      assert.equal(validSkillPath(bad), false, bad)
    assert.ok(validSkillSession('chat:1') && !validSkillSession('a/b'))
  }

  compileSkills(binary)

  // --- Create, metadata-only list, lazy body and reference reads, stored layout ---
  const guide = 'Read me only when needed.\n'
  {
    const dir = profile()
    const fx = await start(dir)
    const empty = ok(await fx.call('list'))
    assert.deepEqual(empty.skills, [])
    assert.equal(code(await fx.send(fx.frame('create', { files: files('pdf') }))), 'invalidRequest')
    const stale = await fx.send(
      fx.frame('create', { files: files('pdf') }, { ...empty.revision, counter: '99' })
    )
    assert.equal(code(stale), 'conflict')
    assert.ok(stale.reply.result.payload.currentRevision, 'a stale revision names the current one')
    const created = await fx.mutate('create', {
      files: files('pdf', { 'references/guide.md': guide })
    })
    const { skill, skillRevision, changed } = ok(created)
    assert.equal(changed, true)
    assert.match(skill, /^[0-9a-f-]{36}$/)
    const [summary] = created.snapshot.skills
    assert.equal(summary.name, 'pdf')
    assert.equal(summary.revision, skillRevision)
    assert.equal(summary.installedRevision, skillRevision)
    assert.deepEqual([summary.modified, summary.enabled, summary.removed], [false, true, false])
    assert.deepEqual(summary.providers, { claude: true, codex: true, gemini: true })
    assert.deepEqual(summary.source, { kind: 'manual' })
    assert.equal(summary.files, 2)
    assert.ok(
      !JSON.stringify(ok(await fx.call('list'))).includes('Read me only'),
      'list has no text'
    )
    const body = ok(await fx.call('read', { skill }))
    assert.equal(body.body, skillMd('pdf'))
    assert.deepEqual(
      body.references.map((entry) => entry.path),
      ['references/guide.md']
    )
    const ref = ok(
      await fx.call('reference', { skill, revision: skillRevision, path: 'references/guide.md' })
    )
    assert.equal(ref.text, guide)
    assert.equal(
      code(await fx.call('reference', { skill, revision: skillRevision, path: 'missing.md' })),
      'notFound'
    )
    // Content-addressed and read-only: the revision file hashes to its ID, objects are 0400.
    const revisionFile = registry(dir, 'revisions', `${skillRevision}.json`)
    assert.equal(
      createHash('sha256').update(readFileSync(revisionFile)).digest('hex'),
      skillRevision
    )
    for (const name of readdirSync(registry(dir, 'objects'))) {
      const bytes = readFileSync(registry(dir, 'objects', name))
      assert.equal(createHash('sha256').update(bytes).digest('hex'), name)
      assert.equal(statSync(registry(dir, 'objects', name)).mode & 0o777, 0o400)
    }
    assert.equal(
      code(await fx.mutate('create', { files: files('pdf') })),
      'conflict',
      'names are unique'
    )
    await fx.close()
    console.log(
      'SKILLS-REGISTRY create, metadata list, lazy body/reference, content addresses PASS'
    )
  }

  // --- Save-as-new-revision edits, enable/providers, remove/restore/purge ---
  {
    const dir = profile()
    const fx = await start(dir)
    const { skill, skillRevision: first } = ok(
      await fx.mutate('create', { files: files('notes', { 'a.md': 'A' }) })
    )
    const edit = (base, changes) => fx.mutate('edit', { skill, base, changes })
    const second = ok(await edit(first, [{ path: 'SKILL.md', text: skillMd('notes', 'Edited.') }]))
    assert.notEqual(second.skillRevision, first)
    let [summary] = ok(await fx.call('list')).skills
    assert.equal(summary.modified, true)
    assert.equal(summary.installedRevision, first)
    assert.equal(summary.description, 'Edited.')
    assert.deepEqual(
      summary.history.map((entry) => entry.kind),
      ['create', 'edit']
    )
    assert.equal(
      ok(await fx.call('read', { skill, revision: first })).description,
      'The notes skill.'
    )
    assert.equal(code(await edit(first, [{ path: 'a.md', text: 'B' }])), 'conflict', 'stale base')
    const same = ok(await edit(second.skillRevision, [{ path: 'a.md', text: 'A' }]))
    assert.deepEqual([same.changed, same.skillRevision], [false, second.skillRevision])
    const third = ok(await edit(second.skillRevision, [{ path: 'a.md', text: null }]))
    assert.deepEqual(ok(await fx.call('read', { skill })).references, [])
    assert.equal(
      code(await edit(third.skillRevision, [{ path: 'SKILL.md', text: null }])),
      'invalidRequest'
    )
    assert.equal(
      code(await edit(third.skillRevision, [{ path: '../x', text: 'x' }])),
      'invalidRequest'
    )
    // An edit back to the first content is the first revision again (content-addressed).
    ok(
      await edit(third.skillRevision, [
        { path: 'SKILL.md', text: skillMd('notes') },
        { path: 'a.md', text: 'A' }
      ])
    )
    ;[summary] = ok(await fx.call('list')).skills
    assert.deepEqual([summary.revision, summary.modified], [first, false])

    const other = ok(await fx.mutate('create', { files: files('other') })).skill
    const otherRevision = ok(await fx.call('read', { skill: other })).revision
    assert.equal(
      code(
        await fx.mutate('edit', {
          skill: other,
          base: otherRevision,
          changes: [{ path: 'SKILL.md', text: skillMd('notes') }]
        })
      ),
      'conflict',
      'an edit cannot take another skill’s name'
    )
    assert.equal(ok(await fx.mutate('enable', { skill, enabled: false })).changed, true)
    assert.equal(ok(await fx.mutate('enable', { skill, enabled: false })).changed, false)
    const providers = { claude: true, codex: false, gemini: true }
    ok(await fx.mutate('providers', { skill, providers }))
    assert.equal(
      code(await fx.mutate('providers', { skill, providers: { claude: true } })),
      'invalidRequest'
    )
    ;[summary] = ok(await fx.call('list')).skills
    assert.deepEqual([summary.enabled, summary.providers], [false, providers])

    assert.equal(code(await fx.mutate('purge', { skill })), 'conflict', 'purge needs remove first')
    ok(await fx.mutate('remove', { skill }))
    ;[summary] = ok(await fx.call('list')).skills
    assert.deepEqual([summary.removed, summary.removedAt], [true, NOW])
    assert.equal(
      code(await fx.mutate('edit', { skill, base: first, changes: [{ path: 'a.md', text: 'C' }] })),
      'conflict'
    )
    const replacement = ok(await fx.mutate('create', { files: files('notes') })).skill
    assert.equal(code(await fx.mutate('restore', { skill })), 'conflict', 'the name is taken again')
    ok(await fx.mutate('remove', { skill: replacement }))
    ok(await fx.mutate('restore', { skill }))
    assert.equal(ok(await fx.call('list')).skills.find((s) => s.id === skill).removed, false)
    ok(await fx.mutate('purge', { skill: replacement }))
    assert.equal(ok(await fx.call('list')).skills.length, 2)
    assert.equal(code(await fx.mutate('remove', { skill: randomUUID() })), 'notFound')
    await fx.close()
    console.log(
      'SKILLS-REGISTRY edits as revisions, modified flag, enable/providers, remove/restore/purge PASS'
    )
  }

  // --- Snapshots: pinned revisions survive edit, remove, purge and collection ---
  {
    const dir = profile()
    let fx = await start(dir)
    const a = ok(await fx.mutate('create', { files: files('alpha', { 'r.md': 'v1' }) }))
    const b = ok(await fx.mutate('create', { files: files('beta') })).skill
    ok(await fx.mutate('enable', { skill: b, enabled: false }))
    const pinned = ok(await fx.call('snapshot', { session: 'chat-1' }))
    assert.equal(pinned.created, true)
    assert.deepEqual(
      pinned.pins.map((pin) => [pin.skill, pin.revision]),
      [[a.skill, a.skillRevision]],
      'only enabled skills are pinned'
    )
    const v2 = ok(
      await fx.mutate('edit', {
        skill: a.skill,
        base: a.skillRevision,
        changes: [{ path: 'r.md', text: 'v2' }]
      })
    ).skillRevision
    const pinnedRef = { skill: a.skill, revision: a.skillRevision, path: 'r.md' }
    assert.equal(
      ok(await fx.call('read', { skill: a.skill, session: 'chat-1' })).revision,
      a.skillRevision
    )
    assert.equal(ok(await fx.call('reference', pinnedRef)).text, 'v1', 'the session keeps v1')
    assert.equal(ok(await fx.call('read', { skill: a.skill })).revision, v2, 'new sessions get v2')
    const again = ok(await fx.call('snapshot', { session: 'chat-1' }))
    assert.deepEqual([again.created, again.pins], [false, pinned.pins], 'idempotent per session')
    assert.deepEqual(ok(await fx.call('pins', { session: 'chat-1' })).pins, pinned.pins)
    ok(await fx.mutate('remove', { skill: a.skill }))
    assert.deepEqual(ok(await fx.call('snapshot', { session: 'chat-2' })).pins, [])
    ok(await fx.mutate('purge', { skill: a.skill }))
    assert.equal(ok(await fx.call('reference', pinnedRef)).text, 'v1', 'purge keeps pinned content')
    assert.equal(code(await fx.call('read', { skill: a.skill, revision: v2 })), 'notFound')
    await fx.close()
    // A restart collects what nothing keeps; chat-1's pin is still readable.
    fx = await start(dir)
    assert.ok(existsSync(registry(dir, 'revisions', `${a.skillRevision}.json`)))
    assert.ok(!existsSync(registry(dir, 'revisions', `${v2}.json`)), 'unpinned v2 collected')
    assert.equal(
      ok(await fx.call('read', { skill: a.skill, session: 'chat-1' })).body,
      skillMd('alpha')
    )
    assert.equal(
      ok(await fx.command({ cmd: 'pin', session: 'chat-1' })).created,
      false,
      'service seam'
    )
    assert.deepEqual(ok(await fx.call('release', { session: 'chat-1' })), {
      session: 'chat-1',
      released: true
    })
    assert.equal(ok(await fx.call('release', { session: 'chat-1' })).released, false)
    assert.equal(code(await fx.call('pins', { session: 'chat-1' })), 'notFound')
    await fx.close()
    fx = await start(dir)
    assert.ok(
      !existsSync(registry(dir, 'revisions', `${a.skillRevision}.json`)),
      'released, then collected'
    )
    assert.equal(ok(await fx.call('list')).skills.length, 1)
    await fx.close()
    console.log(
      'SKILLS-REGISTRY snapshots pin revisions across edit/remove/purge/restart, release PASS'
    )
  }

  // --- GitHub provenance (the service-internal install seam) ---
  {
    const dir = profile()
    const fx = await start(dir)
    const commit = 'a'.repeat(40)
    const source = {
      kind: 'github',
      repository: 'acme/skills',
      subpath: 'skills/lint',
      commit,
      license: 'MIT'
    }
    const installed = ok(await fx.command({ cmd: 'install', files: files('lint'), source }))
    let [summary] = ok(await fx.call('list')).skills
    assert.deepEqual(
      [summary.source, summary.modified, summary.history[0].kind],
      [source, false, 'install']
    )
    ok(
      await fx.mutate('edit', {
        skill: installed.skill,
        base: installed.skillRevision,
        changes: [{ path: 'SKILL.md', text: skillMd('lint', 'Local tweak.') }]
      })
    )
    assert.equal(ok(await fx.call('list')).skills[0].modified, true)
    const next = { ...source, commit: 'b'.repeat(40), license: null }
    ok(
      await fx.command({
        cmd: 'install',
        files: files('lint', { 'x.md': 'new' }),
        source: next,
        replacing: installed.skill
      })
    )
    ;[summary] = ok(await fx.call('list')).skills
    assert.deepEqual([summary.source, summary.modified, summary.files], [next, false, 2])
    assert.equal(summary.history.at(-1).kind, 'update')
    for (const bad of [
      { ...source, commit: 'abc' },
      { ...source, repository: '../x' },
      { kind: 'github' }
    ])
      assert.equal(
        code(await fx.command({ cmd: 'install', files: files('x'), source: bad })),
        'invalidRequest'
      )
    assert.equal(
      code(await fx.mutate('create', { files: files('y'), source })),
      'invalidRequest',
      'Bun cannot claim a source'
    )
    await fx.close()
    console.log('SKILLS-REGISTRY GitHub provenance, modified flag, source update PASS')
  }

  // --- Bun's client: serialized calls, revision retry, no-retry conflicts, timeout ---
  {
    const dir = profile()
    let pipe = link(binary, dir)
    await pipe.started
    const skills = serviceSkills(pipe, 5_000)
    const created = await skills.create(files('client', { 'r.md': 'one' }))
    assert.equal(created.list.skills[0].name, 'client')
    const [listed, body] = await Promise.all([skills.list(), skills.read(created.skill)])
    assert.equal(listed.skills.length, 1)
    assert.equal(body.references[0].path, 'r.md')
    assert.equal((await skills.reference(created.skill, created.skillRevision, 'r.md')).text, 'one')
    // Another owner advances the registry: the cached revision is stale, the intent retried.
    ok(await pipe.command({ cmd: 'install', files: files('other'), source: { kind: 'manual' } }))
    assert.equal((await skills.setEnabled(created.skill, false)).changed, true)
    const edited = await skills.edit(created.skill, created.skillRevision, [
      { path: 'r.md', text: 'two' }
    ])
    await assert.rejects(
      skills.edit(created.skill, created.skillRevision, [{ path: 'r.md', text: 'three' }]),
      (error) => error instanceof SkillsError && error.code === 'conflict'
    )
    assert.equal((await skills.read(created.skill)).revision, edited.skillRevision)
    assert.equal((await skills.snapshot('chat-9')).created, true)
    assert.equal((await skills.pins('chat-9')).session, 'chat-9')
    await skills.remove(created.skill)
    await skills.restore(created.skill)
    assert.deepEqual(await skills.release('chat-9'), { session: 'chat-9', released: true })
    await pipe.close()
    pipe = link(binary, dir)
    await pipe.started
    const slow = serviceSkills(pipe, 300)
    pipe.hold()
    await assert.rejects(slow.list(), (error) => error.code === 'deadlineExceeded')
    pipe.flush()
    assert.equal((await slow.list()).skills.length, 2)
    await pipe.close()
    console.log(
      'SKILLS-REGISTRY Bun client: serialized, stale revision retried, base conflict surfaced, timeout PASS'
    )
  }
} finally {
  space.cleanup()
}
