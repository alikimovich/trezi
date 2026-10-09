// S08/S09 source transaction service: the real Swift SourceOwner (compiled into a
// fixture process with the RepositoryOwner whose lanes serialize it), driven through
// Bun's real clients and the unchanged TS engines. It is the only writer (LKM-111).
// - engines: real React/Svelte/HTML/layers fixtures edited, undone and redone end on
//   the exact bytes of each step; the island/style suite (shadow-controls) runs on it itself;
// - proposals: stale hash, external edit, out-of-order parses, a deadline-expired
//   (cancelled) proposal and invalid schemas commit nothing;
// - paths: traversal, protected folders and symlink escapes are refused;
// - transactions: all-or-nothing validation, a write failing midway puts files back;
// - crash: SIGKILL midway through a commit and an Undo is rolled back at the next
//   launch without overwriting a file changed since (its pre-image is kept);
// - history, files, drafts, lanes, relaunch (nothing writes without the service) and
//   drain; parsers own no writer.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canRevertGroup, recordEdit, redo, revertGroup, undo } from '../src/main/edit-history.ts'
import { createProjectFile, deleteProjectFile, renameProjectFile } from '../src/main/file-ops.ts'
import { applyMoveNode } from '../src/main/move-node.ts'
import { applyPropEdit, applyTextEdit, readSourceView } from '../src/main/props.ts'
import { enqueueRepoWrite } from '../src/main/repo-write-queue.ts'
import { setRepositoryOwner } from '../src/main/repository-owner.ts'
import { proposeEdit } from '../src/main/source-commit.ts'
import { contentHash, setSourceOwner } from '../src/main/source-owner.ts'
import { applyStyleEdit } from '../src/main/styles.ts'
import { compileSourceFixture, startSourceFixture } from './helpers/source-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-source-owner-')))
const fixtures = new Set()
let count = 0
const read = (path) => readFileSync(path, 'utf8')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hash = contentHash
const dir = (files = {}) => {
  const path = join(scratch, `project-${++count}`)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(path, name, '..'), { recursive: true })
    writeFileSync(join(path, name), content)
  }
  mkdirSync(path, { recursive: true })
  return path
}
const profile = (name) => {
  const path = join(scratch, `profile-${name}`)
  mkdirSync(path, { recursive: true })
  return path
}
const snapshot = (base, at = base) =>
  Object.fromEntries(
    readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      const path = join(at, entry.name)
      if (entry.name === '.git' || entry.name === 'node_modules') return []
      return entry.isDirectory()
        ? Object.entries(snapshot(base, path))
        : [[relative(base, path), readFileSync(path).toString('base64')]]
    })
  )

let binary
async function fixture(home, env = {}) {
  const started = await startSourceFixture(binary, home, env)
  fixtures.add(started)
  return started
}
async function stop(started) {
  await started.stop()
  fixtures.delete(started)
}
function install(started) {
  const owners = started.owners()
  setRepositoryOwner(owners.repository)
  setSourceOwner(owners.source)
  return owners
}
function reset() {
  setRepositoryOwner(null)
  setSourceOwner(null)
}
async function section(name, run) {
  await run()
  console.log(`SOURCE-OWNER ${name} PASS`)
}

const commit = (started, rootPath, edits, extra = {}) =>
  started.frame('commit', { root: rootPath, edits, ...extra })
const edit = (path, before, content) => ({ path, expectedHash: hash(before), content })

try {
  binary = compileSourceFixture()

  await section('engines', async () => {
    const line = (base, file, needle) =>
      read(join(base, file))
        .split('\n')
        .findIndex((text) => text.includes(needle)) + 1
    const cases = {
      'propedit-app': (base) => [
        () =>
          applyPropEdit(base, {
            source: `src/Badge.tsx:${line(base, 'src/Badge.tsx', 'label="Ready"')}`,
            name: 'label',
            kind: 'string',
            value: 'Done'
          }),
        () =>
          applyTextEdit(base, {
            source: `src/Badge.tsx:${line(base, 'src/Badge.tsx', '>Welcome<')}`,
            text: 'Hello there'
          }),
        () =>
          applyStyleEdit(base, {
            source: `src/Badge.tsx:${line(base, 'src/Badge.tsx', "color: '#111827'")}`,
            prop: 'color',
            value: '#ff0000',
            classes: ['sw']
          }),
        'undo',
        'redo',
        'undo',
        'undo'
      ],
      'svelte-app': (base) => [
        () =>
          applyPropEdit(base, {
            source: `src/Card.svelte:${line(base, 'src/Card.svelte', 'label="Go"')}`,
            name: 'label',
            kind: 'string',
            value: 'Stop'
          }),
        () =>
          applyTextEdit(base, {
            source: `src/Card.svelte:${line(base, 'src/Card.svelte', '>Original<')}`,
            text: 'Changed'
          }),
        'undo',
        'redo'
      ],
      'editable-app': (base) => [
        () => applyTextEdit(base, { source: 'index.html:4:3', text: 'New heading' }),
        'undo',
        'redo'
      ],
      'layers-app': (base) => [
        () =>
          applyMoveNode(base, {
            dragged: { source: 'src/Layers.tsx:9' },
            target: { source: 'src/Layers.tsx:7' },
            position: 'before',
            sessionId: 'engines'
          }),
        'undo',
        'redo'
      ]
    }
    const owned = await fixture(profile('engines'))
    install(owned)
    for (const [name, ops] of Object.entries(cases)) {
      const base = join(scratch, `engines-${name}`)
      cpSync(join(root, 'test/fixtures', name), base, {
        recursive: true,
        filter: (path) => !path.includes('node_modules')
      })
      execFileSync('git', ['init', '-q'], { cwd: base })
      // Every edit changes source; Undo and Redo walk back to the exact bytes of each step.
      const states = [snapshot(base)]
      let at = 0
      for (const [index, op] of ops(base).entries()) {
        const result =
          op === 'undo' ? await undo(base) : op === 'redo' ? await redo(base) : await op()
        assert.ok(
          result.applied !== false && result.ok !== false,
          `${name} step ${index} applies: ${JSON.stringify(result)}`
        )
        if (op === 'undo') at--
        else if (op === 'redo') at++
        else {
          states.splice(++at, states.length, snapshot(base))
          assert.notDeepEqual(states[at], states[at - 1], `${name} step ${index} changed source`)
        }
        assert.deepEqual(snapshot(base), states[at], `${name} step ${index} files`)
      }
    }
    reset()
    // The island/style suite (shadow-controls) runs on the Swift owners itself.
    await stop(owned)
  })

  await section('proposals', async () => {
    const owned = await fixture(profile('proposals'))
    install(owned)
    const base = dir({ 'a.ts': 'export const a = 1\n' })
    const file = join(base, 'a.ts')
    // Two parses of the same text: the first commits, the second (out of order) is stale.
    const first = proposeEdit(base, file, 'export const a = 1\n', 'export const a = 2\n', 'a')
    const second = proposeEdit(base, file, 'export const a = 1\n', 'export const a = 3\n', 'a')
    assert.deepEqual(await first, { applied: true })
    assert.equal((await second).applied, false)
    assert.equal(read(file), 'export const a = 2\n')
    // An external edit after the parse: nothing is written over it.
    writeFileSync(file, 'external\n')
    assert.match(
      (await proposeEdit(base, file, 'export const a = 2\n', 'x\n', 'a')).error,
      /changed since it was read/
    )
    assert.equal(read(file), 'external\n')
    // A cancelled (deadline-expired) proposal waiting for the lane never starts later.
    const lease = await owned.frame('acquire', { root: base }, {}, 'repository')
    const expired = owned.frame(
      'commit',
      { root: base, edits: [edit('a.ts', 'external\n', 'late\n')] },
      { timeoutMilliseconds: 150 }
    )
    await sleep(400)
    await owned.frame('release', { lease: lease.payload.lease }, {}, 'repository')
    assert.equal((await expired).payload.code, 'deadlineExceeded')
    assert.equal(read(file), 'external\n')
    // Invalid schemas are refused before anything runs.
    const invalid = [
      { root: base, edits: [{ path: 'a.ts', expectedHash: hash('external\n') }] },
      { root: base, edits: [{ ...edit('a.ts', 'external\n', 'x'), extra: 1 }] },
      { root: base, edits: [{ path: 'a.ts', expectedHash: 'abc', content: 'x' }] },
      {
        root: base,
        edits: [edit('a.ts', 'external\n', 'x'), edit(join(base, 'a.ts'), 'external\n', 'y')]
      },
      { root: base, edits: [] },
      { root: base, edits: [edit('a.ts', 'external\n', '\ud800')] },
      { root: base, edits: [edit('a.ts', 'external\n', 'nul\u0000')] },
      { root: 'relative', edits: [edit('a.ts', 'external\n', 'x')] },
      { root: base, edits: [edit('a.ts', 'external\n', 'x')], surprise: true }
    ]
    for (const body of invalid)
      assert.equal(
        (await owned.frame('commit', body)).payload.code,
        'invalidRequest',
        JSON.stringify(body)
      )
    assert.equal(
      (
        await owned.frame(
          'commit',
          { root: base, edits: [edit('a.ts', 'external\n', 'x')] },
          { expectedRevision: { epoch: 'e', counter: '1' } }
        )
      ).payload.code,
      'invalidRequest'
    )
    assert.equal(
      (
        await owned.frame(
          'commit',
          { root: base, edits: [edit('a.ts', 'external\n', 'x')] },
          { scope: { project: 'p' } }
        )
      ).payload.code,
      'unauthorized'
    )
    assert.equal(
      (await owned.frame('deleteFile', { root: base, path: 'a.ts' })).payload.code,
      'invalidRequest',
      'delete needs its intent'
    )
    assert.equal(read(file), 'external\n')
    reset()
    await stop(owned)
  })

  await section('paths', async () => {
    const owned = await fixture(profile('paths'))
    const base = dir({ 'src/a.ts': 'a\n', 'node_modules/x/index.js': 'dep\n' })
    const outside = dir({ 'secret.txt': 'secret\n' })
    symlinkSync(join(outside, 'secret.txt'), join(base, 'src/escape.ts'))
    symlinkSync(outside, join(base, 'linked'))
    symlinkSync(join(base, 'src/a.ts'), join(base, 'alias.ts'))
    for (const path of [
      '../secret.txt',
      join(outside, 'secret.txt'),
      '.git/config',
      'node_modules/x/index.js',
      'src/escape.ts',
      'linked/secret.txt',
      '.trezi/x.json'
    ]) {
      assert.equal(
        (await commit(owned, base, [edit(path, 'secret\n', 'owned\n')])).payload.code,
        'unauthorized',
        path
      )
      assert.equal(
        (await owned.frame('read', { root: base, path })).payload.code,
        'unauthorized',
        path
      )
    }
    assert.equal(read(join(outside, 'secret.txt')), 'secret\n')
    for (const [op, body] of [
      ['createFile', { path: 'linked/new.ts' }],
      ['renameFile', { path: 'src/a.ts', to: 'linked/a.ts' }],
      ['deleteFile', { path: 'src/escape.ts', intent: 'trash' }]
    ]) {
      assert.deepEqual(
        (await owned.frame(op, { root: base, ...body })).payload,
        { ok: false, error: 'That path is not allowed.' },
        op
      )
    }
    assert.deepEqual(readdirSync(outside), ['secret.txt'])
    // A link to another project file writes that file; the link stays a link.
    assert.equal((await commit(owned, base, [edit('alias.ts', 'a\n', 'b\n')])).payload.ok, true)
    assert.equal(read(join(base, 'src/a.ts')), 'b\n')
    assert.ok(
      execFileSync('stat', ['-f', '%HT', join(base, 'alias.ts')], { encoding: 'utf8' }).startsWith(
        'Symbolic'
      )
    )
    const view = (await owned.frame('read', { root: base, path: join(base, 'src/a.ts') })).payload
    assert.deepEqual(view, {
      path: 'src/a.ts',
      size: 2,
      hash: hash('b\n'),
      binary: false,
      content: 'b\n'
    })
    await stop(owned)
  })

  await section('transactions', async () => {
    const owned = await fixture(profile('transactions'))
    const base = dir({ 'a.ts': 'a0\n', 'b.ts': 'b0\n', 'locked/c.ts': 'c0\n' })
    // One stale file refuses the whole batch.
    const stale = await commit(owned, base, [
      edit('a.ts', 'a0\n', 'a1\n'),
      edit('b.ts', 'bX\n', 'b1\n')
    ])
    assert.deepEqual(stale.payload, { ok: false, conflict: true, file: 'b.ts' })
    assert.deepEqual([read(join(base, 'a.ts')), read(join(base, 'b.ts'))], ['a0\n', 'b0\n'])
    // A write failing midway puts back the files already written.
    chmodSync(join(base, 'locked'), 0o555)
    const failed = await commit(owned, base, [
      edit('a.ts', 'a0\n', 'a1\n'),
      edit('b.ts', 'b0\n', 'b1\n'),
      edit('locked/c.ts', 'c0\n', 'c1\n')
    ])
    chmodSync(join(base, 'locked'), 0o755)
    assert.equal(failed.payload.code, 'ioFailure')
    assert.deepEqual(
      [read(join(base, 'a.ts')), read(join(base, 'b.ts')), read(join(base, 'locked/c.ts'))],
      ['a0\n', 'b0\n', 'c0\n']
    )
    assert.deepEqual((await owned.frame('history', { root: base })).payload, {
      undo: false,
      redo: false
    })
    const applied = await commit(
      owned,
      base,
      [edit('a.ts', 'a0\n', 'a1\n'), edit('b.ts', 'b0\n', 'b1\n')],
      { group: 'g' }
    )
    assert.deepEqual(applied.payload, {
      ok: true,
      files: ['a.ts', 'b.ts'],
      hashes: [hash('a1\n'), hash('b1\n')]
    })
    assert.deepEqual((await owned.frame('status', {})).payload, { interrupted: [] })
    assert.deepEqual(readdirSync(join(profile('transactions'), 'service/source/journal')), [])
    await stop(owned)
  })

  await section('crash', async () => {
    const home = profile('crash')
    const base = dir({ 'a.ts': 'a0\n', 'b.ts': 'b0\n', 'c.ts': 'c0\n' })
    // SIGKILL after the first file of a commit: the next launch puts it back.
    let owned = await fixture(home, { SOURCE_FAULT: 'commit.write.1' })
    commit(owned, base, [edit('a.ts', 'a0\n', 'a1\n'), edit('b.ts', 'b0\n', 'b1\n')])
    assert.equal((await owned.exited).signal, 'SIGKILL')
    fixtures.delete(owned)
    assert.equal(read(join(base, 'a.ts')), 'a1\n')
    owned = await fixture(home)
    assert.deepEqual([read(join(base, 'a.ts')), read(join(base, 'b.ts'))], ['a0\n', 'b0\n'])
    let [report] = (await owned.frame('status', {})).payload.interrupted
    assert.deepEqual(
      [report.kind, report.restored, report.unchanged, report.kept],
      ['commit', [join(base, 'a.ts')], [join(base, 'b.ts')], []]
    )
    assert.equal(
      (await owned.frame('acknowledge', { operationID: report.operationID })).payload.code,
      'invalidRequest'
    )
    assert.equal(
      (await owned.frame('acknowledge', { operationID: report.operationID, intent: 'acknowledge' }))
        .kind,
      'succeeded'
    )
    await stop(owned)

    // SIGKILL midway through a grouped Undo, then the user edits one of its files before
    // the relaunch: that file is kept (pre-image preserved), the other is put back.
    owned = await fixture(home, { SOURCE_FAULT: 'undo.write.1' })
    assert.equal(
      (
        await commit(owned, base, [edit('b.ts', 'b0\n', 'b1\n'), edit('c.ts', 'c0\n', 'c1\n')], {
          group: 'turn'
        })
      ).payload.ok,
      true
    )
    owned.frame('undo', { root: base })
    assert.equal((await owned.exited).signal, 'SIGKILL')
    fixtures.delete(owned)
    // Undo walks the group newest first: it wrote c.ts, then died before b.ts.
    assert.equal(read(join(base, 'c.ts')), 'c0\n', 'the Undo wrote its first file')
    writeFileSync(join(base, 'b.ts'), 'user\n')
    const second = await fixture(home)
    ;[report] = (await second.frame('status', {})).payload.interrupted
    assert.equal(report.kind, 'undo')
    // c.ts held the Undo's bytes and is put back; b.ts was never written by it and the
    // user changed it since: kept as the user left it, the pre-image beside the report.
    assert.deepEqual([report.restored, report.kept], [[join(base, 'c.ts')], [join(base, 'b.ts')]])
    assert.deepEqual([read(join(base, 'b.ts')), read(join(base, 'c.ts'))], ['user\n', 'c1\n'])
    assert.equal(read(report.copies[0]), 'b1\n')
    await stop(second)

    // A crash after an external edit to a file it already wrote: kept, pre-image copied.
    owned = await fixture(home, { SOURCE_FAULT: 'commit.write.1' })
    commit(owned, base, [edit('a.ts', 'a0\n', 'a2\n'), edit('b.ts', 'user\n', 'b2\n')])
    await owned.exited
    fixtures.delete(owned)
    writeFileSync(join(base, 'a.ts'), 'newer\n')
    const third = await fixture(home)
    const reports = (await third.frame('status', {})).payload.interrupted
    assert.equal(reports.length, 2, 'the unacknowledged Undo report is still listed')
    report = reports.find((r) => r.kind === 'commit')
    assert.deepEqual([report.kept, report.unchanged], [[join(base, 'a.ts')], [join(base, 'b.ts')]])
    assert.equal(read(join(base, 'a.ts')), 'newer\n', 'newer work is never overwritten')
    assert.equal(read(report.copies[0]), 'a0\n', 'the pre-image is preserved beside the report')
    // A damaged journal entry is refused untouched; file operations still work.
    await stop(third)
    const damaged = join(home, 'service/source/journal', `${crypto.randomUUID()}.json`)
    writeFileSync(damaged, '{not json')
    const fourth = await fixture(home)
    assert.match((await fourth.frame('status', {})).payload.journal, /unreadable/)
    assert.equal(
      (await commit(fourth, base, [edit('b.ts', 'user\n', 'b3\n')])).payload.code,
      'recoveryRequired'
    )
    assert.equal(
      (await fourth.frame('createFile', { root: base, path: 'still.ts' })).payload.ok,
      true
    )
    assert.equal(read(damaged), '{not json')
    await stop(fourth)
  })

  await section('history', async () => {
    const owned = await fixture(profile('history'))
    install(owned)
    const base = dir({ 'a.ts': 'A1', 'b.ts': 'B1', 'c.ts': 'C1' }),
      other = dir({ 'x.ts': 'X1' })
    const at = (name) => join(base, name)
    // Coalesced burst: one Undo restores the original.
    for (const [from, to] of [
      ['A1', 'A2'],
      ['A2', 'A3']
    ])
      assert.equal((await proposeEdit(base, at('a.ts'), from, to, 'k')).applied, true)
    assert.equal((await proposeEdit(other, join(other, 'x.ts'), 'X1', 'X2', 'k')).applied, true)
    assert.deepEqual(await undo(base), { ok: true, file: at('a.ts') })
    assert.equal(read(at('a.ts')), 'A1')
    assert.equal(read(join(other, 'x.ts')), 'X2', 'history is per project')
    assert.deepEqual(await redo(base), { ok: true, file: at('a.ts') })
    // A landed chat turn recorded after the fact is revertable as a group, addressably.
    writeFileSync(at('b.ts'), 'B2')
    writeFileSync(at('c.ts'), 'C2')
    recordEdit(base, at('b.ts'), 'B1', 'B2', undefined, 'chat:wt:1')
    recordEdit(base, at('c.ts'), 'C1', 'C2', undefined, 'chat:wt:1')
    assert.equal((await proposeEdit(base, at('a.ts'), 'A3', 'A4', 'later')).applied, true)
    assert.equal(await canRevertGroup(base, 'chat:wt:1'), true)
    assert.deepEqual(await revertGroup(base, 'chat:wt:1'), { ok: true, file: at('c.ts') })
    assert.deepEqual([read(at('b.ts')), read(at('c.ts')), read(at('a.ts'))], ['B1', 'C1', 'A4'])
    // Drift refuses the whole group without writing.
    writeFileSync(at('b.ts'), 'B5')
    writeFileSync(at('c.ts'), 'C5')
    recordEdit(base, at('b.ts'), 'B1', 'B5', undefined, 'turn2')
    recordEdit(base, at('c.ts'), 'C1', 'C5', undefined, 'turn2')
    writeFileSync(at('c.ts'), 'USER')
    assert.deepEqual(await undo(base), { ok: false, conflict: true, file: at('c.ts') })
    assert.equal(read(at('b.ts')), 'B5')
    reset()
    await stop(owned)
  })

  await section('files', async () => {
    const owned = await fixture(profile('files'))
    install(owned)
    const base = dir({ 'a.ts': 'a', 'adir/x.ts': 'x' })
    assert.deepEqual(await createProjectFile(base, 'src/new/Thing.tsx'), {
      ok: true,
      path: 'src/new/Thing.tsx'
    })
    assert.equal(read(join(base, 'src/new/Thing.tsx')), '')
    assert.deepEqual(await createProjectFile(base, 'a.ts'), {
      ok: false,
      error: 'Something already exists at that path.'
    })
    assert.deepEqual(await createProjectFile(base, '.git/hooks/pre-commit'), {
      ok: false,
      error: 'That path is not allowed.'
    })
    assert.deepEqual(await renameProjectFile(base, 'a.ts', 'A.ts'), { ok: true, path: 'A.ts' })
    assert.deepEqual(await renameProjectFile(base, 'A.ts', 'moved/deep/b.ts'), {
      ok: true,
      path: 'moved/deep/b.ts'
    })
    assert.deepEqual(await renameProjectFile(base, 'adir', 'bdir'), {
      ok: false,
      error: 'Only files can be renamed.'
    })
    assert.deepEqual(await deleteProjectFile(base, 'adir'), {
      ok: false,
      error: 'Only files can be deleted.'
    })
    assert.deepEqual(await deleteProjectFile(base, 'moved/deep/b.ts'), {
      ok: true,
      path: 'moved/deep/b.ts'
    })
    assert.equal(existsSync(join(base, 'moved/deep/b.ts')), false)
    assert.deepEqual(await deleteProjectFile(base, 'gone.ts'), {
      ok: false,
      error: 'That file no longer exists.'
    })
    // LKM-207: a states workbench folder and its seam files leave in one step; only a
    // folder holding the manifest qualifies, and seams stay outside it.
    const bench = dir({
      'trezi-states/list/trezi-workbench.json': '{}',
      'trezi-states/list/index.html': '<div></div>',
      'src/route-list.ts': 'x',
      'keep.ts': 'k'
    })
    const remove = async (path, seams) =>
      (await owned.frame('removeWorkbench', { root: bench, path, seams, intent: 'trash' })).payload
    assert.deepEqual(await remove('src', []), {
      ok: false,
      error: 'That folder is not a states workbench.'
    })
    assert.deepEqual(await remove('trezi-states/list', ['trezi-states/list/index.html']), {
      ok: false,
      error: 'That path is not allowed.'
    })
    assert.deepEqual(await remove('trezi-states/list', ['.git/config']), {
      ok: false,
      error: 'That path is not allowed.'
    })
    assert.deepEqual(await remove('trezi-states/list', ['src/route-list.ts', 'gone.ts']), {
      ok: true,
      path: 'trezi-states/list'
    })
    assert.equal(existsSync(join(bench, 'trezi-states/list')), false)
    assert.equal(existsSync(join(bench, 'src/route-list.ts')), false)
    assert.equal(read(join(bench, 'keep.ts')), 'k')
    reset()
    await stop(owned)
  })

  await section('drafts', async () => {
    const home = profile('drafts')
    const base = dir({ 'a.ts': 'saved\n' })
    let owned = await fixture(home)
    install(owned)
    const view = await readSourceView(base, 'a.ts:1')
    assert.equal(view.hash, hash('saved\n'))
    assert.equal(
      (
        await owned.frame('saveDraft', {
          root: base,
          path: 'a.ts',
          base: view.hash,
          text: 'draft one\n'
        })
      ).kind,
      'succeeded'
    )
    assert.equal(
      (await owned.frame('saveDraft', { root: base, path: '../x', base: view.hash, text: 'x' }))
        .payload.code,
      'invalidRequest'
    )
    reset()
    await stop(owned)
    // After a restart the draft comes back; with the file changed meanwhile it is stale.
    writeFileSync(join(base, 'a.ts'), 'external\n')
    owned = await fixture(home)
    const [draft] = (await owned.frame('drafts', { root: base })).payload
    assert.deepEqual(draft, {
      path: 'a.ts',
      base: hash('saved\n'),
      text: 'draft one\n',
      current: hash('external\n')
    })
    // Saving the restored draft against its own base is refused: newer work survives.
    assert.deepEqual(
      (await commit(owned, base, [{ path: 'a.ts', expectedHash: draft.base, content: draft.text }]))
        .payload,
      { ok: false, conflict: true, file: 'a.ts' }
    )
    assert.equal(read(join(base, 'a.ts')), 'external\n')
    assert.equal((await owned.frame('clearDraft', { root: base, path: 'a.ts' })).kind, 'succeeded')
    assert.deepEqual((await owned.frame('drafts', { root: base })).payload, [])
    await stop(owned)
    // A damaged drafts file is refused and left as found.
    const file = join(home, 'service/source/drafts', `${hash(base)}.json`)
    writeFileSync(file, '{broken')
    owned = await fixture(home)
    assert.equal((await owned.frame('drafts', { root: base })).payload.code, 'recoveryRequired')
    assert.equal(
      (await owned.frame('saveDraft', { root: base, path: 'a.ts', base: hash('x'), text: 'y' }))
        .payload.code,
      'recoveryRequired'
    )
    assert.equal(read(file), '{broken')
    await stop(owned)
  })

  await section('lanes', async () => {
    const owned = await fixture(profile('lanes'))
    install(owned)
    const base = dir({ 'a.ts': 'one' })
    execFileSync('git', ['init', '-q'], { cwd: base })
    const log = []
    // Another chain's lease holds the repository: the proposal waits for it. Acquiring
    // is a service round trip, so propose only once the lease is granted (a fixed delay
    // raced the grant on a loaded host).
    let granted
    const leased = new Promise((resolve) => {
      granted = resolve
    })
    const held = enqueueRepoWrite(base, async () => {
      granted()
      await sleep(300)
      log.push('lease end')
    })
    await leased
    const waiting = proposeEdit(base, join(base, 'a.ts'), 'one', 'two', 'k').then((r) => {
      log.push('commit')
      return r
    })
    await Promise.all([held, waiting])
    assert.deepEqual(log, ['lease end', 'commit'])
    // Inside the chain's own lease it runs in that lease (no deadlock).
    const inside = await Promise.race([
      enqueueRepoWrite(base, () => proposeEdit(base, join(base, 'a.ts'), 'two', 'three', 'k')),
      sleep(10_000).then(() => 'deadlock')
    ])
    assert.deepEqual(inside, { applied: true })
    reset()
    await stop(owned)
  })

  await section('relaunch', async () => {
    const home = profile('relaunch')
    const base = dir({ 'a.ts': 'one' })
    let owned = await fixture(home)
    install(owned)
    assert.equal((await proposeEdit(base, join(base, 'a.ts'), 'one', 'two', 'k')).applied, true)
    await owned.frame('saveDraft', { root: base, path: 'a.ts', base: hash('two'), text: 'draft' })
    reset()
    await stop(owned)
    // Without the service nothing writes: there is no other owner to fall back to.
    const kept = snapshot(join(home, 'service/source'))
    assert.match(
      (await proposeEdit(base, join(base, 'a.ts'), 'two', 'three', 'k')).error,
      /service is not running/
    )
    await assert.rejects(async () => undo(base), /service is not running/)
    await assert.rejects(async () => createProjectFile(base, 'b.ts'), /service is not running/)
    assert.deepEqual(snapshot(base), { 'a.ts': Buffer.from('two').toString('base64') })
    assert.deepEqual(snapshot(join(home, 'service/source')), kept)
    // Relaunched: it writes where it left off, the draft is still there, nothing was interrupted.
    owned = await fixture(home)
    install(owned)
    assert.equal((await proposeEdit(base, join(base, 'a.ts'), 'two', 'three', 'k2')).applied, true)
    assert.equal((await owned.frame('drafts', { root: base })).payload[0].text, 'draft')
    assert.deepEqual((await owned.frame('status', {})).payload, { interrupted: [] })
    reset()
    await stop(owned)
  })

  await section('drain', async () => {
    const owned = await fixture(profile('drain'))
    const base = dir({ 'a.ts': 'one' })
    const lease = await owned.frame('acquire', { root: base }, {}, 'repository')
    const queued = commit(owned, base, [edit('a.ts', 'one', 'two')])
    await sleep(100)
    assert.equal((await owned.cmd({ cmd: 'close' })).closed, true)
    assert.equal((await queued).payload.code, 'unavailable')
    assert.equal(
      (await commit(owned, base, [edit('a.ts', 'one', 'two')])).payload.code,
      'unavailable'
    )
    assert.equal(read(join(base, 'a.ts')), 'one')
    assert.ok(lease.kind === 'succeeded')
    await stop(owned)
  })

  await section('helpers', async () => {
    // Parsers and edit engines only propose: none of them may write, rename or delete a file.
    const engines = [
      'props',
      'props-svelte',
      'props-typescript',
      'styles',
      'styles-svelte',
      'move-node',
      'move-node-svelte',
      'move-node-html',
      'move-node-splice',
      'html-source',
      'tw-styles',
      'tw-classes',
      'inline-style',
      'style-tokens',
      'ast-walk',
      'svelte-instance',
      'chat-island-source'
    ]
    for (const name of engines) {
      const code = read(join(root, 'src/main', `${name}.ts`))
      assert.doesNotMatch(
        code,
        /\b(writeFile|writeFileSync|appendFile|rename|renameSync|unlink|rm|rmSync|copyFile|truncate|open)\b\s*[,(}]/,
        `${name}.ts must not write files`
      )
      assert.doesNotMatch(code, /recordEdit/, `${name}.ts must not own Undo state`)
    }
  })

  console.log('SOURCE-OWNER OK')
} finally {
  reset()
  for (const started of fixtures) {
    try {
      started.child.kill('SIGKILL')
    } catch {}
  }
  rmSync(scratch, { recursive: true, force: true })
}
