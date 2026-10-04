// LKM-156, no desktop: worktree chats cannot write the live checkout from Bash (Claude)
// or from Codex, which the ChatGPT seat and every Responses connection share. The Codex
// half drives the real CLI against a local fake Responses endpoint (no provider call)
// and prints SKIP where the machine cannot run it (no local port, no nested sandbox).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexSandbox } from '../src/main/backends/codex-sandbox.ts'
import { liveCheckoutCommand, liveCheckoutEdit } from '../src/main/live-write-guard.ts'

// --- Claude: Bash commands that name the live root are denied with the worktree path.
const live = '/Users/me/app',
  wt = '/Users/me/.trezi/worktrees/chat-1'
const bash = (command, root = wt, liveRoot = live) =>
  liveCheckoutEdit('Bash', { command }, root, liveRoot)
const writes = {
  'sed -i': (dir) => `sed -i '' 's/a/b/' ${dir}/src/a.tsx`,
  '>': (dir) => `echo x > ${dir}/src/a.tsx`,
  '>>': (dir) => `printf x >>${dir}/src/a.tsx`,
  cp: (dir) => `cp src/b.tsx ${dir}/src/a.tsx`,
  mv: (dir) => `mv ${dir}/src/a.tsx src/c.tsx`,
  tee: (dir) => `echo x | tee -a "${dir}/src/a.tsx" >/dev/null`,
  formatter: (dir) => `bunx prettier --write ${dir}/src/a.tsx`
}
for (const [name, command] of Object.entries(writes)) {
  const denied = bash(command(live))
  assert.ok(denied, `${name} onto the live root is denied`)
  assert.equal(denied.path, `${wt}/src/a.tsx`, `${name} names the worktree path`)
  assert.ok(
    denied.reason.includes(`${wt}/src/a.tsx`) && /not the live checkout/.test(denied.reason),
    name
  )
  assert.equal(bash(command(wt)), null, `${name} on the worktree is allowed`)
  assert.equal(bash(command('.')), null, `${name} on a relative path is allowed`)
  assert.equal(
    bash(command(live), live, live),
    null,
    `${name} in a non-worktree project is unchanged`
  )
}
// Every live path counts, not only the first argument; the first one is named.
assert.equal(bash(`cp ${wt}/a.ts ${live}/b.ts`).path, `${wt}/b.ts`)
assert.equal(bash(`cd ${live} && bun run format`).path, wt, 'the live root itself')
assert.equal(
  bash(`cat '${live}/My File.md'`).path,
  `${wt}/My File.md`,
  'reads are denied too, quoted paths kept whole'
)
assert.equal(
  liveCheckoutCommand(`echo x > /Users/me/My\\ App/a.txt`, wt, '/Users/me/My App').path,
  `${wt}/a.txt`,
  'escaped spaces'
)
assert.ok(bash(`find ${live}/src -name '*.tsx' -exec sed -i '' s/a/b/ {} +`))
// Siblings, longer names and other trees that merely contain the string are not the live root.
for (const command of [
  `echo x > /Users/me/app-other/a`,
  `echo x > /Users/me/app2/a`,
  `echo x > /x/Users/me/app/a`,
  `echo x > /Users/me/app.bak`,
  'rm -rf dist',
  'git status'
])
  assert.equal(bash(command), null, command)
// Home-relative spellings of a live root under the home folder.
const homeLive = join(homedir(), 'trezi-guard-app')
// biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own spelling
for (const spelling of ['~/trezi-guard-app', '$HOME/trezi-guard-app', '${HOME}/trezi-guard-app']) {
  assert.equal(bash(`echo x > ${spelling}/a.txt`, wt, homeLive)?.path, `${wt}/a.txt`, spelling)
}
// A worktree under the live tree may use its own paths, never the live ones around it.
const nested = `${live}/.worktrees/chat-2`
assert.equal(bash(`echo x > ${nested}/a.txt`, nested), null)
assert.equal(bash(`echo x > ${live}/a.txt && cat ${nested}/a.txt`, nested).path, `${nested}/a.txt`)
assert.equal(liveCheckoutEdit('Bash', { command: 42 }, wt, live), null)
assert.equal(liveCheckoutEdit('Bash', null, wt, live), null)

// --- Codex: the sandbox scope.
const plain = codexSandbox(live, live)
assert.deepEqual(
  plain,
  {
    thread: {
      workingDirectory: live,
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never'
    },
    config: {}
  },
  'a non-worktree project is unchanged'
)
const scoped = codexSandbox(wt, live, { TMPDIR: '/var/folders/x/T/' })
assert.equal(scoped.thread.workingDirectory, wt)
assert.deepEqual(
  scoped.config,
  { sandbox_workspace_write: { writable_roots: [] } },
  "the user's extra roots are dropped"
)
assert.deepEqual(codexSandbox(wt, '/tmp/app', {}).config.sandbox_workspace_write, {
  writable_roots: [],
  exclude_slash_tmp: true
})
assert.deepEqual(
  codexSandbox(wt, '/var/folders/x/T/app', { TMPDIR: '/var/folders/x/T/' }).config
    .sandbox_workspace_write,
  { writable_roots: [], exclude_tmpdir_env_var: true }
)

// --- Codex: the real CLI, driven by a fake Responses endpoint, cannot write the live tree.
const skip = (reason) => {
  console.log(`LIVE-WRITE-GUARD SKIP — Codex sandbox not exercised: ${reason}`)
  return null
}
const tmp = await mkdtemp(join(tmpdir(), 'trezi-live-guard-'))
const git = (...args) => execFileSync('git', args, { stdio: 'pipe' })
try {
  const liveRoot = join(tmp, 'live'),
    worktree = join(tmp, 'wt'),
    home = join(tmp, 'home')
  await mkdir(liveRoot, { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(join(liveRoot, 'a.txt'), 'live\n')
  git('init', '-q', liveRoot)
  git('-C', liveRoot, 'add', '-A')
  git('-C', liveRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  git('-C', liveRoot, 'worktree', 'add', '-q', worktree)
  await writeFile(join(worktree, 'seed.txt'), 'seed\n')
  await writeFile(join(worktree, 'move.txt'), 'move\n')
  // The user's own config makes the live tree writable; a worktree session drops it.
  await writeFile(
    join(home, 'config.toml'),
    `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(liveRoot)}]\n`
  )
  // A private CODEX_HOME and HOME: the user's Codex login, config and shell profile stay out.
  process.env.CODEX_HOME = home
  process.env.HOME = home

  const run = async (root, plan) => {
    // Each request repeats the earlier tool outputs; keep one per call.
    const outputs = new Map()
    let step = 0
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const request = JSON.parse(body || '{}')
      for (const item of request.input ?? [])
        if (item.type === 'function_call_output') outputs.set(item.call_id, String(item.output))
      const tools = new Set((request.tools ?? []).map((t) => t.name))
      const send = (type, data) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      send('response.created', { response: { id: `r${step}` } })
      const call = plan[step++]
      if (call) {
        const name = tools.has('exec_command') ? 'exec_command' : 'shell'
        const args =
          name === 'exec_command'
            ? { cmd: call.cmd, ...call.extra }
            : { command: ['sh', '-c', call.cmd], ...call.extra }
        send('response.output_item.done', {
          item: {
            type: 'function_call',
            id: `f${step}`,
            call_id: `c${step}`,
            name,
            arguments: JSON.stringify(args)
          }
        })
      } else {
        send('response.output_item.done', {
          item: {
            type: 'message',
            role: 'assistant',
            id: 'm',
            content: [{ type: 'output_text', text: 'done' }]
          }
        })
      }
      send('response.completed', {
        response: { id: `r${step}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
      })
      res.end()
    })
    const listening = await new Promise((resolve) => {
      server.once('error', (err) => resolve(err))
      server.listen(0, '127.0.0.1', () => resolve(null))
    })
    if (listening) return skip(`no local port (${listening.code ?? listening.message})`)
    try {
      const { Codex } = await import('@openai/codex-sdk')
      const sandbox = codexSandbox(root, liveRoot)
      // The adapter's own thread options and sandbox config, on a connection-style provider.
      const codex = new Codex({
        apiKey: 'fake-key',
        config: {
          cli_auth_credentials_store: 'file',
          model_provider: 'fake',
          model_providers: {
            fake: {
              name: 'fake',
              base_url: `http://127.0.0.1:${server.address().port}/v1`,
              env_key: 'CODEX_API_KEY',
              wire_api: 'responses',
              supports_websockets: false
            }
          },
          ...sandbox.config
        }
      })
      await codex
        .startThread({ ...sandbox.thread, model: 'fake-model' })
        .run('go', { signal: AbortSignal.timeout(60_000) })
      return [...outputs.values()]
    } catch (err) {
      return skip(`the Codex CLI did not run (${String(err?.message ?? err).slice(0, 200)})`)
    } finally {
      server.close()
    }
  }

  const attempts = [
    `echo x > ${liveRoot}/a.txt`,
    `echo x >> ${liveRoot}/a.txt`,
    `sed -i '' s/live/sed/ ${liveRoot}/a.txt`,
    `cp ${worktree}/seed.txt ${liveRoot}/cp.txt`,
    `mv ${worktree}/move.txt ${liveRoot}/mv.txt`,
    `echo x | tee ${liveRoot}/tee.txt`,
    `echo x > ${liveRoot}/.git/probe`,
    `echo ok > ${worktree}/ok.txt`
  ].join('; ')
  const outputs = await run(worktree, [
    { cmd: attempts },
    // Asking to leave the sandbox is refused outright under approvalPolicy 'never'.
    {
      cmd: `echo x > ${liveRoot}/escalated.txt`,
      extra: { sandbox_permissions: 'require_escalated', justification: 'test' }
    }
  ])
  if (outputs) {
    const ok = await readFile(join(worktree, 'ok.txt'), 'utf8').catch(() => null)
    if (ok !== 'ok\n') {
      skip(`the sandbox did not run commands here (${outputs.join(' | ').slice(0, 300)})`)
    } else {
      assert.equal(
        await readFile(join(liveRoot, 'a.txt'), 'utf8'),
        'live\n',
        '>, >> and sed -i cannot touch the live tree'
      )
      for (const name of ['cp.txt', 'mv.txt', 'tee.txt', '.git/probe', 'escalated.txt']) {
        assert.ok(!existsSync(join(liveRoot, name)), `${name} was not written to the live tree`)
      }
      assert.ok(existsSync(join(worktree, 'move.txt')), 'mv left its source in the worktree')
      assert.match(outputs[0], /operation not permitted/i)
      assert.match(outputs[1] ?? '', /escalat/i)

      // A project that is not isolated still writes its own tree.
      const own = await run(liveRoot, [{ cmd: `echo own > ${liveRoot}/own.txt` }])
      if (own)
        assert.equal(
          await readFile(join(liveRoot, 'own.txt'), 'utf8'),
          'own\n',
          'a non-worktree session is unchanged'
        )
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true })
}

console.log('LIVE-WRITE-GUARD PASS')
