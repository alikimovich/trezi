/**
 * LKM-269: the managed agent-browser route at the Codex and Claude dispatch boundaries,
 * with fixtures only (no live provider call): Claude's `query()` options and Bash hook
 * for a first and a resumed turn, Codex's per-turn config for a first and a resumed
 * turn, then that Codex config replayed through the real SDK into a fake `codex` binary.
 */
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answer, calls, scripts } from './helpers/claude-sdk-mock.mjs'

const repo = join(import.meta.dir, '..')
const wrapper = join(repo, 'bin/managed/agent-browser')
const managedDir = join(repo, 'bin/managed')
const work = mkdtempSync(join(tmpdir(), 'trezi-managed-provider-'))
const waitFor = async (done, what) => {
  for (let i = 0; i < 300 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(done(), what)
}

// --- Claude: a first turn and a resumed turn both carry the route and the hook ----------
const { claudeProvider } = await import('../src/main/backends/claude.ts')
const claudeRoot = join(work, 'claude')
mkdirSync(claudeRoot, { recursive: true })
Bun.spawnSync(['git', 'init', '-q', claudeRoot]) // the Git hook reads the live branch
const claudeSession = async (context) => {
  scripts.push(answer())
  const events = []
  const session = await claudeProvider.startSession(claudeRoot, {}, () => null, {
    emitKey: 'p#chat',
    onEvent: (event) => events.push(event),
    ...context
  })
  if (context.send) {
    session.send('hello')
    await waitFor(() => events.some((event) => event.type === 'done'), 'Claude turn finished')
  }
  session.shutdown()
}
await claudeSession({ send: true })
await claudeSession({ resumeSessionId: 'abc' })
assert.equal(calls.length, 2)
assert.equal(calls[1].options.resume, 'abc')
for (const [i, call] of calls.entries()) {
  const label = i === 0 ? 'first Claude turn' : 'resumed Claude turn'
  const { env } = call.options
  assert.equal(env.TREZI_AGENT_BROWSER, wrapper, `${label}: TREZI_AGENT_BROWSER`)
  assert.equal(env.PATH.split(':')[0], managedDir, `${label}: managed directory first`)
  assert.equal(env.HOME, process.env.HOME, `${label}: the rest of the environment is kept`)
  const hook = call.options.hooks.PreToolUse[0].hooks[0]
  const decide = async (command, tool = 'Bash') =>
    (await hook({ tool_name: tool, tool_input: { command } })).hookSpecificOutput
  for (const command of [
    'agent-browser open http://x --session trezi-a',
    'command agent-browser open http://x --session trezi-a',
    'command /opt/homebrew/bin/agent-browser open http://x --session trezi-a',
    '/opt/homebrew/bin/agent-browser open http://x --session trezi-a',
    '"$TREZI_AGENT_BROWSER" --headed open http://x --session trezi-a',
    `${wrapper} --executable-path "/Applications/Google Chrome.app" open x`
  ]) {
    const decision = await decide(command)
    assert.equal(decision?.permissionDecision, 'deny', `${label}: refuses ${command}`)
    assert.match(decision.permissionDecisionReason, /TREZI_AGENT_BROWSER|unavailable|Chrome/)
  }
  for (const command of [
    '"$TREZI_AGENT_BROWSER" open http://x --session trezi-a',
    `${wrapper} snapshot --session trezi-a`,
    'command -v agent-browser'
  ])
    assert.equal(await decide(command), undefined, `${label}: allows ${command}`)
  // The existing Git refusal still runs first.
  assert.match((await decide('git push origin main')).permissionDecisionReason, /Git/)
}

// --- Codex: the per-turn config, first and resumed ---------------------------------------
const constructed = []
class FakeCodex {
  constructor(options) {
    this.options = options
  }
  startThread() {
    constructed.push({ kind: 'start', config: this.options.config })
    return this.thread()
  }
  resumeThread(id) {
    constructed.push({ kind: 'resume', id, config: this.options.config })
    return this.thread()
  }
  thread() {
    return {
      id: 'thread-1',
      runStreamed: async () => ({
        events: (async function* () {
          yield {
            type: 'item.completed',
            item: { id: 'item_0', type: 'agent_message', text: 'The task is complete.' }
          }
          yield {
            type: 'turn.completed',
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        })()
      })
    }
  }
}
const realMcp = await import('../src/main/backends/codex-mcp.ts')
mock.module('@openai/codex-sdk', () => ({ Codex: FakeCodex }))
mock.module('../src/main/backends/codex-mcp.ts', () => ({
  ...realMcp,
  verifyTreziMcp: async () => {}
}))
mock.module('../src/main/trezi-agent-tools.ts', () => ({
  registerTreziAgentTools: async () => ({ socketPath: '/nowhere', token: 'fake', dispose() {} }),
  shutdownTreziAgentTools: async () => {}
}))
process.env.TREZI_CODEX_BIN = '/usr/bin/true' // only the adapter's version probe
const { codexProvider } = await import('../src/main/backends/codex.ts')
const codexRoot = join(work, 'codex')
mkdirSync(codexRoot, { recursive: true })
const codexEvents = []
const codexSession = await codexProvider.startSession(
  codexRoot,
  { provider: 'codex', permissionMode: 'auto' },
  () => null,
  { emitKey: 'codex-chat', onEvent: (event) => codexEvents.push(event) }
)
const done = () => codexEvents.filter((event) => event.type === 'done').length
codexSession.send('first turn')
await waitFor(() => done() === 1, 'first Codex turn finished')
codexSession.send('second turn')
await waitFor(() => done() === 2, 'second Codex turn finished')
codexSession.dispose()
assert.ok(
  constructed.some((c) => c.kind === 'start'),
  'a thread was started'
)
assert.ok(constructed.filter((c) => c.kind === 'resume').length >= 2, 'turns resume the thread')
for (const { kind, config } of constructed) {
  const set = config.shell_environment_policy.set
  assert.equal(config.allow_login_shell, false, `${kind}: login shells off`)
  assert.equal(set.TREZI_AGENT_BROWSER, wrapper, `${kind}: TREZI_AGENT_BROWSER`)
  assert.equal(set.PATH.split(':')[0], managedDir, `${kind}: managed directory first`)
  const commands = config.hooks.PreToolUse.flatMap((entry) => entry.hooks.map((h) => h.command))
  assert.equal(commands.length, 2, `${kind}: Git and browser hooks both present`)
  assert.ok(
    commands.some((c) => c.includes('trezi-git-guard.mjs')),
    `${kind}: Git guard kept`
  )
  assert.ok(
    commands.some((c) => c.includes('trezi-browser-guard.mjs') && c.includes(wrapper)),
    `${kind}: browser guard`
  )
  assert.equal(config.features.hooks, true)
}

// --- Codex: that config through the real SDK into a fake binary --------------------------
const fakeCodex = join(work, 'codex-fake')
writeFileSync(
  fakeCodex,
  `#!/bin/sh
{ printf 'ARG %s\\n' "$@"; printf 'ENV TREZI_AGENT_BROWSER=%s\\n' "$TREZI_AGENT_BROWSER"; } > "$ARGS_FILE"
echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'
`
)
chmodSync(fakeCodex, 0o755)
const replay = (entry, name) => {
  const argsFile = join(work, `${name}.args`)
  const proc = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `const { Codex } = await import('@openai/codex-sdk')
       const codex = new Codex({ codexPathOverride: process.argv[1], config: JSON.parse(process.argv[2]) })
       const options = { skipGitRepoCheck: true, workingDirectory: process.argv[3] }
       const thread = process.argv[4] === 'resume' ? codex.resumeThread('t0', options) : codex.startThread(options)
       await thread.run('hi')`,
      fakeCodex,
      JSON.stringify(entry.config),
      work,
      entry.kind
    ],
    { cwd: repo, env: { ...process.env, ARGS_FILE: argsFile }, stdout: 'pipe', stderr: 'pipe' }
  )
  assert.equal(proc.exitCode, 0, proc.stderr.toString())
  return readFileSync(argsFile, 'utf8').split('\n')
}
for (const entry of [
  constructed.find((c) => c.kind === 'start'),
  constructed.find((c) => c.kind === 'resume')
]) {
  const lines = replay(entry, entry.kind)
  assert.ok(
    lines.includes('ARG allow_login_shell=false'),
    `${entry.kind}: login shells off reaches the CLI`
  )
  assert.ok(
    lines.includes(
      `ARG shell_environment_policy.set.TREZI_AGENT_BROWSER=${JSON.stringify(wrapper)}`
    ),
    `${entry.kind}: wrapper reaches the CLI`
  )
  assert.ok(
    lines.some((line) => line.startsWith(`ARG shell_environment_policy.set.PATH="${managedDir}:`)),
    `${entry.kind}: managed PATH reaches the CLI`
  )
  assert.equal(lines.includes('ARG resume'), entry.kind === 'resume', `${entry.kind}: resume arg`)
}

console.log(
  'MANAGED BROWSER PROVIDER OK — Claude and Codex first and resumed turns carry the managed route and hooks'
)
process.exit(0)
