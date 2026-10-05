// The Swift workflow owner's feedback and skill-pack workflows (S15), run by
// test/workflow-owner.mjs with its scratch worlds: the ~60,000-character body crosses the
// pipe intact, preflight messages, gh failing after GitHub acted, a crash between
// `gh issue create` and its receipt (the retry finds the issue instead of filing another),
// user-scope installs in the service's HOME, and the owner refusing what the catalog
// would never send.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BODY_LIMIT, SAFE_LIMIT } from '../../src/shared/feedback-body.ts'

export async function toolChecks({ world, start, log }) {
  const setGh = (w, change) => {
    const state = w.gh()
    change(state)
    writeFileSync(w.ghState, JSON.stringify(state))
  }
  const crashed = async (fixture, promise) => {
    await assert.rejects(promise, (error) => error.code === 'deadlineExceeded')
    assert.equal((await fixture.exited).signal, 'SIGKILL')
  }
  const title = 'The sidebar loses focus'

  // A body at the safe limit travels the pipe whole; the issue is filed once, on the checkout's own remote.
  {
    const w = world('feedback-ok'),
      f = await start(w)
    const body = 'x'.repeat(SAFE_LIMIT)
    assert.ok(body.length < BODY_LIMIT)
    const result = await f.workflows().feedback(w.local, title, body)
    assert.deepEqual(result, { ok: true, url: 'https://github.com/fake/repo/issues/1' })
    const [issue] = w.gh().issues
    assert.equal(issue.body.length, SAFE_LIMIT)
    assert.equal(issue.title, title)
    // The largest body the composer can build is also accepted.
    assert.equal(
      (await f.workflows().feedback(w.local, 'Largest', 'y'.repeat(BODY_LIMIT))).ok,
      true
    )
    assert.equal(w.gh().issues[1].body.length, BODY_LIMIT)
    // A request the owner never gets from Bun is refused, not run.
    const refused = await f.workflowFrame('feedback', {
      root: w.local,
      title: '',
      body: 'text',
      intent: 'feedback'
    })
    assert.equal(refused.kind, 'failed')
    assert.equal(w.gh().counts.issueCreate, 2)
    await f.stop()
    log('tools feedback body')
  }

  // Preflight failures name the problem and never reach `issue create`.
  {
    const plain = world('feedback-plain', { remote: false }),
      f = await start(plain)
    assert.match(
      (await f.workflows().feedback(plain.local, title, 'body')).error,
      /No “origin” remote/
    )
    const folder = join(plain.base, 'not-a-repo')
    mkdirSync(folder)
    assert.match(
      (await f.workflows().feedback(folder, title, 'body')).error,
      /isn’t a git checkout/
    )
    assert.equal(plain.gh().counts?.issueCreate, undefined)
    await f.stop()
    const w = world('feedback-auth'),
      g = await start(w)
    setGh(w, (state) => {
      state.unauthed = true
    })
    assert.match((await g.workflows().feedback(w.local, title, 'body')).error, /gh auth login/)
    assert.deepEqual(w.gh().issues, [])
    await g.stop()
    log('tools feedback preflight')
  }

  // gh failing after GitHub filed the issue is a success; a plain failure is reported and files nothing.
  {
    const w = world('feedback-lost'),
      f = await start(w)
    setGh(w, (state) => {
      state.faults = ['issue-create-lost']
    })
    assert.deepEqual(await f.workflows().feedback(w.local, title, 'body'), {
      ok: true,
      url: 'https://github.com/fake/repo/issues/1'
    })
    assert.equal(w.gh().issues.length, 1)
    setGh(w, (state) => {
      state.faults = ['issue-create-fail']
    })
    const failed = await f.workflows().feedback(w.local, 'Another', 'body')
    assert.equal(failed.ok, false)
    assert.match(failed.error, /HTTP 500/)
    assert.doesNotMatch(failed.error, /--body/)
    assert.equal(w.gh().issues.length, 1)
    assert.equal((await f.workflows().feedback(w.local, 'Another', 'body')).ok, true)
    assert.equal(w.gh().issues.length, 2)
    await f.stop()
    log('tools feedback lost reply and failure')
  }

  // A crash after the issue exists, before its receipt: the retry answers that issue.
  {
    const w = world('feedback-crash'),
      f1 = await start(w, { WORKFLOW_FAULT: 'feedback.issue' })
    await crashed(f1, f1.workflows({ timeout: 3000, retries: 0 }).feedback(w.local, title, 'body'))
    assert.equal(w.gh().issues.length, 1)
    const f2 = await start(w)
    assert.deepEqual(await f2.workflows().feedback(w.local, title, 'body'), {
      ok: true,
      url: 'https://github.com/fake/repo/issues/1'
    })
    assert.equal(w.gh().issues.length, 1)
    const record = (await f2.workflows().workflows()).find(
      (item) => item.kind === 'feedback' && item.state === 'done'
    )
    assert.ok(record)
    assert.equal(record.steps.at(-1).receipt.reconciled, true)
    await f2.stop()
    log('tools feedback crash')
  }

  // Skill packs: the user scope lands in the service's HOME, a failing installer is reported, odd input is refused.
  {
    const w = world('skills'),
      home = join(w.base, 'home')
    mkdirSync(home)
    const f = await start(w, { HOME: home })
    const user = await f
      .workflows()
      .installSkills({ packId: 'emil-design-eng', scope: 'user', liveRoot: w.local })
    assert.equal(user.ok, true)
    assert.equal(user.targetDir, join(home, '.claude', 'skills'))
    assert.deepEqual(user.installed, ['all-skill'])
    assert.ok(existsSync(join(home, '.claude/skills/all-skill')))
    assert.ok(!existsSync(join(w.local, '.claude')))
    assert.deepEqual(w.pm().calls.at(-1).split(' '), [
      'npx',
      'skills',
      'add',
      'emilkowalski/skills',
      '-a',
      'claude-code',
      '-y',
      '--copy',
      '-g',
      '--all'
    ])
    writeFileSync(w.pmState, JSON.stringify({ fail: { skills: 1 } }))
    const failed = await f
      .workflows()
      .installSkills({ packId: 'anthropic-frontend-design', scope: 'project', liveRoot: w.local })
    assert.equal(failed.ok, false)
    assert.match(failed.message, /failed \(exit 1\)/)
    assert.match(failed.stderr, /skills failed/)
    const retried = await f
      .workflows()
      .installSkills({ packId: 'anthropic-frontend-design', scope: 'project', liveRoot: w.local })
    assert.equal(retried.ok, true)
    assert.deepEqual(retried.installed, ['frontend-design'])
    const calls = w.pm().calls.length
    for (const body of [
      { packId: 'x', scope: 'project', repo: '--evil/x', skills: [], title: 'X' },
      { packId: 'x', scope: 'project', repo: 'a/b', skills: ['--all; rm'], title: 'X' },
      { packId: 'x', scope: 'system', repo: 'a/b', skills: [], title: 'X' },
      { packId: 'x', scope: 'project', repo: 'https://example.com/a/b', skills: [], title: 'X' }
    ]) {
      assert.equal(
        (await f.workflowFrame('skills', { root: w.local, ...body, intent: 'skills' })).kind,
        'failed'
      )
    }
    assert.equal(w.pm().calls.length, calls)
    assert.equal(
      (
        await f
          .workflows()
          .installSkills({ packId: 'not-a-pack', scope: 'project', liveRoot: w.local })
      ).ok,
      false
    )
    assert.equal(w.pm().calls.length, calls)
    await f.stop()
    assert.deepEqual(readdirSync(join(w.local, '.claude/skills')), ['frontend-design'])
    log('tools skills')
  }
}
