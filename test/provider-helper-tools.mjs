// LKM-131: Trezi's agent tools work from provider helpers. The real Claude and Codex
// adapters run in the real helper host under the Swift ProviderOwner fixture, each driven
// by a stand-in CLI (no model, network or credential) that calls EVERY Trezi tool its
// session exposes: Claude's through the SDK's in-process `trezi` MCP server, Codex's
// through the Trezi MCP bridge. Main (this process) holds the services those tools need:
// chat islands on the real Swift editing owner, a preview source, Gen UI, the workflow
// owner and a window. The test fails when
// - a tool is neither pure nor routed to main (a new tool must be classified here);
// - a routed tool's result is a missing-service answer ("not available", Gen UI off, no
//   preview) instead of main's, or a tool that needs main runs in the helper;
// - a background session's call outside its grant is not refused by the owner, or runs;
// and it checks that the helper-created island round-trips its controls in main.
import './helpers/with-service-owners.mjs'
import assert from 'node:assert/strict'
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
import { fileURLToPath } from 'node:url'
import { compileProviderFixture, startProviderFixture } from './helpers/provider-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const binary = compileProviderFixture()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'trezi-helper-tools-')))
const WT = join(scratch, 'project'),
  PROFILE = join(scratch, 'profile')
mkdirSync(WT)
mkdirSync(PROFILE)
const CODE = 'const LIGHT_X = 0;\nconst LIGHT_Y = -0.5;\n'
writeFileSync(join(WT, 'shadow.js'), CODE)
const CHAT = 'helper-tools-chat',
  URL_SHOWN = 'http://127.0.0.1:5199/helper-route'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9])

const number = (id, anchor) => ({
  id,
  label: id,
  kind: 'number',
  min: -1,
  max: 1,
  step: 0.01,
  apply: { strategy: 'literal', anchor }
})
const island = {
  action: 'define',
  engine: 'agent',
  manifest: {
    file: 'shadow.js',
    component: 'Card',
    title: 'Light',
    params: [number('x', 'const LIGHT_X = '), number('y', 'const LIGHT_Y = ')]
  },
  blocks: [{ id: 'light', title: 'Light position', kind: 'point', params: ['x', 'y'] }]
}

// What each stand-in calls a tool with. A tool the session lists but this table lacks fails.
const { SKILL_PACKS } = await import('../src/main/skill-packs.ts')
const CALLS = {
  project_ui_catalog: {},
  compose_project_ui: {
    file: 'Card.tsx',
    spec: { root: 'r', elements: { r: { type: 'Text', props: { text: 'hi' }, children: [] } } }
  },
  preview_location: {},
  preview_screenshot: {},
  preview_inspect: { selector: 'h1' },
  preview_evaluate: { expression: '1 + 1' },
  preview_console: {},
  preview_viewport: { preset: 'mobile' },
  open_preview: { path: '/helper-route' },
  open_code: { file: 'shadow.js', startLine: 1, endLine: 2 },
  chat_island: island,
  workspace_state: {},
  prepare_conflict_resolution: {},
  git_sync_base: {},
  git_merge_continue: {},
  git_merge_abort: {},
  pr_status: {},
  publish_update: {},
  spring_to_css: { stiffness: 170, damping: 26, mass: 1 },
  check_contrast: { foreground: '#000000', background: '#ffffff' },
  fluid_clamp: { minPx: 16, maxPx: 24 },
  color_scale: { seed: '#3366ff' },
  layered_shadow: { elevation: 3 },
  line_height: { fontSizePx: 16 },
  list_recommended_skills: {},
  install_skills: { packId: SKILL_PACKS[0].id, scope: 'project' }
}
// Pure: computed where the provider runs. Every other tool must reach main.
const PURE = new Set([
  'spring_to_css',
  'check_contrast',
  'fluid_clamp',
  'color_scale',
  'layered_shadow',
  'line_height',
  'list_recommended_skills'
])
const MISSING =
  /not available|is not running|cannot start|Gen UI is off|No project preview is open|No project preview capture|is not one of Trezi/i
const PLAN = join(scratch, 'plan.json'),
  LOG = join(scratch, 'calls.log')
writeFileSync(PLAN, JSON.stringify({ calls: CALLS, log: LOG }))

// --- the stand-in `claude`: the SDK's stream-json control protocol, no model -------------
// Each user turn lists the in-process `trezi` MCP server's tools (or `only a,b`) and
// calls each through `mcp_message` control requests, as the real CLI does for SDK servers.
const CLAUDE = join(scratch, 'claude')
writeFileSync(
  CLAUDE,
  `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const args = process.argv.slice(2)
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0) }
if (args[0] === '--version') { console.log('0.0.0 (Claude Code)'); process.exit(0) }
const plan = JSON.parse(readFileSync(${JSON.stringify(PLAN)}, 'utf8'))
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
const waiting = new Map()
let sequence = 0, rpc = 0
const control = (request) => new Promise((resolve) => { const id = 'fake-' + ++sequence; waiting.set(id, resolve); out({ type: 'control_request', request_id: id, request }) })
const mcp = async (method, params) => {
  const id = method.startsWith('notifications/') ? undefined : ++rpc
  const r = await control({ subtype: 'mcp_message', server_name: 'trezi', message: { jsonrpc: '2.0', ...(id ? { id } : {}), method, params } })
  if (r.subtype !== 'success') throw new Error(r.error)
  return r.response.mcp_response
}
const meta = { session_id: 'fake-claude', uuid: '00000000-0000-4000-8000-000000000000' }
const turn = async (text) => {
  out({ type: 'system', subtype: 'init', slash_commands: [], tools: [], mcp_servers: [{ name: 'trezi', status: 'connected' }], model: 'fake', permissionMode: 'default', cwd: process.cwd(), apiKeySource: 'none', ...meta })
  await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } })
  await mcp('notifications/initialized', {})
  const listed = (await mcp('tools/list', {})).result.tools.map((t) => t.name)
  const only = /only ([\\w,]+)/.exec(text)?.[1].split(',')
  const results = {}
  for (const name of only ?? listed) {
    results[name] = name in plan.calls ? (await mcp('tools/call', { name, arguments: plan.calls[name] })).result : { unplanned: true }
  }
  appendFileSync(plan.log, JSON.stringify({ via: 'claude', text, listed, results }) + '\\n')
  out({ type: 'assistant', message: { id: 'msg', type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'TOOLS DONE' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, ...meta })
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: 'TOOLS DONE', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, ...meta })
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.type === 'control_response') { const settle = waiting.get(m.response.request_id); waiting.delete(m.response.request_id); settle?.(m.response); return }
  if (m.type === 'control_request') {
    const response = m.request.subtype === 'initialize' ? { commands: [], models: [], account: {}, output_style: 'default', available_output_styles: ['default'] } : {}
    return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } })
  }
  if (m.type !== 'user') return
  const content = m.message.content
  const text = typeof content === 'string' ? content : content.map((b) => b.text ?? '').join('')
  turn(text).catch((error) => {
    appendFileSync(plan.log, JSON.stringify({ via: 'claude', text, crash: String(error?.stack ?? error) }) + '\\n')
    out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: '', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, ...meta })
  })
}).on('close', () => process.exit(0))
`
)
chmodSync(CLAUDE, 0o755)

// --- the stand-in `codex`: each exec connects to the Trezi MCP server its --config names --
const client = import.meta.resolve('@modelcontextprotocol/sdk/client/index.js')
const stdio = import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js')
const CODEX = join(scratch, 'codex')
writeFileSync(
  CODEX,
  `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
if (args[0] === '--version') { console.log('codex-cli 0.0.0-test'); process.exit(0) }
if (args[0] !== 'exec') process.exit(2)
const text = readFileSync(0, 'utf8')
const plan = JSON.parse(readFileSync(${JSON.stringify(PLAN)}, 'utf8'))
const toml = args.flatMap((arg, i) => (arg === '--config' ? [args[i + 1].replace('=', ' = ')] : [])).join('\\n')
const server = Bun.TOML.parse(toml).mcp_servers.trezi
const { Client } = await import(${JSON.stringify(client)})
const { StdioClientTransport } = await import(${JSON.stringify(stdio)})
const mcp = new Client({ name: 'fake-codex', version: '0' })
await mcp.connect(new StdioClientTransport({ command: server.command, args: server.args, cwd: server.cwd, env: server.env, stderr: 'ignore' }))
const listed = (await mcp.listTools()).tools.map((t) => t.name)
const results = {}
for (const name of listed) results[name] = name in plan.calls ? await mcp.callTool({ name, arguments: plan.calls[name] }) : { unplanned: true }
await mcp.close()
appendFileSync(plan.log, JSON.stringify({ via: 'codex', text, listed, results }) + '\\n')
out({ type: 'thread.started', thread_id: 'thread-' + process.pid })
out({ type: 'turn.started' })
out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'TOOLS DONE' } })
out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })
`
)
chmodSync(CODEX, 0o755)
const logged = () => {
  try {
    return readFileSync(LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

// --- main's state: what the helper does not have ------------------------------------------
const { ChatIslands, installChatIslands } = await import('../src/main/chat-islands.ts')
const { registerPreviewSource } = await import('../src/main/preview-state.ts')
const { setProjectUiEnabled } = await import('../src/main/project-ui.ts')
const { setWorkflowOwner } = await import('../src/main/workflow-owner.ts')
const { setProviderOwner } = await import('../src/main/provider-owner.ts')
const { helperProvider } = await import('../src/main/backends/helper-session.ts')
const { startProviderSession } = await import('../src/main/provider-sessions.ts')
const { SESSION_TOOLS } = await import('../src/main/session-tools.ts')

const islands = new ChatIslands(() => {})
installChatIslands(islands)
islands.register(CHAT, WT, 'helper-record', () => 1)
// LKM-138: a stand-in for the native preview's isolated-world host.
let shownWidth = 800
registerPreviewSource({
  getUrl: () => URL_SHOWN,
  capture: async () => ({
    isEmpty: () => false,
    getSize: () => ({ width: 10, height: 10 }),
    resize: () => {
      throw new Error('unused')
    },
    toJPEG: () => JPEG
  }),
  agent: {
    async evaluate(code) {
      if (code.includes('__treziAgentRuntime'))
        return { ok: true, type: 'number', value: 2, bytes: 1, ms: 0 }
      if (code.includes('__treziAgentInspect'))
        return { element: '<h1>', styles: { 'box-shadow': 'none' } }
      if (code.includes('__treziAgentConsole')) return { total: 0, dropped: 0, entries: [] }
      return { innerWidth: shownWidth, innerHeight: 600 }
    },
    captureRect: async () => null,
    async setViewport(width) {
      shownWidth = width ?? 800
      return { width, zoom: 1 }
    }
  }
})
setProjectUiEnabled(CHAT, true)
const installs = []
setWorkflowOwner({
  installSkills: async (input) => {
    installs.push(input)
    return {
      ok: true,
      packId: input.packId,
      scope: input.scope,
      targetDir: '',
      installed: [],
      message: `Installed ${input.packId} (main).`
    }
  }
})
const notified = []
const view = {
  webContents: {
    isDestroyed: () => false,
    send: (channel, payload) => notified.push({ channel, payload })
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (condition, label, ms = 60_000) => {
  const deadline = Date.now() + ms
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}\n${fixture?.stderr ?? ''}`)
    await sleep(20)
  }
}
/** The tool calls the owner relayed to main (authorized; main then ran them). */
const routed = (from = 0) =>
  fixture.events
    .slice(from)
    .filter((e) => e.service === 'provider' && e.kind === 'tool')
    .map((e) => e.tool)
const textOf = (result) => JSON.stringify(result)

let fixture
const sessions = []
try {
  fixture = await startProviderFixture(binary, PROFILE, {
    PROVIDER_HELPER_ARGS: [join(root, 'test/fixtures/tools-helper.mjs'), CLAUDE, CODEX].join(
      '\u001f'
    ),
    PROVIDER_HELPER_PROVIDERS: 'claude,codex',
    // The helper loads both real adapters and their SDKs; a cold transpile cache is slow.
    PROVIDER_READY: '60'
  })
  setProviderOwner(fixture.owner())

  async function chat(provider, ctx = {}) {
    const events = []
    const s = await startProviderSession(helperProvider(provider), WT, { provider }, () => view, {
      emitKey: CHAT,
      liveRoot: WT,
      onEvent: (e) => events.push(e),
      ...ctx
    })
    sessions.push(s)
    const turn = async (text) => {
      const start = events.length,
        calls = logged().length,
        from = fixture.events.length
      s.send(text)
      await until(() => events.slice(start).some((e) => e.type === 'done'), `${provider}: ${text}`)
      const run = logged().slice(calls)
      assert.equal(
        run.length,
        1,
        `${provider} ran the turn: ${JSON.stringify(events.slice(start))}`
      )
      assert.ok(!run[0].crash, run[0].crash)
      assert.ok(
        !events.slice(start).some((e) => e.type === 'error'),
        JSON.stringify(events.slice(start))
      )
      return { ...run[0], routed: routed(from) }
    }
    return { s, turn }
  }

  /** Every listed tool is classified, reached main when it needs main, and got main's answer. */
  const everyTool = (run, provider) => {
    assert.ok(run.listed.length, `${provider} lists tools`)
    for (const name of run.listed) {
      assert.ok(
        name in CALLS,
        `${provider} exposes ${name}: add it to CALLS, and to PURE if it needs nothing from main`
      )
      assert.ok(
        PURE.has(name) || SESSION_TOOLS.includes(name),
        `${name} is neither pure nor a session tool main runs`
      )
      const text = textOf(run.results[name])
      assert.doesNotMatch(
        text,
        MISSING,
        `${provider} ${name} answered from the helper, not main: ${text}`
      )
      if (PURE.has(name)) {
        assert.ok(!run.routed.includes(name), `${provider} ${name} is pure and stays in the helper`)
        assert.notEqual(run.results[name].isError, true, `${provider} ${name}: ${text}`)
      } else
        assert.ok(
          run.routed.includes(name),
          `${provider} ${name} reached main through the owner (${run.routed})`
        )
    }
  }

  // --- Claude: every in-process tool --------------------------------------------------------
  const claude = await chat('claude')
  const all = await claude.turn('call every tool')
  everyTool(all, 'claude')
  assert.deepEqual(
    [...all.listed].sort(),
    Object.keys(CALLS)
      .filter((n) => !['workspace_state', 'prepare_conflict_resolution'].includes(n))
      .sort()
  )
  // Main's real answers.
  const made = JSON.parse(all.results.chat_island.content[0].text)
  assert.ok(made.id, `chat_island created an island: ${textOf(made)}`)
  assert.notEqual(all.results.chat_island.isError, true)
  assert.match(textOf(all.results.preview_location), /helper-route/, 'main’s preview URL')
  assert.deepEqual(all.results.preview_screenshot.content, [
    { type: 'image', data: JPEG.toString('base64'), mimeType: 'image/jpeg' }
  ])
  assert.equal(JSON.parse(all.results.open_preview.content[0].text).requested, true)
  assert.ok(
    notified.some(
      (n) =>
        n.channel === 'preview:open' && n.payload.path === '/helper-route' && n.payload.key === CHAT
    ),
    'main navigated the preview'
  )
  assert.ok(
    notified.some(
      (n) =>
        n.channel === 'source:reveal' &&
        n.payload.source === 'shadow.js:1' &&
        n.payload.key === CHAT
    ),
    'main revealed the code'
  )
  assert.equal(
    JSON.parse(all.results.project_ui_catalog.content[0].text).engine,
    'agent',
    'Gen UI is on in main'
  )
  assert.deepEqual(
    installs.map((i) => [i.packId, i.scope, i.liveRoot]),
    [[SKILL_PACKS[0].id, 'project', WT]]
  )
  assert.match(textOf(all.results.install_skills), /\(main\)/)

  // The island lives in main's service, renders from there and its controls round-trip.
  const shown = () =>
    islands
      .attachments(CHAT)
      .map((a) => a.view)
      .find((v) => v.id === made.id)
  assert.ok(shown(), 'the island is attached to the chat')
  assert.equal(shown().title, 'Light')
  await islands.settle(CHAT, true)
  assert.equal(shown().status, 'ready')
  await islands.interact({
    chat: CHAT,
    id: made.id,
    revision: shown().revision,
    sourceRevision: shown().sourceRevision,
    operation: crypto.randomUUID(),
    action: 'commit',
    values: { x: 0.25, y: 0.75 }
  })
  assert.match(readFileSync(join(WT, 'shadow.js'), 'utf8'), /LIGHT_X = 0.25;\nconst LIGHT_Y = 0.75/)
  await islands.interact({
    chat: CHAT,
    id: made.id,
    revision: shown().revision,
    sourceRevision: shown().sourceRevision,
    operation: crypto.randomUUID(),
    action: 'undo',
    values: {}
  })
  assert.equal(readFileSync(join(WT, 'shadow.js'), 'utf8'), CODE)
  assert.deepEqual(
    shown().fields.map((f) => f.value),
    [0, -0.5],
    'the view shows the source again'
  )

  // --- grant: a background session's foreground-only tools are refused by the owner --------
  const navigations = () => notified.filter((n) => n.channel !== 'agent:event').length
  const before = islands.sessions.get(CHAT).records.length,
    shownBefore = navigations()
  const background = await chat('claude', { sessionId: 'spawn-1' })
  const refused = await background.turn('only chat_island,open_code,open_preview')
  assert.match(textOf(refused.results.chat_island), /Background edits cannot create chat islands/)
  assert.equal(refused.results.chat_island.isError, true)
  assert.match(
    textOf(refused.results.open_code),
    /Background edits cannot navigate the user editor/
  )
  assert.ok(
    !refused.routed.includes('chat_island') && !refused.routed.includes('open_code'),
    `the owner refused before main: ${refused.routed}`
  )
  // Granted to a background session, and main applies its scope: no navigation.
  assert.deepEqual(refused.routed, ['open_preview'])
  assert.match(
    textOf(refused.results.open_preview),
    /Background edits cannot navigate the user preview/
  )
  assert.equal(islands.sessions.get(CHAT).records.length, before, 'no island was created')
  assert.equal(navigations(), shownBefore, 'nothing was navigated')

  // --- Codex: every Trezi MCP bridge tool -----------------------------------------------------
  // The adapter's bridge check (`verifyTreziMcp`, while the helper is still opening) and
  // the stand-in's calls both go to main.
  const opened = fixture.events.length
  const codex = await chat('codex')
  assert.deepEqual(
    routed(opened),
    ['workspace_state'],
    'Codex checked its bridge against main while opening'
  )
  const bridged = await codex.turn('call every tool')
  everyTool(bridged, 'codex')
  assert.deepEqual(
    [...bridged.listed].sort(),
    [...SESSION_TOOLS].filter((n) => n !== 'install_skills').sort()
  )
  const bridgedIsland = JSON.parse(bridged.results.chat_island.content[0].text)
  assert.ok(
    bridgedIsland.id || /in progress|busy/.test(bridgedIsland.error ?? ''),
    textOf(bridgedIsland)
  )
  assert.match(textOf(bridged.results.preview_location), /helper-route/)
  assert.match(textOf(bridged.results.workspace_state), /live folder/)
  console.log(
    'PROVIDER-HELPER-TOOLS OK — Claude and Codex helper sessions reach every Trezi tool in main, under the owner’s grant'
  )
} finally {
  for (const s of sessions) s.shutdown()
  await fixture?.stop().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
