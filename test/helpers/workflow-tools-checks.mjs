// The Swift workflow owner's skill-pack workflow (S15), run by test/workflow-owner.mjs with
// its scratch worlds: user-scope installs in the service's HOME, and the owner refusing what
// the catalog would never send. The feedback issue (`gh issue create`) left the owner in
// LKM-336 (feedback goes privately to the Trezi endpoint): a `feedback` frame is refused.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function toolChecks({ world, start, log }) {
  // No GitHub issue path: the method is unknown and nothing reaches gh.
  {
    const w = world('feedback-gone'),
      f = await start(w)
    const refused = await f.workflowFrame('feedback', {
      root: w.local,
      title: 'The sidebar loses focus',
      body: 'text',
      intent: 'feedback'
    })
    assert.equal(refused.kind, 'failed')
    assert.equal(w.gh().counts?.issueCreate, undefined)
    await f.stop()
    log('tools feedback refused')
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
