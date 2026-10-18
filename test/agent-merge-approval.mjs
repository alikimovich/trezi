// LKM-281: an agent merges a pull request only after the user approved exactly that
// repository, PR and head in Trezi's own card. Fake workflow and scripted `gh`: nothing
// reaches GitHub and nothing is merged for real.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAgentMergeSource } from '../src/main/agent-merge-setting.ts'
import { agentGitTool } from '../src/main/chat-agent-git.ts'
import { states } from '../src/main/chat-state.ts'
import {
  answerMergeApproval,
  KEEP_OPTION,
  MERGE_APPROVAL_TTL_MS,
  MERGE_OPTION,
  mergeTarget,
  revokeMergeApprovals,
  setMergeApprovalClock
} from '../src/main/merge-approval.ts'
import { authorizeTool, decidePermission, HOST_CONFIRMED } from '../src/main/provider-policy.ts'
import { answerAsked } from '../src/main/question-tool.ts'
import { setWorkflowOwner } from '../src/main/workflow-owner.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-merge-approval-')))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const originalPath = process.env.PATH

// The live checkout on trezi/main and the chat's worktree.
const live = join(root, 'live')
mkdirSync(live)
git(live, 'init', '-q', '-b', 'main')
git(live, 'config', 'user.name', 'User')
git(live, 'config', 'user.email', 'user@local')
git(live, 'config', 'commit.gpgsign', 'false')
writeFileSync(join(live, 'a.txt'), 'one\n')
git(live, 'add', 'a.txt')
git(live, 'commit', '-q', '-m', 'initial')
git(live, 'checkout', '-q', '-b', 'trezi/main')
const work = join(root, 'chat')
git(live, 'worktree', 'add', '-q', '-b', 'trezi/chat-a', work, 'HEAD')
const commit = (text) => {
  writeFileSync(join(live, 'a.txt'), text)
  git(live, 'commit', '-q', '-am', text.trim())
  return git(live, 'rev-parse', 'HEAD')
}

// "GitHub": the PR as `gh pr view` reports it, kept in a file the test controls.
const prFile = join(root, 'pr.json')
const mergedFile = join(root, 'merged.json')
const pr = (fields = {}) =>
  writeFileSync(
    prFile,
    JSON.stringify({
      number: 6,
      url: 'https://github.com/Owner/Repo/pull/6',
      mergeable: 'MERGEABLE',
      baseRefName: 'main',
      headRefName: 'trezi/main',
      headRefOid: git(live, 'rev-parse', 'HEAD'),
      statusCheckRollup: [],
      ...fields
    })
  )
const bin = join(root, 'bin')
mkdirSync(bin)
writeFileSync(
  join(bin, 'gh'),
  `#!/bin/sh
if [ "$1 $2" = "pr view" ] && [ "$5" = "state,mergeCommit" ]; then cat '${mergedFile}'
elif [ "$1 $2" = "pr view" ]; then cat '${prFile}'
elif [ "$1 $2" = "run list" ]; then echo '[]'
else exit 1; fi
`
)
chmodSync(join(bin, 'gh'), 0o755)
writeFileSync(mergedFile, '{"state":"OPEN"}')
process.env.PATH = `${bin}:${originalPath}`

// The publish workflow: records each call; a merge happens only at the pinned head.
const calls = []
setWorkflowOwner({
  publish: async (liveRoot, mode, _describe, expectedHead) => {
    calls.push({ mode, expectedHead })
    const github = JSON.parse(readFileSync(prFile, 'utf8'))
    if (mode === 'pr') {
      pr({ ...github, headRefOid: git(liveRoot, 'rev-parse', 'HEAD') })
      return { ok: true, url: github.url }
    }
    if (expectedHead !== github.headRefOid) return { ok: false, error: 'head changed' }
    writeFileSync(mergedFile, '{"state":"MERGED","mergeCommit":{"oid":"abc123"}}')
    return { ok: true, url: github.url }
  }
})
const merges = () => calls.filter((call) => call.mode === 'merge')

const CHAT = 'chat-a'
states.set(CHAT, {
  wt: { id: 'a', repoRoot: live, path: work, branch: 'trezi/chat-a', baseSha: '' },
  liveRoot: live,
  reclaimed: false
})
const events = []
const notify = (channel, payload) => events.push({ channel, ...payload })
const merge = (args = {}, chat = CHAT) =>
  agentGitTool(chat, work, live, 'publish_merge', args, Date.now(), notify)
const lastCard = () => events.filter((event) => event.type === 'question-request').at(-1)
const approve = (card = lastCard()) =>
  answerMergeApproval(card.request.id, {
    [card.request.questions[0].question]: MERGE_OPTION
  })

try {
  pr()
  // A boolean from the model never merges: the first call only shows Trezi's card.
  const asked = await merge({ confirmed: true })
  assert.equal(asked.merged, false)
  assert.equal(asked.approvalRequired, true)
  assert.equal(merges().length, 0, 'confirmed: true alone never merges')
  const head = git(live, 'rev-parse', 'HEAD')
  assert.deepEqual(
    { pr: asked.pr, repo: asked.repo, head: asked.head },
    { pr: 6, repo: 'github.com/owner/repo', head }
  )
  const card = lastCard()
  assert.equal(card.channel, 'agent:event')
  assert.equal(card.projectKey, CHAT)
  assert.match(card.request.id, /^merge-approval:[0-9a-f-]{36}$/)
  assert.equal(
    card.request.questions[0].question,
    `Merge pull request #6 in github.com/owner/repo at commit ${head.slice(0, 12)}?`
  )
  assert.deepEqual(
    card.request.questions[0].options.map((option) => option.label),
    [MERGE_OPTION, KEEP_OPTION]
  )
  // Calling again (still confirmed: true) before the user answers asks again, never merges.
  assert.equal((await merge({ confirmed: true })).approvalRequired, true)
  assert.equal(merges().length, 0)
  assert.deepEqual(
    events.filter((event) => event.type === 'question-resolved').map((event) => event.id),
    [card.request.id],
    'the earlier card is replaced'
  )

  // Cancel: a dismissed card approves nothing.
  assert.deepEqual(answerMergeApproval(lastCard().request.id, null), {})
  assert.equal((await merge({ confirmed: true })).approvalRequired, true)
  assert.equal(merges().length, 0, 'cancel refused')

  // Denial: Don't merge approves nothing and says so as the user's message.
  const denial = answerMergeApproval(lastCard().request.id, {
    [lastCard().request.questions[0].question]: KEEP_OPTION
  })
  assert.match(denial.message, /Do not merge pull request #6/)
  assert.equal((await merge()).approvalRequired, true)
  assert.equal(merges().length, 0, 'denial refused')

  // A free-text answer that is not the card's own Merge option declines too.
  const other = lastCard()
  answerMergeApproval(other.request.id, { [other.request.questions[0].question]: 'merge it' })
  assert.equal((await merge()).approvalRequired, true)
  assert.equal(merges().length, 0)

  // An ask_user card the model wrote, answered Merge, is not a merge approval.
  assert.equal(answerMergeApproval('ask-user:x:1', { q: MERGE_OPTION }), undefined)
  assert.equal(answerAsked(lastCard().request.id, null), undefined)

  /** The user approves the card the agent's call just showed (for GitHub's current PR). */
  const askAndApprove = async () => {
    assert.equal((await merge()).approvalRequired, true)
    return approve()
  }

  // Bound to the repository: approval for owner/repo does not merge other/repo.
  assert.match((await askAndApprove()).message, /I approved merging pull request #6/)
  pr({ url: 'https://github.com/other/repo/pull/6' })
  const otherRepo = await merge()
  assert.equal(otherRepo.approvalRequired, true)
  assert.match(otherRepo.reason, /changed after the user approved/)
  assert.equal(merges().length, 0, 'another repository refused')
  pr()

  // Bound to the PR number.
  await askAndApprove()
  pr({ number: 7, url: 'https://github.com/Owner/Repo/pull/7' })
  const otherPr = await merge({ number: 7 })
  assert.equal(otherPr.approvalRequired, true)
  assert.match(otherPr.reason, /changed/)
  assert.equal(merges().length, 0, 'another PR refused')
  pr()

  // Bound to the head: a commit after approval is pushed (as publish_update would) and
  // asked about again; the approved head is never used for the new one.
  await askAndApprove()
  const before = calls.length
  const newHead = commit('two\n')
  const moved = await merge()
  assert.equal(moved.approvalRequired, true)
  assert.equal(moved.head, newHead)
  assert.match(moved.reason, /changed/)
  assert.deepEqual(calls.slice(before), [{ mode: 'pr', expectedHead: undefined }])
  assert.equal(merges().length, 0, 'head change after approval refused')
  // Uncommitted changes after approval would be committed into an unapproved head.
  await askAndApprove()
  writeFileSync(join(live, 'b.txt'), 'new\n')
  const dirty = await merge()
  assert.match(dirty.error, /is not this checkout's/)
  assert.equal(merges().length, 0, 'dirty checkout after approval refused')
  rmSync(join(live, 'b.txt'))
  revokeMergeApprovals(CHAT)

  // Merge-off: refused whatever the model sends, even with a granted approval, no card.
  await askAndApprove()
  setAgentMergeSource(() => 'false')
  const cards = events.length
  for (const args of [{}, { confirmed: true }]) {
    const off = await merge(args)
    assert.match(off.error, /Agent PR merging is off/)
    assert.equal(off.approvalRequired, undefined)
  }
  assert.equal(events.length, cards, 'merge-off shows no card')
  assert.equal(merges().length, 0, 'merge-off refused')
  setAgentMergeSource(() => null)
  // Merge-off dropped the approval: turning it back on asks again.
  const again = await merge()
  assert.equal(again.approvalRequired, true)
  assert.equal(again.reason, undefined)
  assert.equal(merges().length, 0)

  // Expiry: an approval older than the limit is dropped.
  const t0 = Date.now()
  setMergeApprovalClock(() => t0)
  await merge()
  approve()
  setMergeApprovalClock(() => t0 + MERGE_APPROVAL_TTL_MS + 1)
  const expired = await merge()
  assert.match(expired.reason, /expired/)
  assert.equal(merges().length, 0)
  setMergeApprovalClock(null)

  // Another chat cannot use this chat's approval.
  await askAndApprove()
  const OTHER = 'chat-b'
  states.set(OTHER, { ...states.get(CHAT) })
  assert.equal((await merge({}, OTHER)).approvalRequired, true)
  assert.equal(merges().length, 0, "another chat's approval refused")
  states.delete(OTHER)
  revokeMergeApprovals(OTHER)
  // Closing the chat revokes it.
  revokeMergeApprovals(CHAT)
  const closed = await merge()
  assert.equal(closed.approvalRequired, true)
  assert.equal(closed.reason, undefined)
  assert.equal(merges().length, 0)

  // The legitimate path: approved, unchanged → merged at exactly the approved head.
  const approved = lastCard()
  approve(approved)
  assert.deepEqual(approve(approved), {}, 'a second answer changes nothing')
  const done = await merge()
  assert.equal(done.merged, true)
  assert.equal(done.mergeCommit, 'abc123')
  assert.deepEqual(merges(), [{ mode: 'merge', expectedHead: newHead }])

  // Replay: the approval was spent; the next call asks again and does not merge.
  writeFileSync(mergedFile, '{"state":"OPEN"}')
  const replay = await merge({ confirmed: true })
  assert.equal(replay.approvalRequired, true)
  assert.equal(merges().length, 1, 'replay refused')

  // The PR-branch check still comes first.
  pr({ headRefName: 'someone/else' })
  assert.match((await merge()).error, /This PR belongs to someone\/else/)
  // And the active-worktree check.
  assert.match(
    (await agentGitTool(CHAT, join(root, 'elsewhere'), live, 'publish_merge', {}, 0, notify)).error,
    /no active Git worktree/
  )

  // Targets: only a PR URL whose number matches and a full commit id.
  assert.deepEqual(mergeTarget('https://github.com/A/B/pull/3', 3, 'a'.repeat(40)), {
    repo: 'github.com/a/b',
    number: 3,
    head: 'a'.repeat(40)
  })
  assert.equal(mergeTarget('https://github.com/A/B/pull/3', 4, 'a'.repeat(40)), null)
  assert.equal(mergeTarget('https://github.com/A/B/pull/3', 3, 'abc'), null)
  assert.equal(mergeTarget('https://github.com/A/B/issues/3', 3, 'a'.repeat(40)), null)

  // Policy: publish_merge is not auto-allowed; only a live foreground chat may call it.
  const scope = { live: true, background: false, root: work, liveRoot: live, profile: '' }
  assert.ok('publish_merge' in HOST_CONFIRMED)
  assert.deepEqual(decidePermission('mcp__trezi__publish_merge', undefined, scope), {
    decision: 'allow'
  })
  assert.deepEqual(
    decidePermission('mcp__trezi__publish_merge', undefined, { ...scope, background: true }),
    { decision: 'deny', message: 'Background agents cannot merge pull requests.' }
  )
  assert.equal(
    decidePermission('mcp__trezi__publish_merge', undefined, { ...scope, live: false }).decision,
    'deny'
  )
  assert.equal(
    authorizeTool('publish_merge', 2, { live: true, background: true })?.code,
    'unauthorized'
  )
  assert.equal(authorizeTool('publish_merge', 2, { live: true, background: false }), null)
  console.log('AGENT-MERGE-APPROVAL PASS')
} finally {
  states.delete(CHAT)
  setWorkflowOwner(null)
  setAgentMergeSource(() => null)
  setMergeApprovalClock(null)
  process.env.PATH = originalPath
  rmSync(root, { recursive: true, force: true })
}
