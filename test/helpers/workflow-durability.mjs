// The Swift workflow owner's durability checks (S13), run by test/workflow-owner.mjs with
// its scratch worlds: a remote effect whose reply is lost, crashes between an effect
// and its receipt, GitHub failing after acting, install/build failures and their
// resumption, cancellation, busy, restart listing and dismissal, drain, a relaunch that
// finishes an interrupted publish, redaction and schema.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerDiagnoseIpc } from '../../src/main/diagnose.ts'
import { setWorkflowOwner } from '../../src/main/workflow-owner.ts'
import { ipcMain } from '../../src/native/platform.ts'

export async function durability({ world, start, snapshot, git, write, commit, describe, log }) {
  const gh = (w) => w.gh().counts ?? {}
  const setGh = (w, change) => {
    const state = w.gh()
    change(state)
    writeFileSync(w.ghState, JSON.stringify(state))
  }
  const setPm = (w, value) => writeFileSync(w.pmState, JSON.stringify(value))
  const journal = (w) =>
    readdirSync(join(w.profile, 'service/workflows')).map((name) =>
      readFileSync(join(w.profile, 'service/workflows', name), 'utf8')
    )
  // LKM-185: after a merge the work branch is kept and merges the squashed main, never reset to it.
  const synced = (w) => {
    assert.equal(git(w.local, 'rev-parse', '--abbrev-ref', 'HEAD'), 'trezi/main')
    git(w.local, 'merge-base', '--is-ancestor', git(w.origin, 'rev-parse', 'main'), 'HEAD')
    assert.equal(
      git(w.local, 'rev-parse', 'HEAD^{tree}'),
      git(w.origin, 'rev-parse', 'main^{tree}')
    )
  }
  const steps = (record) => record.steps.map((step) => `${step.name}:${step.state}`)
  const crashed = async (fixture, promise) => {
    await assert.rejects(promise, (error) => error.code === 'deadlineExceeded')
    const status = await fixture.exited
    assert.equal(status.signal, 'SIGKILL')
  }

  // A reply lost after each phase: the same operation is answered from its receipt.
  {
    const w = world('lost-reply'),
      f = await start(w)
    const owner = f.workflows({ timeout: 4000, retries: 2 })
    write(w.local, 'a.txt', 'two\n')
    await f.cmd({ cmd: 'drop', count: 1 })
    const result = await owner.publish(w.local, 'merge', async (base) => {
      await f.cmd({ cmd: 'drop', count: 1 })
      return describe(base)
    })
    assert.equal(result.ok, true)
    assert.deepEqual(gh(w), { prCreate: 1, prMerge: 1 })
    const [record] = await owner.workflows()
    assert.deepEqual(steps(record), [
      'commit:done',
      'push:done',
      'pr:done',
      'merge:done',
      'cleanup:done'
    ])
    assert.equal(record.state, 'done')
    log('durability lost replies')
  }

  // A crash after the PR was created, before its receipt: the next publish adopts it.
  {
    const w = world('crash-pr')
    write(w.local, 'a.txt', 'two\n')
    const f1 = await start(w, { WORKFLOW_FAULT: 'publish.pr' })
    await crashed(
      f1,
      f1.workflows({ timeout: 3000, retries: 0 }).publish(w.local, 'merge', describe)
    )
    const f2 = await start(w),
      owner = f2.workflows()
    const [interrupted] = await owner.workflows()
    assert.equal(interrupted.state, 'interrupted')
    assert.deepEqual(steps(interrupted), ['commit:done', 'push:done', 'pr:uncertain'])
    const result = await owner.publish(w.local, 'merge', describe)
    assert.equal(result.ok, true)
    assert.equal(result.url, 'https://github.com/fake/repo/pull/1')
    assert.deepEqual(gh(w), { prCreate: 1, prEdit: 1, prMerge: 1 })
    const all = await owner.workflows()
    assert.deepEqual(
      all.map((r) => r.state),
      ['superseded', 'done']
    )
    // Restart listing and dismissal: only an unfinished record can be dismissed.
    await assert.rejects(owner.dismiss(all[0].id), (error) => error.code === 'conflict')
    await assert.rejects(owner.dismiss(all[1].id), (error) => error.code === 'conflict')
    log('durability crash after PR')
  }

  // A crash after the merge, before its receipt: no second merge, the cleanup finishes.
  {
    const w = world('crash-merge')
    write(w.local, 'a.txt', 'two\n')
    const f1 = await start(w, { WORKFLOW_FAULT: 'publish.merge' })
    await crashed(
      f1,
      f1.workflows({ timeout: 3000, retries: 0 }).publish(w.local, 'merge', describe)
    )
    const owner = (await start(w)).workflows()
    const result = await owner.publish(w.local, 'merge', describe)
    assert.equal(result.ok, true)
    assert.deepEqual(gh(w), { prCreate: 1, prMerge: 1 })
    const state = snapshot(w)
    assert.deepEqual(state.remote, ['main'])
    assert.equal(state.mainLog[0], 'Update the greeting (#1)')
    synced(w)
    const done = (await owner.workflows()).at(-1)
    assert.deepEqual(done.steps.find((step) => step.name === 'merge').receipt, { adopted: true })
    log('durability crash after merge')
  }

  // GitHub created the PR but its reply failed: adopted, not duplicated.
  {
    const w = world('gh-lost'),
      owner = (await start(w)).workflows()
    setGh(w, (state) => {
      state.faults = ['pr-create-lost', 'pr-merge-lost']
    })
    write(w.local, 'a.txt', 'two\n')
    const failed = await owner.publish(w.local, 'merge', describe)
    assert.equal(failed.ok, false)
    assert.match(failed.error, /Gateway Timeout/)
    assert.deepEqual(gh(w), { prCreate: 1, prEdit: 1, prMerge: 1 })
    const again = await owner.publish(w.local, 'merge', describe)
    assert.equal(again.ok, true, JSON.stringify(again))
    assert.deepEqual(gh(w), { prCreate: 1, prEdit: 1, prMerge: 1 })
    synced(w)
    log('durability GitHub failing after acting')
  }

  // Connect: a crash after the repository was created, and GitHub failing after creating it.
  for (const [name, env, faults] of [
    ['connect-crash', { WORKFLOW_FAULT: 'connect.repo' }, []],
    ['connect-lost', {}, ['repo-create-lost']]
  ]) {
    const w = world(name, { remote: false })
    setGh(w, (state) => {
      state.faults = faults
    })
    const f1 = await start(w, env),
      options = { name: 'demo-app', owner: 'octo', private: false }
    if (env.WORKFLOW_FAULT)
      await crashed(f1, f1.workflows({ timeout: 3000, retries: 0 }).connect(w.local, options))
    else assert.equal((await f1.workflows().connect(w.local, options)).ok, false)
    const owner = (await start(w)).workflows()
    const result = await owner.connect(w.local, options)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(gh(w).repoCreate, 1)
    assert.equal(
      git(
        join(w.base, 'repos/octo/demo-app.git'),
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads'
      ),
      'main\ntrezi/main'
    )
    assert.deepEqual(
      (await owner.workflows()).at(-1).steps.find((step) => step.name === 'repo').receipt,
      { slug: 'octo/demo-app', adopted: true }
    )
  }
  log('durability connect adoption')

  // Trezi update: install and build failures resume without pulling again; a crash after the pull.
  {
    const w = world('update')
    git(w.local, 'checkout', '-q', 'main')
    const peer = w.peer()
    commit(peer, 'release.txt', 'v2\n')
    git(peer, 'push', '-q', 'origin', 'main')
    const owner = (await start(w)).workflows()
    setPm(w, { fail: { install: 1 } })
    const failed = await owner.update(w.local)
    assert.equal(failed.ok, false)
    assert.match(failed.error, /install failed \(fixture\)/)
    assert.equal(git(w.local, 'rev-parse', 'HEAD'), git(w.origin, 'rev-parse', 'main'))
    const [first] = await owner.workflows()
    assert.deepEqual(steps(first), ['pull:done', 'install:failed'])
    const pm = w.pm()
    pm.fail = { build: 1 }
    setPm(w, pm)
    assert.match((await owner.update(w.local)).error, /build failed/)
    assert.deepEqual(await owner.update(w.local), { ok: true })
    const records = await owner.workflows()
    assert.deepEqual(records.map(steps), [
      ['pull:done', 'install:failed'],
      ['pull:done', 'install:done', 'build:failed'],
      ['pull:done', 'install:done', 'build:done']
    ])
    // Every retry inherited the one pull (same receipt and time).
    assert.equal(new Set(records.map((r) => JSON.stringify(r.steps[0]))).size, 1)
    assert.deepEqual(w.pm().calls, [
      'bun install --frozen-lockfile',
      'bun install --frozen-lockfile',
      'bun run build:native',
      'bun install --frozen-lockfile',
      'bun run build:native'
    ])

    const w2 = world('update-crash')
    git(w2.local, 'checkout', '-q', 'main')
    const peer2 = w2.peer()
    commit(peer2, 'release.txt', 'v2\n')
    git(peer2, 'push', '-q', 'origin', 'main')
    const f1 = await start(w2, { WORKFLOW_FAULT: 'update.pull' })
    await crashed(f1, f1.workflows({ timeout: 3000, retries: 0 }).update(w2.local))
    const again = (await start(w2)).workflows()
    assert.deepEqual(steps((await again.workflows())[0]), ['pull:uncertain'])
    assert.deepEqual(await again.update(w2.local), { ok: true })
    assert.deepEqual(w2.pm().calls, ['bun install --frozen-lockfile', 'bun run build:native'])
    log('durability update failures and crash')
  }

  // A new project whose install failed is resumed, not refused as a non-empty folder.
  {
    const w = world('create'),
      owner = (await start(w)).workflows()
    setPm(w, { fail: { install: 1 } })
    const root = join(w.base, 'fresh')
    const files = { 'package.json': '{"name":"fresh"}\n', 'src/main.ts': 'console.log(1)\n' }
    const failed = await owner.createProject(root, files, 'bun')
    assert.match(
      failed.error,
      /^Project created, but bun install failed: Command failed: bun install/
    )
    const result = await owner.createProject(root, files, 'bun')
    assert.deepEqual(result, { ok: true, root })
    assert.equal(git(root, 'log', '--format=%s'), 'Initial commit from Trezi')
    assert.deepEqual(w.pm().calls, ['bun install', 'bun install'])
    log('durability project install resumed')
  }

  // Cancellation: a running install is stopped and nothing further runs; a publish
  // waiting for its description ends without a PR. A second publish meanwhile is busy.
  {
    const w = world('cancel')
    git(w.local, 'checkout', '-q', 'main')
    const peer = w.peer()
    commit(peer, 'release.txt', 'v2\n')
    git(peer, 'push', '-q', 'origin', 'main')
    const f = await start(w),
      owner = f.workflows()
    setPm(w, { sleep: { install: 20_000 } })
    const running = owner.update(w.local)
    for (let i = 0; i < 100 && !w.pm().calls?.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(await owner.cancel('update', w.local), true)
    const cancelled = await running
    assert.equal(cancelled.ok, false)
    assert.match(cancelled.error, /Cancelled/)
    assert.equal((await owner.workflows())[0].state, 'cancelled')
    setPm(w, { calls: [] })
    assert.deepEqual(await owner.update(w.local), { ok: true })
    assert.deepEqual(w.pm().calls, ['bun install --frozen-lockfile', 'bun run build:native'])

    git(w.local, 'checkout', '-q', 'trezi/main')
    write(w.local, 'a.txt', 'two\n')
    const first = await f.workflowFrame('publish', {
      root: w.local,
      mode: 'merge',
      intent: 'publish'
    })
    assert.equal(first.payload.stage, 'describe')
    const busy = await f.workflowFrame('publish', { root: w.local, mode: 'pr', intent: 'publish' })
    assert.deepEqual(busy.payload.result, {
      ok: false,
      error: 'A publish is already in progress for this repository.'
    })
    assert.equal(
      (await f.workflowFrame('cancel', { kind: 'publish', root: w.local })).payload.cancelled,
      true
    )
    const late = await f.workflowFrame('describe', {
      workflow: first.payload.workflow,
      title: 'T',
      body: 'B'
    })
    assert.equal(late.payload.code, 'conflict')
    assert.deepEqual(gh(w), {})
    assert.ok(snapshot(w).remote.includes('trezi/main'))
    log('durability cancellation and busy')
  }

  // A Swift publish cut short after the PR, finished by the relaunched owner (it reuses
  // the PR); its journal and the diagnoses survive the relaunch.
  {
    const w = world('relaunch')
    write(w.local, 'a.txt', 'two\n')
    const f1 = await start(w, { WORKFLOW_FAULT: 'publish.pr' })
    await crashed(
      f1,
      f1.workflows({ timeout: 3000, retries: 0 }).publish(w.local, 'merge', describe)
    )
    const owner = (await start(w)).workflows()
    assert.equal((await owner.workflows())[0].state, 'interrupted')
    assert.equal((await owner.publish(w.local, 'merge', describe)).ok, true)
    assert.equal(gh(w).prCreate, 1)
    assert.equal(gh(w).prMerge, 1)
    await owner.rememberDiagnosis(w.local, {
      signature: 'abc1',
      summary: 'Written before the relaunch',
      steps: [],
      seenBefore: false
    })
    assert.equal(
      (await owner.recallDiagnosis(w.local, 'abc1')).summary,
      'Written before the relaunch'
    )
    await owner.diagnosisStatus(w.local, 'abc1', 'dismissed')
    assert.equal((await owner.recallDiagnosis(w.local, 'abc1')).status, 'dismissed')
    // A damaged diagnoses file is never overwritten.
    writeFileSync(join(w.profile, 'diagnostics.json'), '{broken')
    await assert.rejects(
      owner.rememberDiagnosis(w.local, {
        signature: 'abc2',
        summary: 'x',
        steps: [],
        seenBefore: false
      }),
      (error) => error.code === 'recoveryRequired'
    )
    assert.equal(readFileSync(join(w.profile, 'diagnostics.json'), 'utf8'), '{broken')
    assert.equal(await owner.recallDiagnosis(w.local, 'abc1'), null)
    // The memory is best-effort: with the file damaged (or the write refused) the user
    // still gets the diagnosis, and recording their choice does not fail either.
    const handlers = {},
      handle = ipcMain.handle
    ipcMain.handle = (channel, handler) => {
      handlers[channel] = handler
    }
    registerDiagnoseIpc()
    ipcMain.handle = handle
    setWorkflowOwner(owner)
    try {
      const failure =
        'dyld: Library not loaded: /opt/homebrew/lib/libssl.dylib\nNode found at: /opt/homebrew/Cellar/node/1/bin/node\nAbort trap: 6'
      const diagnosis = await handlers['diagnose:run']({}, w.local, failure, 'expo run')
      assert.match(diagnosis.summary, /Node binary/)
      assert.ok(diagnosis.steps.length > 0)
      assert.equal(
        await handlers['diagnose:run']({}, w.local, failure).then((d) => d.summary),
        diagnosis.summary,
        'and again, every failure'
      )
      await handlers['diagnose:record']({}, w.local, diagnosis.signature, 'applied')
      assert.equal(
        readFileSync(join(w.profile, 'diagnostics.json'), 'utf8'),
        '{broken',
        'still never overwritten'
      )
      await assert.rejects(
        owner.rememberDiagnosis(w.local, {
          ...diagnosis,
          steps: Array.from({ length: 51 }, (_, i) => ({ text: `step ${i}`, scope: 'repo' }))
        }),
        (error) => error.code === 'invalidRequest'
      )
    } finally {
      setWorkflowOwner(null)
    }
    log('durability relaunch finishes the publish')
  }

  // The journal stays bounded: runs refused before their first effect (nothing to resume)
  // leave no record behind, and runs that stopped after some step keep only the newest few.
  {
    const w = world('bounded'),
      f = await start(w),
      owner = f.workflows()
    const dir = join(w.profile, 'service/workflows')
    const files = () => readdirSync(dir).filter((name) => name.endsWith('.json')).length
    const pull = { action: 'pull', ref: 'refs/remotes/origin/main', expectedBranch: 'trezi/main' }
    for (let i = 0; i < 25; i++)
      assert.equal((await owner.remoteUpdate(w.local, pull, true)).ok, false)
    const refused = (await owner.workflows()).filter((r) => r.kind === 'remoteUpdate')
    assert.equal(refused.length, 20, 'refused runs (no step began) keep only the newest 20 records')
    assert.ok(refused.every((r) => r.state === 'failed' && r.steps.length === 0))
    assert.equal(files(), 20)
    for (let i = 0; i < 13; i++)
      assert.equal(
        (await owner.publish(w.local, 'merge', describe)).error,
        'Nothing to publish — no changes since main.'
      )
    const publishes = (await owner.workflows()).filter((r) => r.kind === 'publish')
    // Each refusal began a step and left a receipt; the next request took it over (superseded).
    assert.deepEqual(
      [
        publishes.filter((r) => r.state === 'failed').length,
        publishes.filter((r) => r.state === 'superseded').length
      ],
      [1, 10],
      'the newest run stays resumable, only the newest 10 superseded ones are kept'
    )
    assert.equal(files(), 20 + 11)
    // A refused update of a dirty checkout counts against the same bound.
    const dirty = join(w.base, 'trezi-checkout')
    git(w.base, 'clone', '-q', w.origin, dirty)
    write(dirty, 'a.txt', 'local edit\n')
    for (let i = 0; i < 6; i++) assert.match((await owner.update(dirty)).error, /local changes/)
    assert.equal(files(), 20 + 11)
    const total = (await owner.workflows()).length
    // A restart loads only what is kept.
    await f.stop()
    const again = await start(w)
    assert.equal((await again.workflows().workflows()).length, total)
    log('durability bounded journal')
  }

  // Redaction: credentials echoed by git or gh never reach an answer or the journal.
  {
    const w = world('redact')
    git(w.local, 'checkout', '-q', '-b', 'trezi/chat-2')
    commit(w.local, 'c.txt', 'x\n')
    git(w.local, 'checkout', '-q', 'trezi/main')
    setGh(w, (state) => {
      state.faults = ['leak']
    })
    const owner = (await start(w)).workflows()
    const result = await owner.branchPr(w.local, 'trezi/chat-2', describe)
    assert.equal(result.ok, false)
    assert.match(result.error, /https:\/\/\*\*\*@github\.com/)
    assert.doesNotMatch(result.error, /s3cret|ghs_/)
    assert.ok(journal(w).every((text) => !/s3cret|ghs_/.test(text)))
    assert.ok(journal(w).some((text) => text.includes('***@github.com')))
    log('durability redaction')
  }

  // Drain and schema.
  {
    const w = world('schema'),
      f = await start(w)
    const invalid = async (method, body, request) =>
      assert.equal(
        (await f.workflowFrame(method, body, request)).payload.code,
        'invalidRequest',
        method
      )
    await invalid('publish', { root: w.local, mode: 'merge' })
    await invalid('publish', { root: w.local, mode: 'merge', intent: 'connect' })
    await invalid('publish', { root: w.local, mode: 'force', intent: 'publish' })
    await invalid('publish', { root: 'relative', mode: 'merge', intent: 'publish' })
    await invalid('publish', { root: w.local, mode: 'merge', intent: 'publish', extra: 1 })
    await invalid('workflows', {}, { mode: 'mutation' })
    await invalid('rewrite', { root: w.local })
    await invalid('setup', {
      root: w.local,
      files: [{ path: '../escape.cjs', content: 'x' }],
      intent: 'setup'
    })
    await invalid('setup', {
      root: w.local,
      files: [{ path: '.trezi/other.cjs', content: 'x' }],
      intent: 'setup'
    })
    await invalid('createProject', {
      root: join(w.base, 'p'),
      files: { '../evil': 'x' },
      install: null,
      intent: 'create'
    })
    await invalid('createProject', {
      root: join(w.base, 'p'),
      files: { '.git/config': 'x' },
      install: null,
      intent: 'create'
    })
    await invalid('createProject', {
      root: join(w.base, 'p'),
      files: { 'a.txt': 'x' },
      install: 'curl',
      intent: 'create'
    })
    await invalid('remoteUpdate', {
      root: w.local,
      action: 'pull',
      ref: 'refs/heads/main',
      expectedBranch: 'trezi/main',
      busy: false,
      intent: 'update'
    })
    await invalid('connect', {
      root: w.local,
      name: 'Bad Name',
      owner: 'octo',
      private: true,
      intent: 'connect'
    })
    await invalid('diagnosisStatus', { root: w.local, signature: 'abc', status: 'deleted' })
    assert.equal(
      (await f.workflowFrame('describe', { workflow: 'missing', title: 'T', body: 'B' })).payload
        .code,
      'conflict'
    )
    assert.equal((await f.cmd({ cmd: 'close' })).closed, true)
    const refused = await f.workflowFrame('publish', {
      root: w.local,
      mode: 'merge',
      intent: 'publish'
    })
    assert.equal(refused.payload.code, 'unavailable')
    assert.equal(refused.payload.retryable, true)
    log('durability drain and schema')
  }
}
