// LKM-156, no desktop: worktree chats cannot write the live checkout from Bash (Claude)
// or from Codex, which the ChatGPT seat and every Responses connection share. The Codex
// half drives the real CLI against a local fake Responses endpoint (no provider call)
// and prints SKIP where the machine cannot run it (no local port, no nested sandbox).
// LKM-163: both "Agent file access" modes (the Claude guard is the same in both; Codex
// is sandboxed only in Project only) and worktree/project paths behind symlinks.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexSandbox } from '../src/main/backends/codex-sandbox.ts'
import {
  liveTreeChanges,
  liveTreeSnapshot,
  liveWriteNote
} from '../src/main/backends/live-tree-watch.ts'
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

// --- Codex: the sandbox scope, Project only.
const plain = codexSandbox(live, live, 'project')
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
const scoped = codexSandbox(wt, live, 'project', { TMPDIR: '/var/folders/x/T/' })
assert.equal(scoped.thread.workingDirectory, wt)
assert.deepEqual(
  scoped.config,
  { sandbox_workspace_write: { writable_roots: [] } },
  "the user's extra roots are dropped"
)
assert.deepEqual(codexSandbox(wt, '/tmp/app', 'project', {}).config.sandbox_workspace_write, {
  writable_roots: [],
  exclude_slash_tmp: true
})
assert.deepEqual(
  codexSandbox(wt, '/var/folders/x/T/app', 'project', { TMPDIR: '/var/folders/x/T/' }).config
    .sandbox_workspace_write,
  { writable_roots: [], exclude_tmpdir_env_var: true }
)

// --- Codex: Full access (the default) has no sandbox, in a worktree or not.
for (const root of [wt, live]) {
  assert.deepEqual(
    codexSandbox(root, live, 'full', { TMPDIR: '/var/folders/x/T/' }),
    {
      thread: {
        workingDirectory: root,
        skipGitRepoCheck: true,
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      },
      config: {}
    },
    `Full access passes danger-full-access (${root})`
  )
}

// --- Symlinked paths (LKM-163): the profile's worktree root as an upgraded Mac has it
// (`Trezi Native` → `Praxis Native`, `trezi` → `praxis`), a project behind a symlinked
// folder, and `/tmp` → `/private/tmp`.
const links = realpathSync(await mkdtemp(join(tmpdir(), 'trezi-guard-links-')))
try {
  const support = join(links, 'Application Support')
  const store = join(support, 'Praxis Native', 'praxis')
  await mkdir(join(store, 'worktrees', 'chat-1'), { recursive: true })
  await symlink('Praxis Native', join(support, 'Trezi Native'))
  await symlink(store, join(support, 'Praxis Native', 'trezi'))
  await mkdir(join(links, 'disk', 'projects', 'swiftly-demos'), { recursive: true })
  await symlink(join(links, 'disk', 'projects'), join(links, 'projects'))
  const linkedWt = join(support, 'Trezi Native', 'trezi', 'worktrees', 'chat-1')
  const realWt = join(store, 'worktrees', 'chat-1')
  const linkedLive = join(links, 'projects', 'swiftly-demos')
  const realLive = join(links, 'disk', 'projects', 'swiftly-demos')
  for (const access of ['project', 'full']) {
    const sandbox = codexSandbox(linkedWt, linkedLive, access, {})
    assert.equal(
      sandbox.thread.workingDirectory,
      realWt,
      `${access}: Codex gets the real worktree path`
    )
    // (Temp roots are excluded too where the test's own temp folder is under `/tmp`.)
    if (access === 'project')
      assert.deepEqual(sandbox.config.sandbox_workspace_write.writable_roots, [])
    else assert.deepEqual(sandbox.config, {})
    // Same project under two names: not a worktree session.
    assert.deepEqual(codexSandbox(linkedLive, realLive, access, {}).config, {}, access)
  }
  assert.equal(codexSandbox(wt, '/tmp/app', 'project', {}).thread.workingDirectory, wt)
  // The Claude guard (the same rule in both modes) knows both names of each root.
  const edit = (path, root = linkedWt, liveRoot = linkedLive) =>
    liveCheckoutEdit('Write', { file_path: path }, root, liveRoot)
  for (const [root, liveRoot] of [
    [linkedWt, linkedLive],
    [realWt, realLive],
    [linkedWt, realLive],
    [realWt, linkedLive]
  ]) {
    for (const target of [join(linkedLive, 'src/a.tsx'), join(realLive, 'src/a.tsx')]) {
      const denied = edit(target, root, liveRoot)
      assert.equal(denied?.path, join(root, 'src/a.tsx'), `${target} from ${root} → ${liveRoot}`)
      assert.match(denied.reason, /Edit .* instead/)
    }
    for (const target of [join(linkedWt, 'src/a.tsx'), join(realWt, 'src/new/b.tsx')])
      assert.equal(edit(target, root, liveRoot), null, `the worktree's own ${target}`)
    assert.equal(
      liveCheckoutEdit(
        'Bash',
        { command: `sed -i '' s/a/b/ ${realLive}/src/a.tsx` },
        root,
        liveRoot
      )?.path,
      join(root, 'src/a.tsx'),
      'Bash naming the real live path'
    )
    assert.equal(
      liveCheckoutEdit('Bash', { command: `echo x > ${realWt}/a.txt` }, root, liveRoot),
      null,
      "Bash naming the worktree's real path"
    )
  }
  assert.equal(
    edit(join(realLive, 'a.ts'), linkedLive, realLive),
    null,
    'a non-worktree project under two names'
  )
} finally {
  await rm(links, { recursive: true, force: true })
}

// --- Codex in Full access: a live-tree change during a turn is named in one note.
const watched = realpathSync(await mkdtemp(join(tmpdir(), 'trezi-live-watch-')))
try {
  const git = (...args) => execFileSync('git', args, { stdio: 'pipe' })
  await writeFile(join(watched, 'a.txt'), 'a\n')
  await writeFile(join(watched, 'b.txt'), 'b\n')
  git('init', '-q', watched)
  git('-C', watched, 'add', '-A')
  git('-C', watched, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  await writeFile(join(watched, 'user-dirty.txt'), 'the user\n')
  const before = await liveTreeSnapshot(watched)
  assert.deepEqual([...before.files.keys()], ['user-dirty.txt'])
  assert.match(before.head, /^[0-9a-f]{40}$/, 'the snapshot records HEAD')
  assert.deepEqual(
    liveTreeChanges(before, await liveTreeSnapshot(watched)),
    [],
    'no change, no note'
  )
  const index = await readFile(join(watched, '.git/index'))
  await writeFile(join(watched, 'a.txt'), 'changed\n')
  await mkdir(join(watched, 'src'))
  await writeFile(join(watched, 'src/new file.ts'), 'x\n')
  await writeFile(join(watched, 'user-dirty.txt'), 'the agent, longer\n')
  const after = await liveTreeSnapshot(watched)
  assert.deepEqual(liveTreeChanges(before, after), ['a.txt', 'src/new file.ts', 'user-dirty.txt'])
  assert.deepEqual(
    await readFile(join(watched, '.git/index')),
    index,
    'the snapshot never writes the index'
  )
  assert.equal(await liveTreeSnapshot(join(watched, 'missing')), null, 'not a repository')
  const note = liveWriteNote(['a.txt', 'b', 'c', 'd', 'e', 'f', 'g'], '/wt')
  assert.match(note, /^\n\n⚠️ Your live project changed during this turn/)
  assert.match(note, /a\.txt, b, c, d, e and 2 more/)
  assert.match(note, /\(\/wt\)/)
} finally {
  await rm(watched, { recursive: true, force: true })
}

// --- Codex: the real CLI, driven by a fake Responses endpoint, cannot write the live tree.
const skip = (reason) => {
  console.log(`LIVE-WRITE-GUARD SKIP — Codex sandbox not exercised: ${reason}`)
  return null
}
const tmp = await mkdtemp(join(tmpdir(), 'trezi-live-guard-'))
const git = (...args) => execFileSync('git', args, { stdio: 'pipe' })
try {
  const liveRoot = join(tmp, 'live'),
    // Behind a symlink alias like the profile's `Trezi Native` → `Praxis Native`: Codex
    // refused that writable root before LKM-163 resolved it.
    worktree = join(tmp, 'Trezi Native', 'wt'),
    home = join(tmp, 'home')
  await mkdir(liveRoot, { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(join(tmp, 'Praxis Native'))
  await symlink('Praxis Native', join(tmp, 'Trezi Native'))
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

  const run = async (root, plan, access = 'project') => {
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
      const sandbox = codexSandbox(root, liveRoot, access)
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
      const said = [...outputs.values()]
      assert.ok(
        !said.some((o) => /symlink/i.test(o)),
        `Codex refused a symlinked path: ${said.join(' | ')}`
      )
      return said
    } catch (err) {
      // The reported bug (LKM-163) is a failure, never a SKIP.
      if (err instanceof assert.AssertionError || /symlink/i.test(String(err?.message))) throw err
      return skip(`the Codex CLI did not run (${String(err?.message ?? err).slice(0, 200)})`)
    } finally {
      server.close()
    }
  }

  // The worktree path has a space (`Trezi Native`): quote every path in the shell.
  const sh = (path) => `'${path}'`
  const attempts = [
    `echo x > ${sh(`${liveRoot}/a.txt`)}`,
    `echo x >> ${sh(`${liveRoot}/a.txt`)}`,
    `sed -i '' s/live/sed/ ${sh(`${liveRoot}/a.txt`)}`,
    `cp ${sh(`${worktree}/seed.txt`)} ${sh(`${liveRoot}/cp.txt`)}`,
    `mv ${sh(`${worktree}/move.txt`)} ${sh(`${liveRoot}/mv.txt`)}`,
    `echo x | tee ${sh(`${liveRoot}/tee.txt`)}`,
    `echo x > ${sh(`${liveRoot}/.git/probe`)}`,
    `echo ok > ${sh(`${worktree}/ok.txt`)}`
  ].join('; ')
  const outputs = await run(worktree, [
    { cmd: attempts },
    // Asking to leave the sandbox is refused outright under approvalPolicy 'never'.
    {
      cmd: `echo x > ${sh(`${liveRoot}/escalated.txt`)}`,
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
      const own = await run(liveRoot, [{ cmd: `echo own > ${sh(`${liveRoot}/own.txt`)}` }])
      if (own)
        assert.equal(
          await readFile(join(liveRoot, 'own.txt'), 'utf8'),
          'own\n',
          'a non-worktree session is unchanged'
        )

      // Full access (LKM-163): no sandbox, so the agent writes outside the project and
      // even the live tree; the adapter's before/after snapshot names that live write.
      const outside = join(tmp, 'outside')
      await mkdir(outside)
      const before = await liveTreeSnapshot(liveRoot)
      const full = await run(
        worktree,
        [
          {
            cmd: `echo out > ${sh(`${outside}/out.txt`)}; echo full > ${sh(`${liveRoot}/full.txt`)}; echo wt > ${sh(`${worktree}/full-ok.txt`)}`
          }
        ],
        'full'
      )
      if (full) {
        assert.equal(
          await readFile(join(outside, 'out.txt'), 'utf8'),
          'out\n',
          'writes outside the project'
        )
        assert.equal(
          await readFile(join(worktree, 'full-ok.txt'), 'utf8'),
          'wt\n',
          'and in its worktree'
        )
        assert.equal(
          await readFile(join(liveRoot, 'full.txt'), 'utf8'),
          'full\n',
          'Full access is not sandboxed'
        )
        assert.ok(
          liveTreeChanges(before, await liveTreeSnapshot(liveRoot)).includes('full.txt'),
          'the direct live write is detected'
        )
      }
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true })
}

console.log('LIVE-WRITE-GUARD PASS')
