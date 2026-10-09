// S05 annotation storage, split from publication: note CRUD parity with the
// pre-S05 format, damaged files preserved, unknown entries kept, per-project
// serialization and no Git or publication side effect. Since S15 the store only
// renders: every write is a hash-bound sidecar commit by the editing owner (here
// the real Swift one, the only writer since LKM-111),
// so a hand edit between read and commit is re-read, never overwritten. The
// starter tokens scaffold uses the same create-only commit.
import './helpers/with-service-owners.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnnotationStore } from '../src/main/annotation-store.ts'
import { editingOwner } from '../src/main/editing-owner.ts'
import { registerTokensIpc } from '../src/main/tokens.ts'

const scratch = mkdtempSync(join(tmpdir(), 'trezi-annotation-store-'))
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

try {
  const repo = join(scratch, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  )
  const gitState = () => [
    git(repo, 'rev-parse', 'HEAD'),
    git(repo, 'branch', '--list'),
    git(repo, 'diff', '--cached', '--name-only'),
    git(repo, 'stash', 'list'),
    git(repo, 'rev-list', '--all', '--count')
  ]
  const before = gitState()
  const file = join(repo, '.trezi/annotations.json')
  let n = 0
  const store = createAnnotationStore({
    now: () => new Date(Date.UTC(2026, 8, 28)),
    newId: () => `a${++n}`
  })

  // CRUD parity: the pre-S05 format (pretty JSON + newline) and field set.
  assert.deepEqual(await store.list(repo), [], 'absent is empty')
  const input = {
    source: 'App.tsx:1:1',
    selector: 'button',
    tag: 'button',
    text: '  Make it blue  '
  }
  const added = await store.add(repo, input)
  const note = {
    id: 'a1',
    source: 'App.tsx:1:1',
    selector: 'button',
    tag: 'button',
    text: 'Make it blue',
    createdAt: '2026-09-28T00:00:00.000Z'
  }
  assert.deepEqual(added, [note])
  assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify([note], null, 2)}\n`, 'pre-S05 bytes')
  assert.deepEqual(
    await store.add(repo, { ...input, text: '   ' }),
    [note],
    'an empty note adds nothing'
  )
  assert.equal(
    (await store.add(repo, { ...input, text: 'x'.repeat(2500) })).at(-1).text.length,
    2000,
    'notes are bounded'
  )
  assert.deepEqual(
    (await store.remove(repo, 'a2')).map((a) => a.id),
    ['a1']
  )
  const unchanged = readFileSync(file)
  assert.deepEqual(
    (await store.remove(repo, 'missing')).map((a) => a.id),
    ['a1'],
    'removing an unknown id is a no-op'
  )
  assert.ok(readFileSync(file).equals(unchanged), 'a no-op writes nothing')

  // Concurrent adds on one project serialize: none is lost.
  await Promise.all(['one', 'two', 'three'].map((text) => store.add(repo, { ...input, text })))
  assert.deepEqual(
    (await store.list(repo)).map((a) => a.text),
    ['Make it blue', 'one', 'two', 'three']
  )

  // Entries it does not understand are kept (and not offered as notes).
  const odd = [
    {
      id: 'keep',
      text: 'Kept',
      selector: 's',
      tag: 't',
      source: null,
      createdAt: 'x',
      extra: { a: 1 }
    },
    42,
    { note: 'foreign' }
  ]
  writeFileSync(file, JSON.stringify(odd))
  assert.deepEqual(
    (await store.list(repo)).map((a) => a.id),
    ['keep']
  )
  await store.add(repo, { ...input, text: 'New' })
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(stored.slice(0, 3), odd, 'unknown entries survive a write')
  await store.remove(repo, 'keep')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).slice(0, 2), [42, { note: 'foreign' }])

  // A damaged file is never read as empty or overwritten by the next note.
  for (const content of ['{"broken":', '{}', 'null', '']) {
    writeFileSync(file, content)
    await assert.rejects(store.list(repo), /not a valid notes file/)
    await assert.rejects(
      store.add(repo, { ...input, text: 'Lost?' }),
      (error) => error.code === 'recoveryRequired'
    )
    await assert.rejects(store.remove(repo, 'a1'), /left untouched/)
    assert.equal(
      readFileSync(file, 'utf8'),
      content,
      `damaged ${JSON.stringify(content)} is left untouched`
    )
  }
  rmSync(file)

  // Storage has no Git or publication side effect.
  await store.add(repo, { ...input, text: 'After' })
  assert.deepEqual(gitState(), before, 'no commit, branch, staged change or stash')
  assert.equal(
    git(repo, 'status', '--porcelain', '--untracked-files=all'),
    '?? .trezi/annotations.json',
    'only the sidecar changed'
  )

  // Projects are independent.
  const other = join(scratch, 'other')
  mkdirSync(other)
  assert.deepEqual(await store.list(other), [])
  // A hand edit between read and commit is read again and kept; the note is added on top.
  const racy = join(scratch, 'racy')
  mkdirSync(racy)
  let raced = 0
  const racing = createAnnotationStore({
    now: () => new Date(Date.UTC(2026, 8, 28)),
    newId: () => 'r1',
    commit: async (root, expected, content) => {
      if (!raced++)
        writeFileSync(
          join(root, '.trezi/annotations.json'),
          JSON.stringify([{ id: 'hand', text: 'Hand edit' }])
        )
      return editingOwner().sidecar(root, 'annotations.json', expected, content)
    }
  })
  mkdirSync(join(racy, '.trezi'))
  assert.deepEqual(
    (await racing.add(racy, { ...input, text: 'Mine' })).map((a) => a.id),
    ['hand', 'r1'],
    'the hand edit survives'
  )
  assert.equal(raced, 2, 'the first commit was refused and retried on the new bytes')
  const stubborn = createAnnotationStore({ commit: async () => ({ ok: false, conflict: true }) })
  await assert.rejects(
    stubborn.add(racy, { ...input, text: 'Never' }),
    (error) => error.code === 'conflict'
  )
  assert.deepEqual(
    JSON.parse(readFileSync(join(racy, '.trezi/annotations.json'), 'utf8')).map((a) => a.id),
    ['hand', 'r1'],
    'a refused commit writes nothing'
  )
  assert.deepEqual(
    readdirSync(join(racy, '.trezi')),
    ['annotations.json'],
    'no temporary file is left behind'
  )

  // A linked .trezi folder is refused (the pre-S15 writer followed it out of the project).
  const linked = join(scratch, 'linked')
  mkdirSync(linked)
  mkdirSync(join(scratch, 'elsewhere'))
  symlinkSync(join(scratch, 'elsewhere'), join(linked, '.trezi'))
  await assert.rejects(
    store.add(linked, { ...input, text: 'Out' }),
    (error) => error.code === 'unauthorized'
  )
  assert.deepEqual(readdirSync(join(scratch, 'elsewhere')), [], 'nothing written through the link')

  // Starter tokens: created once through the owner, never replacing an existing file.
  const handlers = new Map()
  registerTokensIpc({ handle: (channel, handler) => handlers.set(channel, handler) })
  const scaffold = (root) => handlers.get('tokens:scaffold')(null, root)
  const plain = join(scratch, 'plain')
  mkdirSync(plain)
  const first = await scaffold(plain)
  assert.equal(first.ok && first.written, true, 'the starter manifest is written')
  assert.equal(first.set.source, 'manifest')
  const again = await scaffold(plain)
  assert.equal(again.ok && !again.written, true, 'an existing manifest is left alone')
  const damaged = join(scratch, 'damaged-tokens')
  mkdirSync(join(damaged, '.trezi'), { recursive: true })
  writeFileSync(join(damaged, '.trezi/tokens.json'), '{"broken":')
  const refused = await scaffold(damaged)
  assert.equal(refused.ok, false, 'a manifest detection cannot read is not replaced')
  assert.equal(readFileSync(join(damaged, '.trezi/tokens.json'), 'utf8'), '{"broken":')
  assert.equal(existsSync(join(damaged, '.trezi/tokens.json.tmp')), false)
  console.log(
    'ANNOTATION-STORE OK — CRUD parity, serialized writes, unknown entries kept, damaged files preserved, no Git side effects, hand edits re-read, links refused, tokens create-only'
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
