/**
 * LKM-287: Trezi Skills at the session seams, with fixtures only (no provider call).
 * - `startProviderSession`: a durable skills identity per session (never the chat key),
 *   kept on resume, stamped on the record; a Bun session (custom endpoint) gets its
 *   projection, a helper gets its own in the open context; one note, inside a turn.
 * - Claude `query()` options: the projection as a skills-only plugin next to the bundled
 *   one, with settingSources, strict MCP, the managed-browser env and hooks unchanged;
 *   utility queries never get skills.
 * - Codex: the labelled compatibility catalog in the first turn only, the browser and Git
 *   hooks kept.
 * The Swift owner side (layout, pins, isolation, malicious content): skills-projection.mjs.
 */
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answer, calls, scripts } from './helpers/claude-sdk-mock.mjs'

const repo = join(import.meta.dir, '..')
const work = mkdtempSync(join(tmpdir(), 'trezi-session-skills-'))
const waitFor = async (done, what) => {
  for (let i = 0; i < 300 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(done(), what)
}
const ok = async () => {}

// Projections as the Swift owner lays them out (shape only; skills-projection.mjs builds real ones).
const projection = (provider, names) => {
  const dir = join(work, 'projections', 'a'.repeat(64), provider)
  for (const name of names) {
    mkdirSync(join(dir, 'skills', name), { recursive: true })
    writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`)
  }
  if (provider === 'claude') {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin/plugin.json'), '{"name":"trezi-library"}')
  }
  writeFileSync(
    join(dir, 'catalog.json'),
    JSON.stringify({
      format: 'trezi-skills-catalog-v1',
      session: 's',
      provider,
      plugin: provider === 'claude' ? 'trezi-library' : null,
      skills: names.map((name) => ({
        skill: name,
        name,
        description: `Use for ${name}.`,
        revision: 'b'.repeat(64),
        entry: `skills/${name}/SKILL.md`
      })),
      omitted: []
    })
  )
  return dir
}
const dirs = {
  claude: projection('claude', ['ui-notes']),
  codex: projection('codex', ['ui-notes', 'api-style']),
  gemini: projection('gemini', ['ui-notes'])
}

const {
  setSessionSkillsSource,
  releaseSessionSkills,
  projectSessionSkills,
  compatibilityCatalog,
  newSkillsSession,
  projectDeadline,
  admissionBudget,
  scaleSessionSkillsDeadlines
} = await import('../src/main/session-skills.ts')
const { serviceSkills } = await import('../src/native/skills-service.ts')
const projected = []
const released = []
let omitted = []
const pin = (name, providers = { claude: true, codex: true, gemini: true }) => ({
  skill: name,
  name,
  revision: 'b'.repeat(64),
  providers
})
const fixtureSource = {
  snapshot: async (session) => ({ session, createdAt: 1, pins: [pin('ui-notes')] }),
  project: async (session, provider) => {
    projected.push([session, provider])
    return {
      session,
      provider,
      path: dirs[provider],
      created: true,
      skills: [{ skill: 'ui-notes', name: 'ui-notes', revision: 'b'.repeat(64) }],
      omitted
    }
  },
  release: async (session) => {
    released.push(session)
    return { session, released: true }
  }
}
setSessionSkillsSource(() => fixtureSource)

// --- Session-start deadlines, through the real Skills client queue: a short answer bound,
// a projection bound that grows with the pins offered, and a separate budget for waiting
// behind other chats' starts or library edits. Scaled 1:100, no real waits.
{
  assert.equal(projectDeadline(0), 15_000)
  assert.equal(projectDeadline(128), 47_000, 'the 128-skill library gets 47 s, not 15 s')
  assert.equal(projectDeadline(512), 143_000)
  assert.equal(projectDeadline(100_000), projectDeadline(512), 'capped at the registry limit')
  assert.equal(admissionBudget(), 143_000, 'a start may queue for one maximum projection')
  scaleSessionSkillsDeadlines(0.01)
  const UNANSWERED = 'This chat started without Trezi Skills: the Trezi service did not answer'
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  // The real service client over a scripted link: `script(method, body)` returns
  // `{ after, payload }`, `{ after, failure }` or nothing (that request is never answered).
  const service = (script) => {
    let listener
    const sent = []
    const began = Date.now()
    const link = {
      on: (_event, fn) => {
        listener = fn
      },
      sendService: (frame) => {
        const { method, body } = frame.request
        sent.push({ method, session: body.session, at: Date.now() - began })
        const reply = script(method, body)
        if (!reply) return
        const result = reply.failure
          ? { kind: 'failed', payload: { retryable: false, ...reply.failure } }
          : { kind: 'succeeded', payload: reply.payload }
        setTimeout(
          () => listener({ service: frame.service, id: frame.id, reply: { result } }),
          reply.after
        )
      }
    }
    const client = serviceSkills(link, 2_000)
    setSessionSkillsSource(() => client)
    return { client, sent, began }
  }
  const library =
    (pins, layoutMs, extra = () => undefined) =>
    (method, body) =>
      extra(method, body) ??
      (method === 'snapshot'
        ? { after: 0, payload: { session: body.session, createdAt: 1, pins } }
        : method === 'project' && layoutMs !== null
          ? {
              after: layoutMs,
              payload: {
                session: body.session,
                provider: body.provider,
                path: dirs[body.provider],
                created: false,
                skills: pins.slice(0, 1),
                omitted: []
              }
            }
          : undefined)
  const timed = async (session) => {
    const began = Date.now()
    const result = await projectSessionSkills(session, 'codex')
    return { result, elapsed: Date.now() - began }
  }
  const many = Array.from({ length: 400 }, (_, i) => pin(`skill-${i}`))
  const methods = (sent) => sent.map((frame) => `${frame.method} ${frame.session ?? ''}`.trim())

  // An idle service that does not answer costs the chat the answer bound (15 s), not more.
  let fx = service(() => undefined)
  let run = await timed('trezi-d1')
  assert.equal(run.result.note, UNANSWERED)
  assert.ok(run.elapsed >= 140 && run.elapsed < 1_000, `answer bound (${run.elapsed} ms)`)
  assert.deepEqual(methods(fx.sent), ['snapshot trezi-d1'], 'no layout is requested without pins')

  // A large valid library whose layout outlasts the answer bound still loads.
  fx = service(library(many, 600))
  run = await timed('trezi-d2')
  assert.equal(run.result.note, undefined, 'a slow valid layout is not reported unavailable')
  assert.equal(run.result.path, dirs.codex)
  assert.deepEqual(methods(fx.sent), ['snapshot trezi-d2', 'project trezi-d2'])
  // A layout that never finishes is bounded by its size; a small one near the answer bound.
  fx = service(library(many, null))
  run = await timed('trezi-d3')
  assert.equal(run.result.note, UNANSWERED)
  assert.ok(run.elapsed >= 1_100 && run.elapsed < 3_000, `size-scaled bound (${run.elapsed} ms)`)
  fx = service(library([pin('one')], null))
  run = await timed('trezi-d4')
  assert.equal(run.result.note, UNANSWERED)
  assert.ok(run.elapsed < 1_000, `small library bound (${run.elapsed} ms)`)

  // Three chats start together on one client: each queues behind the others' healthy
  // layouts (300 ms each, inside their 470 ms bound) and still gets its skills, although
  // the last one waits longer than the 150 ms answer bound before its first request.
  const pins128 = many.slice(0, 128)
  fx = service(library(pins128, 300))
  const first = projectSessionSkills('trezi-a', 'codex')
  await sleep(20)
  const second = projectSessionSkills('trezi-b', 'codex')
  const third = projectSessionSkills('trezi-c', 'codex')
  for (const result of await Promise.all([first, second, third]))
    assert.deepEqual(result, { path: dirs.codex }, 'a queued start is not called unanswered')
  assert.deepEqual(methods(fx.sent), [
    'snapshot trezi-a',
    'project trezi-a',
    'snapshot trezi-b',
    'snapshot trezi-c',
    'project trezi-b',
    'project trezi-c'
  ])
  const thirdSent = fx.sent.find((frame) => frame.session === 'trezi-c').at
  assert.ok(thirdSent >= 280, `the third start queued ${thirdSent} ms and still loaded`)

  // A library edit ahead in the queue (250 ms, longer than the answer bound) delays, not fails.
  const edit = (after) => (method) =>
    method === 'list'
      ? { after: 0, payload: { revision: 'r1', skills: [] } }
      : method === 'create'
        ? after === null
          ? null
          : { after, payload: { revision: 'r2', skill: 's', skillRevision: 'b'.repeat(64) } }
        : undefined
  fx = service(library([pin('one')], 0, edit(250)))
  const created = fx.client.create([{ path: 'SKILL.md', text: 'x' }])
  run = await timed('trezi-d5')
  await created
  assert.deepEqual(run.result, { path: dirs.codex })
  assert.ok(run.elapsed >= 240, `queued behind the edit (${run.elapsed} ms)`)

  // A queue held past the start's admission budget (1430 ms here) by an edit the service
  // never answers (the client's own 2 s wait): the chat goes on as busy, not unanswered,
  // and its request is dropped unsent, so no pins appear for it later.
  fx = service(library([pin('one')], 0, edit(null)))
  const stuck = fx.client.create([{ path: 'SKILL.md', text: 'x' }])
  run = await timed('trezi-d6')
  assert.equal(
    run.result.note,
    'This chat started without Trezi Skills: Trezi Skills were busy with other requests'
  )
  assert.ok(run.elapsed >= 1_400 && run.elapsed < 2_000, `admission budget (${run.elapsed} ms)`)
  await assert.rejects(stuck, { code: 'deadlineExceeded' })
  await sleep(20)
  assert.deepEqual(methods(fx.sent), ['list', 'create'], 'the busy start sent nothing')

  // Pins offered only to another provider: no layout requested, nothing handed over.
  fx = service(library([pin('only', { claude: true, codex: false, gemini: false })], 0))
  assert.deepEqual(await projectSessionSkills('trezi-d7', 'codex'), {})
  assert.deepEqual(methods(fx.sent), ['snapshot trezi-d7'])
  // A service failure keeps its own message.
  fx = service(() => ({
    after: 0,
    failure: { code: 'recoveryRequired', message: 'the skills registry needs recovery' }
  }))
  assert.equal(
    (await projectSessionSkills('trezi-d8', 'codex')).note,
    'This chat started without Trezi Skills: the skills registry needs recovery'
  )
  // A source that ignores the bounds is still cut off, at admission plus answer.
  setSessionSkillsSource(() => ({ ...fixtureSource, snapshot: () => new Promise(() => {}) }))
  run = await timed('trezi-d9')
  assert.equal(run.result.note, UNANSWERED)
  assert.ok(run.elapsed >= 1_500 && run.elapsed < 3_000, `backstop (${run.elapsed} ms)`)

  scaleSessionSkillsDeadlines(1)
  setSessionSkillsSource(() => fixtureSource)
  console.log(
    'SESSION-SKILLS deadlines: answer bound, size-scaled projection, queued starts, busy queue PASS'
  )
}

// --- Identity and release ----------------------------------------------------------------
{
  assert.match(newSkillsSession(), /^trezi-[0-9a-f-]{36}$/)
  assert.notEqual(newSkillsSession(), newSkillsSession())
  releaseSessionSkills('trezi-a', true)
  releaseSessionSkills(undefined, false)
  releaseSessionSkills('a/b', false)
  releaseSessionSkills('trezi-b', false)
  assert.deepEqual(released, ['trezi-b'], 'released only when nothing keeps it')
  assert.deepEqual(await projectSessionSkills('trezi-c', 'openai'), {}, 'unknown provider')
  assert.deepEqual(await projectSessionSkills(undefined, 'claude'), {})
  projected.length = 0
  console.log('SESSION-SKILLS identity and release PASS')
}

// --- startProviderSession: the Bun path (a custom endpoint) and the helper path -------------
const { setProviderOwner } = await import('../src/main/provider-owner.ts')
const { startProviderSession } = await import('../src/main/provider-sessions.ts')
const { helperProvider } = await import('../src/main/backends/helper-session.ts')
{
  const contexts = []
  const fake = {
    id: 'codex',
    startSession: async (root, options, _w, ctx) => {
      contexts.push(ctx)
      const sent = []
      return {
        key: 'k',
        root,
        options,
        sent,
        send: (text) => sent.push(text),
        pending: new Map(),
        emit: (event) => ctx.onEvent?.(event),
        record: { id: `rec-${contexts.length}`, transcript: [], filesTouched: [] },
        finalize() {},
        dispose() {},
        shutdown() {}
      }
    }
  }
  setProviderOwner({
    kind: 'swift',
    open: async () => ({ tools: [] }),
    turn: ok,
    terminal: ok,
    resume: ok,
    close: ok,
    settled: ok,
    cancel: async () => ({ escalate: false })
  })
  const events = []
  const endpoint = { provider: 'codex', connectionId: 'endpoint-1' }
  omitted = [{ skill: 'x', name: 'old-tool', reason: 'outside the skills-only scope' }]
  const first = await startProviderSession(fake, work, endpoint, () => null, {
    emitKey: 'p',
    onEvent: (event) => events.push(event)
  })
  const id = contexts[0].skillsSession
  assert.match(id, /^trezi-/, 'a new session gets its own identity')
  assert.equal(first.record.skillsSession, id, 'stamped on the record, so it persists')
  assert.equal(contexts[0].skills, dirs.codex, 'the custom endpoint gets the Codex projection')
  assert.deepEqual(projected, [[id, 'codex']])
  assert.equal(events.length, 0, 'no note outside a turn')
  first.send('one')
  first.send('two')
  assert.deepEqual(first.sent, ['one', 'two'])
  const notes = events.filter((event) => event.type === 'status')
  assert.equal(notes.length, 1, 'the note is shown once')
  assert.match(notes[0].text, /left out of this chat: old-tool/)
  omitted = []
  // Same chat key, a second chat: its own identity. A resume keeps the original.
  const second = await startProviderSession(fake, work, endpoint, () => null, { emitKey: 'p' })
  assert.notEqual(second.record.skillsSession, id, 'the chat key is not the identity')
  const resumed = await startProviderSession(fake, work, endpoint, () => null, {
    emitKey: 'p',
    skillsSession: id,
    resumeSessionId: 'thread-1'
  })
  assert.equal(resumed.record.skillsSession, id, 'a resumed session keeps its pin')
  assert.equal(projected.at(-1)[0], id)

  // The helper path: the owner's open context carries this provider's projection.
  const opened = []
  setProviderOwner({
    kind: 'swift',
    openHelper: async (grant, start) => {
      opened.push({ grant, context: start.context })
      return { tools: [] }
    },
    send: ok,
    close: ok,
    answer: ok,
    configure: ok,
    cancel: async () => ({ escalate: false })
  })
  for (const provider of ['claude', 'codex', 'gemini']) {
    const s = await startProviderSession(helperProvider(provider), work, { provider }, () => null, {
      emitKey: `p#${provider}`,
      skillsSession: 'trezi-helper'
    })
    assert.equal(s.record.skillsSession, 'trezi-helper')
    const { grant, context } = opened.at(-1)
    assert.equal(grant.provider, provider)
    assert.equal(context.skills, dirs[provider], `${provider}: its own projection`)
    assert.equal(context.emitKey, `p#${provider}`)
    assert.ok(!('skillsSession' in context), 'the identity never reaches the helper')
    s.dispose?.()
  }
  // No library skills: no context key at all.
  setSessionSkillsSource(null)
  await startProviderSession(helperProvider('claude'), work, { provider: 'claude' }, () => null, {
    emitKey: 'p#none'
  })
  assert.ok(!('skills' in opened.at(-1).context))
  setProviderOwner(null)
  console.log(
    'SESSION-SKILLS startProviderSession identity, resume, Bun and helper projections PASS'
  )
}

// --- Claude: the plugin next to the bundled one; isolation, env and hooks unchanged --------
{
  const { claudeProvider } = await import('../src/main/backends/claude.ts')
  const claudeRoot = join(work, 'claude')
  mkdirSync(claudeRoot, { recursive: true })
  Bun.spawnSync(['git', 'init', '-q', claudeRoot])
  const start = async (context) => {
    scripts.push(answer())
    const events = []
    const session = await claudeProvider.startSession(claudeRoot, {}, () => null, {
      emitKey: 'p#chat',
      onEvent: (event) => events.push(event),
      ...context
    })
    session.send('hello')
    await waitFor(() => events.some((event) => event.type === 'done'), 'Claude turn finished')
    session.shutdown()
  }
  await start({ skills: dirs.claude })
  await start({})
  const [withSkills, without] = calls.map((call) => call.options)
  // The bundled `trezi` plugin resolves from the built layout (out/native), so a source
  // run may have none: the projection is always one more entry after whatever it has.
  const bundled = without.plugins ?? []
  assert.ok(bundled.every((plugin) => plugin.path.endsWith('agent-plugin')))
  assert.deepEqual(withSkills.plugins, [
    ...bundled,
    { type: 'local', path: dirs.claude, skipMcpDiscovery: true }
  ])
  for (const options of [withSkills, without]) {
    assert.deepEqual(options.settingSources, ['user', 'project', 'local'])
    assert.equal(options.strictMcpConfig, true, 'personal MCP stays off by default')
    assert.deepEqual(Object.keys(options.mcpServers), ['trezi'], 'no new MCP server')
    assert.equal(options.env.HOME, process.env.HOME, 'original HOME')
    assert.ok(options.env.TREZI_AGENT_BROWSER, 'managed browser env kept')
    assert.ok(options.hooks.PreToolUse[0].hooks.length >= 1, 'combined hooks kept')
  }
  assert.deepEqual(withSkills.allowedTools, without.allowedTools, 'no new tool grant')
  // Utility queries (titles, completions, memory) never load skills or settings.
  const source = readFileSync(join(repo, 'src/main/backends/claude.ts'), 'utf8')
  assert.equal(source.match(/claudePlugins\(ctx\?\.skills\)/g)?.length, 1, 'only the chat query')
  assert.equal(source.match(/settingSources: \[\],/g)?.length, 3, 'three isolated utility queries')
  console.log('SESSION-SKILLS Claude plugin projection with isolation, env and hooks PASS')
}

// --- Codex: the catalog in the first turn only; hooks kept --------------------------------
{
  const constructed = []
  const inputs = []
  class FakeCodex {
    constructor(options) {
      this.options = options
    }
    startThread() {
      constructed.push(this.options.config)
      return this.thread()
    }
    resumeThread() {
      constructed.push(this.options.config)
      return this.thread()
    }
    thread() {
      return {
        id: 'thread-1',
        runStreamed: async (input) => {
          inputs.push(input)
          return {
            events: (async function* () {
              yield {
                type: 'item.completed',
                item: { id: 'item_0', type: 'agent_message', text: 'Done.' }
              }
              yield {
                type: 'turn.completed',
                usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }
              }
            })()
          }
        }
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
  process.env.TREZI_CODEX_BIN = '/usr/bin/true'
  const { codexProvider } = await import('../src/main/backends/codex.ts')
  const codexRoot = join(work, 'codex')
  mkdirSync(codexRoot, { recursive: true })
  const events = []
  const session = await codexProvider.startSession(
    codexRoot,
    { provider: 'codex', permissionMode: 'auto' },
    () => null,
    { emitKey: 'codex-chat', skills: dirs.codex, onEvent: (event) => events.push(event) }
  )
  const done = () => events.filter((event) => event.type === 'done').length
  session.send('first turn')
  await waitFor(() => done() === 1, 'first Codex turn')
  session.send('second turn')
  await waitFor(() => done() === 2, 'second Codex turn')
  session.dispose()
  const text = (input) => (typeof input === 'string' ? input : JSON.stringify(input))
  const catalog = compatibilityCatalog(dirs.codex, 'codex')
  assert.ok(text(inputs[0]).includes(catalog), 'the first turn carries the catalog')
  assert.match(text(inputs[0]), /not Codex’s native skills system/)
  assert.ok(text(inputs[0]).includes(join(dirs.codex, 'skills/api-style/SKILL.md')))
  assert.ok(!text(inputs[0]).includes('name: api-style'), 'bodies are read on demand, not inlined')
  assert.ok(!text(inputs[1]).includes('Trezi Skills'), 'later turns do not repeat it')
  assert.ok(text(inputs[1]).includes('second turn'))
  for (const config of constructed) {
    const commands = config.hooks.PreToolUse.flatMap((entry) => entry.hooks.map((h) => h.command))
    assert.ok(
      commands.some((c) => c.includes('trezi-git-guard.mjs')),
      'Git guard kept'
    )
    assert.ok(
      commands.some((c) => c.includes('trezi-browser-guard.mjs')),
      'browser guard kept'
    )
    assert.ok(!JSON.stringify(config).includes(dirs.codex), 'no config or permission change')
  }
  console.log('SESSION-SKILLS Codex compatibility catalog on the first turn, hooks kept PASS')
}
