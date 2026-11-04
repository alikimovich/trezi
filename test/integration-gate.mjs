// LOCAL-WEBKIT-3: the integration gate answers a candidate only when the host's own checks
// passed on the exact source a chat's worktree holds now. Real `run_checks` commands
// (package.json scripts run by `bun run`) on a real Git worktree: pass, fail, cancel,
// time out, a check that edits the source, a script the chat changed, a running check;
// an edit makes the old receipts stale, a commit of the same bytes does not; a web
// project needs a browser receipt whose private server is still the one it checked;
// replay, retained evidence for a closing session, and the honest non-repo capability.
// The owner's own hold (unchecked, source-changed, live-changed) is covered by the Git
// suites (test/worktrees.mjs, test/chat-worktrees.mjs) on the Swift repository owner.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installAgentRuntimes } from '../src/main/agent-runtime.ts'
import {
  availableChecks,
  cancelChecks,
  resolveCheck,
  runChecksTool,
  runCommandCheck
} from '../src/main/command-checks.ts'
import {
  arrangeChecks,
  dropGateEvidence,
  holdMessage,
  integrationGate,
  landingChecks,
  lastReplayFailures,
  replayChecks,
  retainGateEvidence,
  setCheckReplayer
} from '../src/main/integration-gate.ts'
import {
  beginReceiptCheck,
  newReceiptId,
  receiptSession,
  recordReceipt,
  waitForChecks
} from '../src/main/verification-receipts.ts'
import { projectKey } from '../src/shared/projectKey.ts'
import { candidateOf, passCheck } from './helpers/gate-checks.mjs'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-integration-gate-')))
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// The project kind the runtime owner detects: a web preview needs a browser check.
let kind = 'none'
await installAgentRuntimes({
  detect: async () => ({ setupRequired: false, previewKind: kind, framework: 'vite' }),
  onAgentExit: () => {},
  onAgentLog: () => {},
  stopAgents: async () => 0
})

const SCRIPTS = {
  pass: 'true',
  fail: 'exit 3',
  slow: 'sleep 20',
  mutate: 'echo touched >> src/app.txt',
  prepass: 'true'
}
const live = join(scratch, 'live')
execFileSync('mkdir', ['-p', join(live, 'src')])
git(live, 'init', '-q', '-b', 'main')
git(live, 'config', 'user.name', 'Test')
git(live, 'config', 'user.email', 'test@example.com')
writeFileSync(join(live, '.gitignore'), 'node_modules\n.env\n')
writeFileSync(join(live, 'package.json'), `${JSON.stringify({ scripts: SCRIPTS }, null, 2)}\n`)
writeFileSync(join(live, 'src/app.txt'), 'one\n')
git(live, 'add', '.')
git(live, 'commit', '-qm', 'initial')
const root = join(scratch, 'wt')
git(live, 'worktree', 'add', '-q', '-b', 'trezi/chat-gate', root)

const emitKey = 'gate-chat'
const scope = { emitKey, root, liveRoot: live }
const session = receiptSession(emitKey, projectKey(root))
const gate = () => integrationGate(scope)
const write = (text) => writeFileSync(join(root, 'src/app.txt'), text)

try {
  // Nothing checked: no candidate, and the tree it would need is the worktree's now.
  let verdict = await gate()
  assert.equal(verdict.ok, false)
  assert.equal(verdict.candidate, null)
  assert.equal(verdict.reason, 'unchecked')
  assert.equal(verdict.need, 'command', 'a project without a web preview needs run_checks')
  assert.equal(verdict.tree, await candidateOf(root))
  assert.match(verdict.message, /no check passed on this exact source yet/)

  // The checks are the live checkout's scripts; pre/post hooks are not checks of their own.
  assert.deepEqual(availableChecks(live), ['pass', 'fail', 'slow', 'mutate'])
  assert.deepEqual(await runChecksTool({ list: true }, scope), {
    checks: ['pass', 'fail', 'slow', 'mutate']
  })
  assert.match(resolveCheck('missing', scope).error, /defines no such script/)
  assert.match((await runChecksTool({ checks: [] }, scope)).error, /one to 4/)
  assert.match(
    (await runChecksTool({ checks: ['pass', 'pass', 'pass', 'pass', 'pass'] }, scope)).error,
    /At most 4/
  )

  // A passing check on this source is the candidate.
  write('two\n')
  const tree = await candidateOf(root)
  const passed = await runCommandCheck('pass', scope)
  assert.equal(passed.verified, true, JSON.stringify(passed))
  assert.equal(passed.exitCode, 0)
  assert.equal(passed.source.tree, tree)
  assert.deepEqual(passed.command, ['bun', 'run', 'pass'])
  verdict = await gate()
  assert.equal(verdict.ok, true)
  assert.equal(verdict.candidate, tree)
  assert.deepEqual(
    verdict.evidence.map((e) => [e.check, e.verified]),
    [['command pass', true]]
  )

  // A failing check on the same source blocks, whatever else passed.
  const failed = await runCommandCheck('fail', scope)
  assert.equal(failed.verified, false)
  assert.equal(failed.exitCode, 3)
  verdict = await gate()
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'check-failed')
  assert.match(verdict.message, /"command fail" did not pass on this exact source/)

  // Committing the same bytes keeps the candidate: the tree is commit-invariant.
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'agent commit')
  assert.equal(await candidateOf(root), tree)
  assert.equal((await gate()).reason, 'check-failed', 'the failure still holds')

  // Any edit is a new source with no checks: the old pass and the old failure are stale.
  write('three\n')
  verdict = await gate()
  assert.equal(verdict.reason, 'unchecked')
  assert.notEqual(verdict.tree, tree)
  assert.deepEqual(verdict.evidence, [])
  assert.equal((await runCommandCheck('pass', scope)).verified, true)
  assert.equal((await gate()).ok, true)

  // A check that edits the source never passes, and its edit is a new, unchecked source.
  const mutated = await runCommandCheck('mutate', scope)
  assert.equal(mutated.verified, false)
  assert.equal(mutated.reason, 'source-changed')
  assert.equal(mutated.source.tree, null)
  assert.equal((await gate()).reason, 'unchecked')
  write('three\n')
  assert.equal((await gate()).ok, true, 'back on the checked bytes, the pass counts again')

  // A script the chat changed is not run: a check it wrote itself would prove nothing.
  const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { ...own.scripts, pass: 'echo trust me' } })
  )
  assert.match((await runCommandCheck('pass', scope)).error, /changed the "pass" script/)
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { ...own.scripts, prepass: 'echo skip' } })
  )
  assert.match((await runCommandCheck('pass', scope)).error, /changed the "prepass" script/)
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(own, null, 2)}\n`)

  const preflight = runCommandCheck('slow', scope)
  cancelChecks(session)
  assert.match((await preflight).error, /cancelled before it ran/)

  // A running check blocks; cancelled, its receipt is not a pass.
  const slow = runCommandCheck('slow', scope)
  const deadline = Date.now() + 5000
  while ((await gate()).reason !== 'check-running' && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal((await gate()).reason, 'check-running')
  const settledCheck = waitForChecks(session, 1000)
  cancelChecks(session)
  const cancelled = await slow
  assert.equal(await settledCheck, true, 'the waiter sees the final receipt before settling')
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.reason, 'cancelled')
  assert.equal((await gate()).reason, 'check-failed')
  const timedOut = await runCommandCheck('slow', scope, 300)
  assert.equal(timedOut.timedOut, true)
  assert.equal(timedOut.reason, 'timed-out')
  assert.equal((await runCommandCheck('slow', scope, 300)).verified, false)
  write('four\n')
  assert.equal((await runCommandCheck('pass', scope)).verified, true)

  // A web project needs a browser check; a command alone is not enough.
  kind = 'web'
  verdict = await gate()
  assert.equal(verdict.need, 'browser')
  assert.equal(verdict.reason, 'unchecked')
  assert.match(verdict.message, /preview_verify in its private browser/)
  const browser = (agent, generation, verified = true) => ({
    id: newReceiptId(),
    createdAt: new Date().toISOString(),
    engine: 'webkit',
    engineDetail: 'fixture',
    input: 'synthetic-dom',
    coverage: { engine: 'webkit', os: 'macOS', emulated: {}, notCovered: [] },
    runtime: { kind: 'private', agent, root, url: 'http://127.0.0.1:1/', generation },
    source: { snapshot: null, tree: null, head: null, dirty: 0 },
    document: { url: 'http://127.0.0.1:1/', navigation: 1, startedAt: null },
    viewport: { width: 800, height: 600, theme: 'light' },
    steps: [],
    checks: [],
    artifacts: [],
    checksPassed: verified,
    verified,
    reason: verified ? null : 'check failed',
    ms: 1,
    recipe: { path: '/' }
  })
  const missingBrowser = []
  setCheckReplayer(async (recipe) => {
    missingBrowser.push(recipe)
    if (recipe.kind === 'browser') {
      const receipt = browser(null, null)
      receipt.source.tree = await candidateOf(root)
      recordReceipt(session, receipt)
    }
    return true
  })
  await replayChecks(scope)
  assert.ok(
    missingBrowser.some((recipe) => recipe.kind === 'browser'),
    'arranges a missing browser check'
  )
  assert.deepEqual(
    missingBrowser.find((recipe) => recipe.kind === 'browser').args.checks,
    [{ kind: 'visible', selector: 'body' }, { kind: 'noConsoleErrors' }],
    'the automatic browser run makes real assertions'
  )
  assert.equal((await gate()).ok, true, 'automatic browser evidence passes on the exact tree')
  const browserSettled = beginReceiptCheck(session)
  assert.equal((await gate()).reason, 'check-running', 'browser receipt is still in flight')
  const browserWait = waitForChecks(session, 1000)
  const inFlightReceipt = browser(null, null)
  inFlightReceipt.source.tree = await candidateOf(root)
  recordReceipt(session, inFlightReceipt)
  assert.equal((await gate()).reason, 'check-running', 'recording alone does not end the check')
  browserSettled()
  assert.equal(await browserWait, true)
  assert.equal((await gate()).ok, true, 'settled browser receipt proves the current tree')
  setCheckReplayer(null)
  const now = await candidateOf(root)
  // Its private server has since stopped (or restarted): a server change.
  const stale = browser('agent-gate', 1)
  stale.source.tree = now
  recordReceipt(session, stale)
  verdict = await gate()
  assert.equal(verdict.reason, 'runtime-changed')
  assert.match(verdict.message, /restarted or stopped/)

  // Replay reruns the checks that passed, and those whose server changed, on the new source.
  const replayed = []
  setCheckReplayer(async (recipe) => {
    replayed.push(recipe.kind === 'command' ? recipe.check : recipe.args.path)
    return true
  })
  assert.equal(await replayChecks(scope), 2)
  assert.deepEqual(replayed.toSorted(), ['/', 'pass'])
  let stoppedReplay = false
  const bounded = []
  setCheckReplayer(async (recipe) => {
    bounded.push(recipe.kind)
    stoppedReplay = true
    return true
  })
  assert.equal(await replayChecks(scope, () => stoppedReplay), 1)
  assert.equal(bounded.length, 1, 'Stop prevents the next replay check')
  setCheckReplayer(null)
  assert.equal(await replayChecks(scope), 0, 'no tools, no replay')

  const fresh = browser(null, null)
  fresh.source.tree = now
  recordReceipt(session, fresh)
  verdict = await gate()
  assert.equal(verdict.ok, true, JSON.stringify(verdict))
  assert.equal(verdict.candidate, now)
  // A checked page deliberately removed by this chat is superseded. The old
  // route is never replayed, and a new browser pass on this exact tree is required.
  mkdirSync(join(root, 'src/pages'), { recursive: true })
  writeFileSync(join(root, 'src/pages/retired.tsx'), 'export default function Page() {}\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'checked route')
  const oldRoute = browser(null, null)
  oldRoute.recipe.path = '/retired'
  oldRoute.source.tree = await candidateOf(root)
  recordReceipt(session, oldRoute)
  unlinkSync(join(root, 'src/pages/retired.tsx'))
  write('retired tree\n')
  assert.equal((await gate()).reason, 'unchecked')
  const retiredReplay = []
  setCheckReplayer(async (recipe) => {
    retiredReplay.push(recipe.kind === 'browser' ? recipe.args.path : recipe.check)
    if (recipe.kind === 'browser') {
      const replacement = browser(null, null)
      replacement.source.tree = await candidateOf(root)
      recordReceipt(session, replacement)
    }
    if (recipe.kind === 'command') await runCommandCheck(recipe.check, scope)
    return true
  })
  await replayChecks(scope)
  assert.ok(retiredReplay.includes('/'), 'replacement browser check ran')
  assert.ok(!retiredReplay.includes('/retired'), 'deleted route recipe was superseded')
  assert.equal((await gate()).ok, true, 'replacement evidence proves the new tree')
  setCheckReplayer(async (recipe) => recipe.kind !== 'browser')
  await replayChecks(scope)
  assert.match(lastReplayFailures(scope).join('\n'), /webkit \/: the check did not pass/)
  setCheckReplayer(null)

  // A Retry on a web project whose session only ran `run_checks`: the host arranges
  // one fresh browser check on the exact tree, then the gate passes.
  const only = { emitKey: 'gate-only-commands', root, liveRoot: live }
  write('only commands\n')
  assert.equal((await runCommandCheck('pass', only)).verified, true)
  assert.equal((await integrationGate(only)).reason, 'unchecked', 'a command alone is not enough')
  const arranged = []
  setCheckReplayer(async (recipe, replayScope) => {
    arranged.push(recipe.kind)
    if (recipe.kind === 'browser') {
      const receipt = browser(null, null)
      receipt.source.tree = await candidateOf(root)
      recordReceipt(receiptSession(replayScope.emitKey, projectKey(root)), receipt)
    } else await runCommandCheck(recipe.check, replayScope)
    return true
  })
  let arrangement = await arrangeChecks(only)
  assert.deepEqual(arranged.toSorted(), ['browser', 'command'])
  assert.deepEqual(arrangement.failures, [])
  const arrangedVerdict = await integrationGate(only)
  assert.equal(arrangedVerdict.ok, true, JSON.stringify(arrangedVerdict))
  assert.equal(arrangedVerdict.candidate, await candidateOf(root), 'evidence is on the exact tree')
  // An already satisfied gate arranges nothing.
  arranged.length = 0
  assert.equal((await arrangeChecks(only)).ran, 0)
  assert.deepEqual(arranged, [])

  // The browser check fails: the reason is recorded and returned, never swallowed.
  write('browser fails\n')
  assert.equal((await runCommandCheck('pass', only)).verified, true)
  setCheckReplayer(async (recipe) => {
    if (recipe.kind === 'browser') throw new Error('preview_verify failed: the page never rendered')
    return true
  })
  arrangement = await arrangeChecks(only)
  assert.match(arrangement.failures.join('\n'), /preview_verify failed: the page never rendered/)
  assert.equal(
    (await integrationGate(only)).reason,
    'unchecked',
    'a failed arrangement passes nothing'
  )

  // No check runner: Trezi says it cannot arrange the browser check instead of passing it.
  setCheckReplayer(null)
  arrangement = await arrangeChecks(only)
  assert.equal(arrangement.ran, 0)
  assert.match(arrangement.failures.join('\n'), /cannot arrange a browser check/)

  // No private preview (not a web project, or no runtime owner): no browser check is arranged.
  for (const noPreview of ['none', 'static']) {
    kind = noPreview
    const silent = []
    setCheckReplayer(async (recipe) => {
      silent.push(recipe.kind)
      return true
    })
    write(`no preview ${noPreview}\n`)
    const plain = { emitKey: `gate-no-preview-${noPreview}`, root, liveRoot: live }
    await passCheck(plain.emitKey, root, 'pass')
    write(`no preview again ${noPreview}\n`)
    await arrangeChecks(plain)
    assert.ok(!silent.includes('browser'), `no automatic browser check for a ${noPreview} project`)
  }
  setCheckReplayer(null)
  kind = 'none'
  write('retired tree\n') // back to the tree the main chat's receipts prove

  // A closing session keeps what its receipts proved for its final landing.
  retainGateEvidence(emitKey, root)
  await passCheck(emitKey, root, 'late', false)
  assert.equal((await gate()).ok, true, 'the retained evidence is what the session proved')
  dropGateEvidence(emitKey, root)
  assert.equal((await gate()).reason, 'check-failed')

  // The workspace_state view: a worktree is gated; a project that runs on its live
  // checkout says isolation is unavailable instead of claiming a private check.
  const gated = await landingChecks(scope)
  assert.equal(gated.gated, true)
  assert.equal(gated.ready, false)
  assert.equal(gated.sourceTree, await candidateOf(root))
  const unisolated = await landingChecks({ emitKey, root: live, liveRoot: live })
  assert.equal(unisolated.gated, false)
  assert.equal(unisolated.isolation, 'unavailable')
  assert.match(unisolated.note, /not a Git repository root/)

  // The owner's holds read the same way to the user.
  assert.match(
    holdMessage({ reason: 'live-changed', files: ['src/app.txt'] }, null),
    /changed since this chat started its work \(src\/app\.txt\)/
  )
  assert.match(holdMessage({ reason: 'source-changed', files: [] }, null), /after its checks ran/)
  assert.match(holdMessage(undefined, null), /no check passed on the exact source/)

  // A receipt from another session never counts here.
  write('five\n')
  await passCheck('other-chat', root)
  assert.equal((await gate()).reason, 'unchecked')

  console.log(
    'INTEGRATION GATE OK — exact-source candidate, failed/cancelled/timed-out/running/stale checks block, commit-invariant, web needs a live-server browser check, replay, retention, non-repo capability'
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
