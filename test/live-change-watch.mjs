// LKM-215, no desktop: a Full access Codex turn reports only the live-tree changes Trezi
// did not make. Its own landings (land_now, the turn-end landing), publishes, conflict
// markers and installs are subtracted, dev-server output is never named, and a real
// outside change is one compact row: one line, Details, no absolute paths.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  beginLiveWatch,
  finishLiveWatch,
  generatedLivePath,
  liveChangeRow,
  noteAgentStep,
  treziLiveEffect,
  watchesLiveTree
} from '../src/main/live-change-watch.ts'
import { enqueueRepoWrite } from '../src/main/repo-write-queue.ts'
import { setRepositoryOwner } from '../src/main/repository-owner.ts'
import { LIVE_EFFECT_TOOLS } from '../src/main/session-tools.ts'
import { newChat, reduce } from '../src/native/chat-state.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-live-change-')))
const live = join(scratch, 'project')
const wt = join(scratch, 'worktree')
const elsewhere = join(scratch, 'clone')
const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    stdio: 'pipe'
  }).toString()
const write = (root, path, text) => {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}
const session = (options = {}) => ({
  root: wt,
  options: { provider: 'codex', agentFileAccess: 'full', ...options },
  record: { projectRoot: live }
})
// One turn of chat `key`: what changed in the live tree while `during` ran.
const turn = async (during, key = 'chat') => {
  await beginLiveWatch(key, session())
  await during()
  return finishLiveWatch(key)
}
// The repository lane, as the service runs it: one operation at a time.
let lane = Promise.resolve()
setRepositoryOwner({
  withLease: (_root, operation) => {
    const run = lane.then(operation)
    lane = run.catch(() => {})
    return run
  }
})

try {
  mkdirSync(live)
  mkdirSync(wt)
  write(live, 'src/app/portfolio/portfolio.module.css', '.a {}\n')
  write(live, 'README.md', 'readme\n')
  git(live, 'init', '-q', '-b', 'main')
  git(live, 'add', '-A')
  git(live, 'commit', '-qm', 'init')

  // Who is watched: Full access Codex (or a connection) in a chat worktree only.
  assert.ok(watchesLiveTree(session()))
  assert.ok(watchesLiveTree(session({ provider: undefined, connectionId: 'c' })))
  assert.ok(!watchesLiveTree(session({ agentFileAccess: 'project' })), 'Project only is sandboxed')
  assert.ok(!watchesLiveTree(session({ provider: 'claude' })), 'Claude has its guard')
  assert.ok(
    !watchesLiveTree({ ...session(), root: live }),
    'a chat on the live tree has nothing to compare'
  )

  // Every agent tool that changes the live checkout is Trezi's own effect.
  for (const tool of [
    'land_now',
    'publish_update',
    'publish_merge',
    'git_sync_base',
    'git_merge_continue',
    'git_merge_abort',
    'prepare_conflict_resolution',
    'restart_dev_server'
  ])
    assert.ok(LIVE_EFFECT_TOOLS.has(tool), `${tool} is recorded as Trezi's effect`)

  // (1) land_now mid-turn: Trezi writes the landed file and commits it. No row.
  let landings = 0
  const landNow = () =>
    treziLiveEffect(live, async () => {
      write(live, 'src/app/portfolio/portfolio.module.css', `.a { order: ${++landings} }\n`)
      git(live, 'add', 'src/app/portfolio/portfolio.module.css')
      git(live, 'commit', '-qm', 'Land current chat changes')
    })
  assert.equal(await turn(landNow), null, 'a land_now landing is not an outside change')

  // (2) Publish/merge: the live checkout fast-forwards to a merged PR with others' commits.
  git(scratch, 'clone', '-q', live, elsewhere)
  write(elsewhere, 'src/other.ts', 'export {}\n')
  git(elsewhere, 'add', '-A')
  git(elsewhere, 'commit', '-qm', 'Someone else')
  write(elsewhere, 'src/pr.ts', 'export {}\n')
  git(elsewhere, 'add', '-A')
  git(elsewhere, 'commit', '-qm', 'Merge pull request')
  const publish = () =>
    treziLiveEffect(live, async () => {
      git(live, 'pull', '-q', '--ff-only', elsewhere, 'HEAD')
    })
  assert.equal(await turn(publish), null, 'a publish/merge is not an outside change')

  // (3) The repository lane (the turn-end landing, conflict markers, installs) is Trezi's:
  // a landing that commits, and a conflict file it leaves uncommitted, are not named.
  const landing = () =>
    Promise.all([
      enqueueRepoWrite(live, async () => {
        write(live, 'src/landed.ts', 'export const a = 1\n')
        git(live, 'add', 'src/landed.ts')
        git(live, 'commit', '-qm', 'Turn landing')
      }),
      enqueueRepoWrite(live, async () => {
        write(live, 'src/conflict.ts', '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n')
      })
    ])
  assert.equal(await turn(landing), null, 'lane effects are subtracted')
  git(live, 'add', '-A')
  git(live, 'commit', '-qm', 'resolved')

  // (4) Dev-server output never counts, untracked or not ignored.
  assert.equal(
    await turn(async () => {
      write(live, '.next/cache/webpack/x.pack', 'x')
      write(live, 'dist/index.js', 'x')
      write(live, 'tsconfig.tsbuildinfo', '{}')
      write(live, 'node_modules/.vite/deps/react.js', 'x')
      write(live, 'next-env.d.ts', '/// <reference />\n')
      write(live, '.svelte-kit/generated/root.js', 'x')
    }),
    null,
    'generated files are ignored'
  )
  assert.ok(generatedLivePath('packages/web/.next/server/app.js'))
  assert.ok(!generatedLivePath('src/distance.ts') && !generatedLivePath('src/app/page.tsx'))

  // (5) A real outside edit (the user's editor) during a turn that also lands: one row
  // naming only that file, not blamed on the agent, with no absolute path.
  const outside = await turn(async () => {
    write(live, 'notes.md', 'mine\n')
    await landNow()
  })
  assert.deepEqual(outside?.files, ['notes.md'])
  assert.deepEqual(outside?.commits, [])
  assert.equal(outside?.agent, false)
  const row = liveChangeRow(outside)
  assert.equal(row.line, 'Your project changed outside this chat during this turn: notes.md')
  assert.ok(!row.line.includes('\n'), 'one line')
  assert.match(row.detail, /- `notes\.md`/)
  assert.match(row.detail, /your editor, another tool or a Git command/)
  assert.match(row.detail, /during the turn \(land now, Publish\) and when the turn ends/)
  assert.doesNotMatch(row.detail, /Revert cannot undo/, 'an editor edit is not an agent problem')
  for (const text of [row.line, row.detail]) {
    assert.ok(!text.includes(homedir()), 'no home path')
    assert.ok(!text.includes(scratch), 'no absolute path')
    assert.doesNotMatch(text, /applies that copy's changes when the turn finishes/)
  }

  // A file Trezi landed and the user then edited again is an outside change.
  const after = await turn(async () => {
    await landNow()
    write(live, 'src/app/portfolio/portfolio.module.css', '.a { color: blue }\n')
  })
  assert.deepEqual(after?.files, ['src/app/portfolio/portfolio.module.css'])

  // A file the user left uncommitted before the turn and did not touch is not news.
  assert.equal(await turn(async () => {}), null)

  // (6) Attribution: only the agent's own command naming the live checkout blames it.
  await beginLiveWatch('chat', session())
  noteAgentStep('chat', `$ cd ${wt} && echo ok > notes.md`)
  noteAgentStep('chat', `$ ls ${live}-old`)
  write(live, 'agent.txt', 'x\n')
  assert.equal((await finishLiveWatch('chat'))?.agent, false, 'worktree commands are its own')
  await beginLiveWatch('chat', session())
  noteAgentStep('chat', `$ echo x > ${live}/agent.txt && git -C ${live} commit -qam direct`)
  write(live, 'agent.txt', 'y\n')
  git(live, 'add', 'agent.txt')
  git(live, 'commit', '-qm', 'direct')
  const agent = await finishLiveWatch('chat')
  assert.equal(agent?.agent, true)
  assert.deepEqual(
    agent?.commits.map((c) => c.subject),
    ['direct']
  )
  const agentRow = liveChangeRow(agent)
  assert.match(agentRow.line, /^The agent changed your project outside this chat's workspace: /)
  assert.match(agentRow.line, /agent\.txt.*1 commit/)
  assert.match(agentRow.detail, /Revert cannot undo them/)
  assert.ok(!agentRow.detail.includes(scratch))

  // (6b) Continuation runs: each run of a turn opens its own watch (the first closes at
  // the first terminal event). The landing between the runs is not in the second one,
  // and a real outside edit during it is reported.
  await beginLiveWatch('chat', session())
  write(live, 'run1.md', 'run 1\n')
  assert.deepEqual((await finishLiveWatch('chat'))?.files, ['run1.md'], 'run 1 reports its edit')
  assert.equal(await finishLiveWatch('chat'), null, 'a closed watch reports nothing twice')
  await beginLiveWatch('chat', session(), true)
  await landNow()
  assert.equal(await finishLiveWatch('chat'), null, 'run 2: the landing before it is not news')
  // A continuation run's report adds to the turn's earlier one instead of replacing it.
  await beginLiveWatch('chat', session(), true)
  write(live, 'run2.md', 'run 2\n')
  assert.deepEqual(
    (await finishLiveWatch('chat'))?.files,
    ['run1.md', 'run2.md'],
    'run 2 reports the turn so far'
  )
  // The row is blamed on the agent when any run's own command did it, and a new turn
  // starts from nothing.
  await beginLiveWatch('chat', session())
  noteAgentStep('chat', `$ echo x > ${live}/run3.md`)
  write(live, 'run3.md', 'run 3\n')
  assert.deepEqual((await finishLiveWatch('chat'))?.files, ['run3.md'], 'a new turn starts afresh')
  await beginLiveWatch('chat', session(), true)
  write(live, 'run4.md', 'run 4\n')
  const merged = await finishLiveWatch('chat')
  assert.deepEqual(merged?.files, ['run3.md', 'run4.md'])
  assert.equal(merged?.agent, true, "an earlier run's agent write stays blamed on the agent")
  const firstRun = { files: ['run3.md'], commits: [], headMoved: false, agent: true }

  // (6c) A spawned agent runs in its own worktree under a key of its own: watched at the
  // same time as the chat, attributed on its own, and Trezi's landing of the chat's turn
  // is subtracted from it (the spawn's watch is open while that lane effect runs).
  const spawnSession = { ...session(), root: join(scratch, 'spawn-wt') }
  mkdirSync(spawnSession.root)
  await beginLiveWatch('chat', session())
  await beginLiveWatch('spawn:1', spawnSession)
  noteAgentStep('spawn:1', `$ echo x > ${live}/spawned.md`)
  write(live, 'spawned.md', 'x\n')
  await landNow()
  const spawned = await finishLiveWatch('spawn:1')
  assert.deepEqual(spawned?.files, ['spawned.md'], "the spawn's direct live write is reported")
  assert.equal(spawned?.agent, true, "and blamed on the spawn's own command")
  const chatTurn = await finishLiveWatch('chat')
  assert.equal(chatTurn?.agent, false, "the spawn's command is not the chat's")
  assert.deepEqual(chatTurn?.files, ['spawned.md'], 'the chat sees the same tree change')
  await beginLiveWatch('spawn:2', spawnSession)
  await landNow()
  assert.equal(await finishLiveWatch('spawn:2'), null, "a spawn's turn ignores Trezi's landing")
  git(live, 'add', '-A')
  git(live, 'commit', '-qm', 'settle')

  // agent.ts opens a watch for every Full access send path: the interactive send, an
  // automatic continuation run and a spawn, and a spawn reports at its end.
  const agentSource = readFileSync(new URL('../src/main/agent.ts', import.meta.url), 'utf8')
  const dispatch = agentSource.slice(agentSource.indexOf('dispatch: (session'))
  assert.match(dispatch.slice(0, dispatch.indexOf('})')), /beginLiveWatch\(key, session, true\)/)
  const start = agentSource.slice(agentSource.indexOf('async function startSpawn'))
  assert.match(start.slice(0, start.indexOf('s.send(q.text)')), /beginLiveWatch\(spawnWatchKey/)
  const finalize = agentSource.slice(agentSource.indexOf('async function finalizeSpawn'))
  assert.match(
    finalize.slice(0, finalize.indexOf('enqueueRepoWrite(parentRoot')),
    /finishLiveWatch\(spawnWatchKey\(id\)\)[\s\S]*type: 'live-change'/
  )

  // (7) The chat shows at most one row per turn, under the reply, after the landing.
  const chat = newChat('k')
  chat.turn = 't1'
  chat.isRunning = true
  chat.streamingId = 'reply'
  chat.messages.push({
    id: 'reply',
    role: 'assistant',
    text: 'Done',
    statuses: [],
    segments: [{ kind: 'text', text: 'Done' }]
  })
  reduce(chat, { type: 'done', landingPending: true })
  reduce(chat, { type: 'live-change', ...row, agent: false })
  reduce(chat, { type: 'live-change', ...row, agent: false })
  assert.equal(chat.messages.length, 1, 'held while the landing runs')
  reduce(chat, { type: 'isolation', state: 'merged', files: [], group: 'chat:1:1' })
  assert.equal(chat.messages[0].revertGroup, 'chat:1:1', 'Revert stays on the reply')
  reduce(chat, { type: 'landing-finished' })
  const rows = chat.messages.filter((m) => m.liveChange)
  assert.equal(rows.length, 1, 'one row per turn')
  assert.equal(chat.messages.at(-1), rows[0])
  assert.equal(rows[0].liveChange.line, row.line)
  reduce(chat, { type: 'live-change', ...row, agent: false })
  assert.equal(chat.messages.filter((m) => m.liveChange).length, 2, 'an idle chat shows it at once')

  // A turn with two runs: the later run's report is the turn so far, so the single row
  // names both runs' files and keeps the agent attribution.
  const twoRuns = newChat('k2')
  twoRuns.turn = 't2'
  twoRuns.isRunning = true
  reduce(twoRuns, { type: 'live-change', ...liveChangeRow(firstRun), agent: firstRun.agent })
  reduce(twoRuns, { type: 'live-change', ...liveChangeRow(merged), agent: merged.agent })
  assert.equal(twoRuns.messages.length, 0, 'held while the turn runs')
  reduce(twoRuns, { type: 'landing-finished' })
  const combined = twoRuns.messages.filter((m) => m.liveChange)
  assert.equal(combined.length, 1, 'one row for the turn')
  assert.match(combined[0].liveChange.detail, /run3\.md/)
  assert.match(combined[0].liveChange.detail, /run4\.md/)
  assert.equal(combined[0].liveChange.agent, true)
} finally {
  setRepositoryOwner(null)
  rmSync(scratch, { recursive: true, force: true })
}

console.log('LIVE-CHANGE-WATCH PASS')
