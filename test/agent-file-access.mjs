// LKM-163, no desktop and no provider call: Settings → "Agent file access".
// - the setting: Full access by default, unknown values read as Full access, and main
//   passes it to every provider helper session it opens;
// - the real Codex adapter, driven in-process with a stand-in `codex` CLI that records
//   its arguments: Full access runs `--sandbox danger-full-access`, Project only runs
//   `workspace-write` with no user writable roots; both with the chat worktree's REAL
//   path as `--cd` when the worktree sits under the profile's symlink aliases;
// - Full access: a file the turn wrote in the live checkout is named in one chat note;
//   a turn that left it alone, and Project only, add no note.
// The adapter half prints SKIP where the machine cannot open Trezi's tool socket.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_FILE_ACCESS_KEY,
  agentFileAccess,
  currentAgentFileAccess,
  realPath,
  setAgentFileAccessSource
} from '../src/main/agent-file-access.ts'

// --- the setting.
assert.equal(AGENT_FILE_ACCESS_KEY, 'trezi:agent-file-access:v1')
assert.equal(agentFileAccess(null), 'full', 'unset is Full access')
assert.equal(agentFileAccess(undefined), 'full')
assert.equal(agentFileAccess('bogus'), 'full', 'an unknown value is Full access')
assert.equal(agentFileAccess('project'), 'project')
const prefs = new Map()
setAgentFileAccessSource(() => prefs.get(AGENT_FILE_ACCESS_KEY) ?? null)
assert.equal(currentAgentFileAccess(), 'full')
prefs.set(AGENT_FILE_ACCESS_KEY, 'project')
assert.equal(
  currentAgentFileAccess(),
  'project',
  'read when asked, so a change applies to the next session'
)

// --- the profile's symlinked worktree root, as `ProfilePaths.swift` makes it on an
// upgraded Mac: `Trezi Native` → `Praxis Native` (relative), `trezi` → the real store.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-file-access-')))
const support = join(scratch, 'Application Support')
const store = join(support, 'Praxis Native', 'praxis')
mkdirSync(join(store, 'worktrees'), { recursive: true })
symlinkSync('Praxis Native', join(support, 'Trezi Native'))
symlinkSync(store, join(support, 'Praxis Native', 'trezi'))
const LIVE = join(scratch, 'swiftly-demos')
const WT = join(support, 'Trezi Native', 'trezi', 'worktrees', 'chat-1')
const REAL_WT = join(store, 'worktrees', 'chat-1')
const git = (...args) => execFileSync('git', args, { stdio: 'pipe' })
mkdirSync(LIVE)
writeFileSync(join(LIVE, 'a.txt'), 'live\n')
git('init', '-q', LIVE)
git('-C', LIVE, 'add', '-A')
git('-C', LIVE, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
git('-C', LIVE, 'worktree', 'add', '-q', WT)
assert.notEqual(WT, REAL_WT)
assert.equal(realPath(WT), REAL_WT, 'realPath resolves both aliases')
assert.equal(
  realPath(join(WT, 'not', 'there.ts')),
  join(REAL_WT, 'not', 'there.ts'),
  'a missing tail keeps its resolved parent'
)

// --- the live-tree snapshot sees reverted work and commits, not only new dirty files.
const { liveHeadMoved, liveTreeChanges, liveTreeSnapshot } = await import(
  '../src/main/backends/live-tree-watch.ts'
)
const { beginLiveWatch, finishLiveWatch } = await import('../src/main/live-change-watch.ts')
{
  const repo = join(scratch, 'watched')
  const commit = (message, ...extra) =>
    git('-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message, ...extra)
  const watchedWt = join(scratch, 'watched-wt')
  mkdirSync(watchedWt)
  const session = {
    root: watchedWt,
    options: { provider: 'codex', agentFileAccess: 'full' },
    record: { projectRoot: repo }
  }
  // One turn's report of what changed in `repo` while `during` ran.
  const report = async (during) => {
    await beginLiveWatch('watched', session)
    await during()
    return finishLiveWatch('watched')
  }
  mkdirSync(repo)
  writeFileSync(join(repo, 'f.txt'), 'f\n')
  writeFileSync(join(repo, 'g.txt'), 'g\n')
  git('init', '-q', repo)
  git('-C', repo, 'add', '-A')
  commit('init')

  // (a) Uncommitted before the turn, clean after it: reverted, restored, stashed or reset.
  for (const discard of [
    ['checkout', '--', 'f.txt'],
    ['restore', 'f.txt'],
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'stash'],
    ['reset', '--hard']
  ]) {
    const label = discard.at(-1) === 'stash' ? 'stash' : discard[0]
    writeFileSync(join(repo, 'f.txt'), 'the user, uncommitted\n')
    const before = await liveTreeSnapshot(repo)
    assert.deepEqual([...before.files.keys()], ['f.txt'])
    git('-C', repo, ...discard)
    const after = await liveTreeSnapshot(repo)
    assert.equal(after.files.size, 0, `${label} leaves the tree clean`)
    assert.deepEqual(liveTreeChanges(before, after), ['f.txt'], `${label} is reported`)
    writeFileSync(join(repo, 'f.txt'), 'the user, uncommitted\n')
    const turn = await report(() => git('-C', repo, ...discard))
    assert.deepEqual(turn?.files, ['f.txt'], `${label} is in the turn's report`)
    assert.deepEqual(turn?.commits, [])
    git('-C', repo, 'stash', 'clear')
  }

  // (b) A commit made in the live checkout moves HEAD.
  writeFileSync(join(repo, 'g.txt'), 'committed\n')
  const dirty = await liveTreeSnapshot(repo)
  git('-C', repo, 'add', 'g.txt')
  commit('direct')
  const committed = await liveTreeSnapshot(repo)
  assert.ok(liveHeadMoved(dirty, committed), 'HEAD moved')
  writeFileSync(join(repo, 'g.txt'), 'committed again\n')
  const direct = await report(() => {
    git('-C', repo, 'add', 'g.txt')
    commit('direct again')
  })
  assert.deepEqual(direct?.files, ['g.txt'])
  assert.deepEqual(
    direct?.commits.map((c) => c.subject),
    ['direct again']
  )
  // An empty commit has no file to name.
  const empty = await report(() => commit('empty', '--allow-empty'))
  assert.deepEqual(empty?.files, [])
  assert.equal(empty?.commits.length, 1)
  // Nothing happened: nothing to report.
  assert.equal(await report(() => {}), null)
}

// --- main passes the setting to every helper session it opens.
const { setProviderOwner } = await import('../src/main/provider-owner.ts')
const { helperProvider } = await import('../src/main/backends/helper-session.ts')
const opened = []
const ok = async () => {}
setProviderOwner({
  kind: 'swift',
  openHelper: async (_session, payload) => {
    opened.push(payload)
    return {}
  },
  open: async () => ({ tools: ['workspace_state'] }),
  authorize: ok,
  turn: ok,
  terminal: ok,
  resume: ok,
  close: ok,
  settled: ok,
  cancel: async () => ({ escalate: false })
})
for (const [provider, stored, expected] of [
  ['codex', null, 'full'],
  ['codex', 'project', 'project'],
  ['claude', 'project', 'project'],
  ['claude', 'full', 'full']
]) {
  if (stored === null) prefs.delete(AGENT_FILE_ACCESS_KEY)
  else prefs.set(AGENT_FILE_ACCESS_KEY, stored)
  const s = await helperProvider(provider).startSession(WT, { provider }, () => null, {
    emitKey: 'chat-helper',
    liveRoot: LIVE
  })
  assert.equal(opened.at(-1)?.options?.agentFileAccess, expected, `${provider}: ${stored}`)
  s.shutdown?.()
}

// --- the real Codex adapter with a stand-in CLI that records how it was started.
const HOME = join(scratch, 'codex-home'),
  LOG = join(scratch, 'exec.log'),
  PLAN = join(scratch, 'plan.json')
mkdirSync(HOME)
writeFileSync(
  join(HOME, 'config.toml'),
  `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(LIVE)}]\n`
)
const CLI = join(scratch, 'codex.mjs')
writeFileSync(
  CLI,
  `#!${process.execPath}
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
if (args[0] === '--version') { console.log('codex-cli 0.0.0-test'); process.exit(0) }
if (args[0] !== 'exec') process.exit(2)
readFileSync(0)
const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1] }
const configs = args.flatMap((arg, i) => (arg === '--config' ? [args[i + 1]] : []))
appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ sandbox: value('--sandbox'), cd: value('--cd'), configs }) + '\\n')
const { write, git } = JSON.parse(readFileSync(${JSON.stringify(PLAN)}, 'utf8'))
if (write) writeFileSync(write, 'written by the turn\\n')
for (const command of git ?? []) execFileSync('git', ['-C', ${JSON.stringify(LIVE)}, ...command], { stdio: 'pipe' })
out({ type: 'thread.started', thread_id: 'thread-' + process.pid })
out({ type: 'turn.started' })
out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'done' } })
out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })
`
)
chmodSync(CLI, 0o755)
process.env.TREZI_CODEX_BIN = CLI
process.env.CODEX_HOME = HOME
const runs = () => {
  try {
    return readFileSync(LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}
const { codexProvider } = await import('../src/main/backends/codex.ts')
const { startProviderSession } = await import('../src/main/provider-sessions.ts')
const { shutdownTreziAgentTools } = await import('../src/main/trezi-agent-tools.ts')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sessions = []
const turn = async (access, write, gitCommands = []) => {
  writeFileSync(PLAN, JSON.stringify({ write, git: gitCommands }))
  const events = []
  const s = await startProviderSession(
    codexProvider,
    WT,
    { provider: 'codex', agentFileAccess: access },
    () => null,
    { emitKey: `chat-${sessions.length}`, liveRoot: LIVE, onEvent: (e) => events.push(e) }
  )
  sessions.push(s)
  const ran = runs().length
  s.send('go')
  const deadline = Date.now() + 30_000
  while (!events.some((e) => e.type === 'done')) {
    assert.ok(Date.now() < deadline, `Timed out: ${access} turn`)
    await sleep(20)
  }
  await sleep(100)
  return { events, run: runs().slice(ran)[0] }
}
const said = (events) =>
  events
    .filter((e) => e.type === 'delta')
    .map((e) => e.text)
    .join('')

let skipped = false
try {
  const full = await turn('full', join(LIVE, 'direct.txt'))
  const error = full.events.find((e) => e.type === 'error')
  if (error && /EPERM|EACCES|listen/i.test(error.message)) {
    skipped = true
    console.log(
      `AGENT-FILE-ACCESS SKIP — Codex adapter not exercised: ${error.message.slice(0, 160)}`
    )
  } else {
    assert.equal(error, undefined, JSON.stringify(full.events))
    assert.equal(full.run.sandbox, 'danger-full-access', 'Full access: no Codex sandbox')
    assert.equal(full.run.cd, REAL_WT, "the worktree's real path, not the symlinked one")
    assert.ok(
      !full.run.configs.some((c) => c.startsWith('sandbox_workspace_write')),
      'no workspace-write config in Full access'
    )
    assert.ok(full.run.configs.includes('approval_policy="never"'), 'never asks')
    // LKM-215: the adapter no longer appends a live-tree note to the reply. Bun's watch
    // (above, and test/live-change-watch.mjs) reports outside changes as one chat row.
    assert.equal(said(full.events), 'done', 'the reply carries no live-tree note')
    assert.equal(full.events.filter((e) => e.type === 'done').length, 1)

    // A commit made directly in the live checkout: still no note in the reply.
    writeFileSync(join(LIVE, 'c.txt'), 'c\n')
    const commit = await turn('full', null, [
      ['add', 'c.txt'],
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'direct']
    ])
    assert.equal(commit.run.sandbox, 'danger-full-access')
    assert.equal(said(commit.events), 'done')

    // Project only: the LKM-156 sandbox, from the worktree's real path; no note.
    const project = await turn('project', join(LIVE, 'again.txt'))
    assert.equal(project.run.sandbox, 'workspace-write')
    assert.equal(project.run.cd, REAL_WT)
    assert.ok(
      project.run.configs.includes('sandbox_workspace_write.writable_roots=[]'),
      `the user's writable roots are dropped: ${JSON.stringify(project.run.configs)}`
    )
    assert.equal(said(project.events), 'done', 'Project only has the sandbox, not the note')
  }
} finally {
  for (const s of sessions) s.shutdown()
  await shutdownTreziAgentTools()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`AGENT-FILE-ACCESS PASS${skipped ? ' (adapter half skipped)' : ''}`)
