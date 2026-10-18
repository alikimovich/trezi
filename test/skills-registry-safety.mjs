// LKM-284 Trezi Skills registry safety: SIGKILL at every ledger boundary and injected
// manifest write failures, operation receipts, damaged data and a linked registry left
// untouched, malicious packages and import folders (links, hard links, FIFOs, bytes,
// sizes, scripts that never run), strict frames and app scope, concurrent writers, and
// isolation from two user repositories and two provider homes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { discoverProjectSkills } from '../src/main/skills.ts'
import { SKILLS_LIMITS } from '../src/shared/skills-registry.ts'
import {
  code,
  compileSkills,
  files,
  ok,
  scratchSpace,
  skillMd,
  tree
} from './helpers/skills-fixture.mjs'

const space = scratchSpace('trezi-skills-safety-')
const { scratch, start, profile, registry, manifest, folder } = space

try {
  compileSkills(space.binary)

  // --- Interrupted persistence: injected failures and SIGKILL at each boundary ---
  {
    for (const step of ['create', 'write', 'flush', 'rename']) {
      const dir = profile()
      let fx = await start(dir)
      ok(await fx.mutate('create', { files: files('before') }))
      await fx.close()
      const saved = manifest(dir)
      fx = await start(dir, { SKILLS_FAIL: step })
      const failed = await fx.mutate('create', { files: files('after') })
      assert.equal(code(failed), 'ioFailure', step)
      assert.equal(failed.reply.result.payload.retryable, true)
      assert.deepEqual(manifest(dir), saved, `${step}: nothing changed`)
      assert.deepEqual(readdirSync(registry(dir)).sort(), [
        'manifest.json',
        'objects',
        'revisions',
        'snapshots'
      ])
      ok(await fx.mutate('create', { files: files('after') }))
      assert.equal(ok(await fx.call('list')).skills.length, 2, `${step}: the retry succeeds`)
      await fx.close()
    }
    {
      const fx = await start(profile(), { SKILLS_FAIL: 'directory' })
      ok(await fx.mutate('create', { files: files('kept') }))
      assert.equal(
        ok(await fx.call('list')).skills.length,
        1,
        'a directory-sync failure keeps the commit'
      )
      await fx.close()
    }
    const expected = {
      intent: [0, 'failed'],
      effect: [0, 'failed'],
      'after-rename': [1, 'succeeded'],
      receipt: [1, 'succeeded']
    }
    for (const [point, [count, kind]] of Object.entries(expected)) {
      const dir = profile()
      let fx = await start(dir, { SKILLS_CRASH: point })
      const { revision } = ok(await fx.call('list'))
      const operationID = randomUUID()
      const frame = fx.frame('create', { files: files('crash') }, revision, operationID)
      await fx.crash(frame)
      fx = await start(dir)
      assert.equal(
        ok(await fx.call('list')).skills.length,
        count,
        `${point}: reconciled from the file`
      )
      const retry = await fx.send({ ...frame, id: 99 })
      assert.equal(retry.reply.result.kind, kind, `${point}: the receipt answers the retry`)
      assert.equal(ok(await fx.call('list')).skills.length, count, `${point}: never replayed`)
      for (const kind of ['objects', 'revisions']) {
        const names = existsSync(registry(dir, kind)) ? readdirSync(registry(dir, kind)) : []
        assert.ok(!names.some((name) => name.endsWith('.tmp')), `${point}: no leftovers`)
      }
      assert.ok(!existsSync(registry(dir, 'manifest.json.tmp')), `${point}: no manifest temp`)
      ok(await fx.mutate('create', { files: files('later') }))
      await fx.close()
    }
    // The same operationID is answered from its receipt, never applied twice.
    {
      const fx = await start(profile())
      const { revision } = ok(await fx.call('list'))
      const frame = fx.frame('create', { files: files('once') }, revision)
      const first = ok(await fx.send(frame))
      assert.deepEqual(ok(await fx.send({ ...frame, id: 100 })), first)
      assert.equal(ok(await fx.call('list')).skills.length, 1)
      await fx.close()
    }
    console.log(
      'SKILLS-SAFETY failed steps change nothing, SIGKILL at intent/effect/after-rename/receipt reconciled, operation receipts PASS'
    )
  }

  // --- Damaged data is refused and left untouched ---
  {
    const dir = profile()
    let fx = await start(dir)
    const { skill } = ok(await fx.mutate('create', { files: files('fragile', { 'r.md': 'text' }) }))
    const body = ok(await fx.call('read', { skill }))
    const { revision } = ok(await fx.call('list'))
    await fx.close()
    const good = manifest(dir)
    const reformatted = JSON.stringify(JSON.parse(good), null, 2)
    for (const bad of [
      'not json',
      reformatted,
      good.toString().replace('"enabled":true', '"enabled":"yes"')
    ]) {
      assert.notEqual(bad, good.toString())
      writeFileSync(registry(dir, 'manifest.json'), bad)
      fx = await start(dir)
      assert.equal(code(await fx.call('list')), 'recoveryRequired')
      assert.equal(
        code(await fx.send(fx.frame('create', { files: files('x') }, revision))),
        'recoveryRequired'
      )
      assert.equal(readFileSync(registry(dir, 'manifest.json'), 'utf8'), bad, 'left untouched')
      await fx.close()
    }
    writeFileSync(registry(dir, 'manifest.json'), good)
    const entry = body.references[0]
    chmodSync(registry(dir, 'objects', entry.digest), 0o600)
    writeFileSync(registry(dir, 'objects', entry.digest), 'tampered')
    fx = await start(dir)
    assert.equal(
      code(await fx.call('reference', { skill, revision: body.revision, path: 'r.md' })),
      'recoveryRequired'
    )
    assert.equal(ok(await fx.call('read', { skill })).body, body.body, 'other files still read')
    chmodSync(registry(dir, 'revisions', `${body.revision}.json`), 0o600)
    writeFileSync(registry(dir, 'revisions', `${body.revision}.json`), '{}')
    assert.equal(code(await fx.call('read', { skill })), 'recoveryRequired')
    assert.deepEqual(
      ok(await fx.call('snapshot', { session: 's' })).skipped,
      [skill],
      'unreadable skills are not pinned'
    )
    await fx.close()
    // A registry folder replaced by a link is never followed.
    const elsewhere = profile()
    const linked = profile()
    symlinkSync(elsewhere, join(linked, 'skills'))
    fx = await start(linked)
    assert.equal(code(await fx.call('list')), 'recoveryRequired')
    await fx.close()
    assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the link')
    console.log(
      'SKILLS-SAFETY damaged manifest/object/revision and a linked registry are refused untouched PASS'
    )
  }

  // --- Malicious packages and import folders; nothing is ever executed ---
  {
    const dir = profile()
    const fx = await start(dir)
    const create = async (list) => code(await fx.mutate('create', { files: list }))
    for (const path of [
      '../x.md',
      '/etc/x',
      'a\\b.md',
      '.hidden',
      'a/./b.md',
      'a/../b.md',
      'x.md.',
      'a//b.md'
    ])
      assert.equal(await create(files('bad', { [path]: 'x' })), 'invalidRequest', path)
    assert.equal(
      await create(files('dup', { 'A.md': '1', 'a.md': '2' })),
      'invalidRequest',
      'case duplicates'
    )
    assert.equal(
      await create([{ path: 'README.md', text: 'x' }]),
      'invalidRequest',
      'SKILL.md required'
    )
    assert.equal(await create(files('Bad_Name')), 'invalidRequest')
    assert.equal(await create(files('nul', { 'n.md': 'a\u0000b' })), 'invalidRequest')
    assert.equal(
      await create(files('big', { 'b.md': 'x'.repeat(SKILLS_LIMITS.maxFileBytes + 1) })),
      'invalidRequest'
    )
    const many = Object.fromEntries(
      Array.from({ length: SKILLS_LIMITS.maxFiles }, (_, i) => [`f${i}.md`, 'x'])
    )
    assert.equal(await create(files('many', many)), 'invalidRequest')
    const { revision } = ok(await fx.call('list'))
    const request = JSON.stringify(fx.frame('create', { files: [] }, revision).request)
    const surrogate = `{"service":"skills","id":7,"request":${request.replace('"files":[]', '"files":[{"path":"SKILL.md","text":"\\ud800"}]')}}`
    assert.equal(code(await fx.raw(surrogate)), 'invalidRequest', 'lone surrogate')

    const marker = join(scratch, 'executed-marker')
    // A folder with a script, executable or not, is refused whole; nothing runs or is stored.
    for (const mode of [0o755, 0o644]) {
      const withScript = folder({
        'SKILL.md': `---\nname: scripted\ndescription: Mentions a script.\n---\nRun scripts/install.sh\n`,
        'scripts/install.sh': `#!/bin/sh\ntouch ${marker}\n`
      })
      chmodSync(join(withScript, 'scripts/install.sh'), mode)
      const untouched = tree(withScript)
      assert.equal(
        code(await fx.mutate('import', { folder: withScript })),
        'unauthorized',
        `a script (${mode.toString(8)})`
      )
      assert.deepEqual(tree(withScript), untouched, 'the source folder is untouched')
      assert.equal(ok(await fx.call('list')).skills.length, 0, 'nothing was stored')
    }
    const good = folder({
      'SKILL.md': `---\nname: imported\ndescription: Plain instructions.\n---\nRead references/r.md\n`,
      'references/r.md': 'ref',
      '.git/config': '[core]',
      '.DS_Store': 'x'
    })
    const before = tree(good)
    const imported = ok(await fx.mutate('import', { folder: good }))
    assert.deepEqual(imported.skipped, ['.DS_Store', '.git'])
    assert.deepEqual(tree(good), before, 'the source folder is untouched')
    const read = ok(await fx.call('read', { skill: imported.skill }))
    assert.deepEqual(
      read.references.map((entry) => entry.path),
      ['references/r.md']
    )
    for (const name of readdirSync(registry(dir, 'objects')))
      assert.equal(statSync(registry(dir, 'objects', name)).mode & 0o111, 0, 'never executable')
    assert.ok(!existsSync(marker), 'no script ran')

    const refused = async (path) => code(await fx.mutate('import', { folder: path }))
    const inside = folder({ 'SKILL.md': skillMd('linked') })
    symlinkSync('/etc/hosts', join(inside, 'hosts.md'))
    assert.equal(await refused(inside), 'unauthorized', 'a link inside')
    const nested = folder({ 'SKILL.md': skillMd('nested') })
    symlinkSync(scratch, join(nested, 'up'))
    assert.equal(await refused(nested), 'unauthorized', 'a directory link inside')
    const rootLink = join(scratch, 'root-link')
    symlinkSync(folder({ 'SKILL.md': skillMd('rooted') }), rootLink)
    assert.equal(await refused(rootLink), 'unauthorized', 'the folder itself is a link')
    const hard = folder({ 'SKILL.md': skillMd('hard') })
    linkSync(join(hard, 'SKILL.md'), join(scratch, `hard-${space.next()}`))
    assert.equal(await refused(hard), 'unauthorized', 'a hard link')
    const fifo = folder({ 'SKILL.md': skillMd('fifo') })
    assert.equal(spawnSync('/usr/bin/mkfifo', [join(fifo, 'pipe.md')]).status, 0)
    assert.equal(await refused(fifo), 'unauthorized', 'a FIFO is never opened')
    assert.equal(await refused(`${good}/../x`), 'invalidRequest', 'no .. in the folder')
    assert.equal(await refused('relative/folder'), 'invalidRequest')
    assert.equal(
      await refused(folder({ 'SKILL.md': skillMd('bin'), 'b.md': '\u0000' })),
      'invalidRequest'
    )
    const bad = folder({ 'SKILL.md': skillMd('badbytes') })
    writeFileSync(join(bad, 'x.md'), Buffer.from([0xff, 0xfe, 0x41]))
    assert.equal(await refused(bad), 'invalidRequest', 'not UTF-8')
    assert.equal(
      await refused(
        folder({ 'SKILL.md': skillMd('large'), 'l.md': 'x'.repeat(SKILLS_LIMITS.maxFileBytes + 1) })
      ),
      'invalidRequest'
    )
    assert.equal(
      await refused(folder({ 'SKILL.md': skillMd('deep'), 'a/b/c/d/e/f/g.md': 'x' })),
      'invalidRequest'
    )
    assert.equal(ok(await fx.call('list')).skills.length, 1, 'only the clean import was added')
    await fx.close()
    console.log(
      'SKILLS-SAFETY malicious paths, links, hard links, FIFOs, bytes and sizes refused; scripts never run PASS'
    )
  }

  // --- The skills-only scope applies to every write, not just GitHub imports (LKM-285) ---
  {
    const dir = profile()
    const fx = await start(dir)
    const { skill, skillRevision } = ok(
      await fx.mutate('create', { files: files('scoped', { 'a.md': 'A' }) })
    )
    const bang = `Run it: !${'`'}date${'`'}\n`
    const hooks = `---\nname: scoped\ndescription: Has hooks.\nhooks:\n  postinstall: ./x.sh\n---\n# scoped\n`
    const tools = `---\nname: scoped\ndescription: Asks for tools.\nallowed-tools: Bash\n---\n# scoped\n`
    const flow = `---\nname: scoped\ndescription: Not a key list.\n- tools\n---\n# scoped\n`
    const dangerous = [
      ['hooks frontmatter', { 'SKILL.md': hooks }, 'hooks'],
      ['allowed-tools frontmatter', { 'SKILL.md': tools }, 'allowed-tools'],
      ['flow frontmatter', { 'SKILL.md': flow }, 'frontmatter'],
      ['a control manifest', { 'hooks.json': '{}' }, 'hooks.json'],
      ['a package manifest', { 'tools/package.json': '{}' }, 'package.json'],
      ['dynamic shell', { 'notes.md': bang }, 'notes.md'],
      [
        'an agent dependency',
        { 'agents/openai.yaml': 'dependencies:\n  tools: []\n' },
        'dependencies'
      ],
      [
        'a flow-style agent dependency',
        { 'agents/openai.yaml': '{interface: {display_name: X}, dependencies: {tools: []}}\n' },
        'dependencies'
      ],
      [
        'a quoted agent dependency key',
        { 'agents/openai.yaml': 'interface:\n  display_name: X\n"dependencies":\n  tools: []\n' },
        'dependencies'
      ],
      ['a shebang', { 'references/run.txt': '#!/bin/sh\necho hi\n' }, 'shebang'],
      ['a shell script', { 'scripts/check.sh': 'echo hi\n' }, 'script'],
      ['a python script', { 'scripts/tool.py': 'print(1)\n' }, 'script']
    ]
    const snapshot = async () => ({ files: tree(registry(dir)), list: ok(await fx.call('list')) })
    const before = await snapshot()
    for (const [label, extra, word] of dangerous) {
      // Create: SKILL.md replaced or a file added.
      const list = Object.entries(extra).map(([path, text]) => ({ path, text }))
      const created = await fx.mutate('create', {
        files: list.some((item) => item.path === 'SKILL.md') ? list : [...files('scoped2'), ...list]
      })
      assert.equal(code(created), 'unauthorized', `create: ${label}`)
      assert.match(created.reply.result.payload.message ?? '', new RegExp(word, 'i'), label)
      // Import of a local folder.
      const source = folder({ 'SKILL.md': skillMd('scoped3'), ...extra })
      assert.equal(
        code(await fx.mutate('import', { folder: source })),
        'unauthorized',
        `import: ${label}`
      )
      // Edit of an existing skill.
      assert.equal(
        code(
          await fx.mutate('edit', {
            skill,
            base: skillRevision,
            changes: Object.entries(extra).map(([path, text]) => ({ path, text }))
          })
        ),
        'unauthorized',
        `edit: ${label}`
      )
      const after = await snapshot()
      assert.deepEqual(after.files, before.files, `${label}: no object or revision was written`)
      assert.deepEqual(after.list, before.list, `${label}: the registry is unchanged`)
    }
    // In-scope content is still stored: the same edit paths with plain files.
    ok(
      await fx.mutate('edit', {
        skill,
        base: skillRevision,
        changes: [{ path: 'b.md', text: 'B' }]
      })
    )
    await fx.close()
    console.log(
      'SKILLS-SAFETY create, folder import and edit refuse out-of-scope frontmatter, control manifests and dynamic shell, registry unchanged PASS'
    )
  }

  // --- Strict frames, app scope, concurrency ---
  {
    const fx = await start(profile())
    const list = fx.frame('list')
    assert.equal(
      code(await fx.send({ ...list, request: { ...list.request, scope: { root: '/x' } } })),
      'unauthorized'
    )
    assert.equal(code(await fx.call('list', { extra: 1 })), 'invalidRequest')
    assert.equal(
      code(await fx.call('read', { skill: randomUUID().toUpperCase() })),
      'invalidRequest'
    )
    assert.equal(
      code(await fx.call('install', { files: [] })),
      'invalidRequest',
      'install is service-only'
    )
    assert.equal(code(await fx.call('nope')), 'invalidRequest')
    const { revision } = ok(await fx.call('list'))
    assert.equal(
      code(await fx.send(fx.frame('snapshot', { session: 'x' }, revision))),
      'invalidRequest'
    )
    const frames = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify(fx.frame('create', { files: files(`race-${i}`) }, revision))
    )
    frames.push(JSON.stringify(fx.frame('list')))
    const { replies } = await fx.command({ cmd: 'concurrent', frames })
    const results = replies.slice(0, 6).map((reply) => reply.reply.result)
    assert.equal(
      results.filter((result) => result.kind === 'succeeded').length,
      1,
      'one writer wins a revision'
    )
    assert.ok(
      results.every((result) => result.kind === 'succeeded' || result.payload.code === 'conflict')
    )
    assert.equal(ok(await fx.call('list')).skills.length, 1)
    await fx.close()
    console.log('SKILLS-SAFETY strict frames, app scope, serialized concurrent writers PASS')
  }

  // --- Isolation: two user repositories and two provider homes stay byte-identical ---
  {
    const sample = (name, skillDir) => {
      const root = join(scratch, name)
      mkdirSync(join(root, skillDir, 'shared'), { recursive: true })
      writeFileSync(join(root, skillDir, 'shared/SKILL.md'), skillMd('shared', `From ${name}.`))
      writeFileSync(join(root, 'package.json'), '{"name":"sample"}\n')
      return root
    }
    const repos = [sample('repo-one', '.claude/skills'), sample('repo-two', '.claude/skills')]
    const homes = [sample('home-one', '.claude/skills'), sample('home-two', '.codex/skills')]
    const before = [...repos, ...homes].map(tree)
    const discovered = await Promise.all(repos.map(discoverProjectSkills))
    const dir = profile()
    const fx = await start(dir)
    const copy = join(scratch, 'copied-skill')
    cpSync(join(repos[0], '.claude/skills/shared'), copy, { recursive: true })
    const { skill, skillRevision } = ok(await fx.mutate('import', { folder: copy }))
    ok(
      await fx.mutate('edit', {
        skill,
        base: skillRevision,
        changes: [{ path: 'SKILL.md', text: skillMd('shared', 'Edited in Trezi.') }]
      })
    )
    ok(await fx.call('snapshot', { session: 'chat' }))
    ok(await fx.mutate('remove', { skill }))
    await fx.close()
    assert.deepEqual([...repos, ...homes].map(tree), before, 'repositories and homes untouched')
    assert.deepEqual(await Promise.all(repos.map(discoverProjectSkills)), discovered)
    assert.deepEqual(
      readdirSync(dir).sort(),
      ['service', 'skills'],
      'registry data stays in the profile'
    )
    console.log('SKILLS-SAFETY isolation from two repositories and two provider homes PASS')
  }
} finally {
  space.cleanup()
}
