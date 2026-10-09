/**
 * Unit test for the "Connect to GitHub" pure helpers (the first-publish bridge):
 * repo-name sanitization and the Option-B branch push plan. Pure bun — no gh,
 * no network, no Electron. Run via: bun run test:github-connect
 */
import assert from 'node:assert'
import { planGitHubConnection, resolveConnectPlan, sanitizeRepoName } from '../src/shared/github.ts'

// --- sanitizeRepoName -------------------------------------------------------

assert.strictEqual(sanitizeRepoName('My Cool App'), 'my-cool-app')
assert.strictEqual(sanitizeRepoName('  spaced  '), 'spaced')
assert.strictEqual(sanitizeRepoName('weird__name!!'), 'weird__name') // _ kept; trailing !!→- trimmed
assert.strictEqual(sanitizeRepoName('---leading-and-trailing---'), 'leading-and-trailing')
assert.strictEqual(sanitizeRepoName('under_score.dot-dash'), 'under_score.dot-dash')
assert.strictEqual(sanitizeRepoName('café résumé'), 'caf-r-sum') // non-ascii → separators, trimmed
assert.strictEqual(sanitizeRepoName(''), 'my-app')
assert.strictEqual(sanitizeRepoName('!!!'), 'my-app')
assert.strictEqual(sanitizeRepoName('.hidden.'), 'hidden')
assert.strictEqual(sanitizeRepoName('a'.repeat(120)).length, 100) // capped

// --- resolveConnectPlan -----------------------------------------------------

// Scaffold case: on trezi/main, base 'main' is an ancestor → fast-forward main
// to the work branch and make it the default; push both (Option B: the repo's
// default branch shows the built work).
assert.deepStrictEqual(resolveConnectPlan('trezi/main', true), {
  defaultBranch: 'main',
  fastForwardBase: true,
  pushBranches: ['main', 'trezi/main']
})

// Diverged base (existing repo opened with no remote): can't fast-forward, so
// the work branch itself becomes the default.
assert.deepStrictEqual(resolveConnectPlan('trezi/feature', false), {
  defaultBranch: 'trezi/feature',
  fastForwardBase: false,
  pushBranches: ['trezi/feature']
})

// A trezi branch whose suffix maps to a differently-named base.
assert.deepStrictEqual(resolveConnectPlan('trezi/dev', true), {
  defaultBranch: 'dev',
  fastForwardBase: true,
  pushBranches: ['dev', 'trezi/dev']
})

// Non-work branch (user already on a plain branch) just publishes itself — no
// base to fast-forward, regardless of the ancestor flag.
assert.deepStrictEqual(resolveConnectPlan('main', true), {
  defaultBranch: 'main',
  fastForwardBase: false,
  pushBranches: ['main']
})
assert.deepStrictEqual(resolveConnectPlan('trunk', false), {
  defaultBranch: 'trunk',
  fastForwardBase: false,
  pushBranches: ['trunk']
})

// Degenerate 'trezi/' (empty suffix) falls back to 'main' as the base.
assert.deepStrictEqual(resolveConnectPlan('trezi/', true), {
  defaultBranch: 'main',
  fastForwardBase: true,
  pushBranches: ['main', 'trezi/']
})

console.log('GITHUB-CONNECT OK — repo-name sanitize, Option-B branch push plan')

// Exercise the ancestry probe used by the connection path, including legacy
// branches. Publishing itself remains outside this local-only regression.
for (const prefix of ['praxis', 'trezi']) {
  for (const ancestor of [true, false]) {
    const calls = []
    const plan = await planGitHubConnection(`${prefix}/main`, async (base, branch) => {
      calls.push([base, branch])
      return ancestor
    })
    assert.deepStrictEqual(calls, [['main', `${prefix}/main`]])
    assert.deepStrictEqual(plan, resolveConnectPlan(`${prefix}/main`, ancestor))
    assert.equal(plan.defaultBranch, ancestor ? 'main' : `${prefix}/main`)
  }
}
assert.deepStrictEqual(
  await planGitHubConnection('main', async () => {
    assert.fail('Plain branches must not probe ancestry')
  }),
  resolveConnectPlan('main', false)
)
