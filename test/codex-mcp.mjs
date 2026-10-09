// Real MCP handshake + Codex inventory, with no model request or account access.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Codex } from '@openai/codex-sdk'
import {
  isolatedCodexConfig,
  personalMcpServers,
  treziMcpConfig,
  verifyTreziMcp
} from '../src/main/backends/codex-mcp.ts'
import { registerTreziAgentTools, shutdownTreziAgentTools } from '../src/main/trezi-agent-tools.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const home = await mkdtemp(join(tmpdir(), 'trezi-codex-mcp-'))
const calls = []
const registration = await registerTreziAgentTools(async (action) => {
  calls.push(action)
  return { state: 'live' }
})
let child
try {
  const config = treziMcpConfig(root, registration)
  // LKM-203: land_now / publish_* wait for the real result, past Codex's 60 s default.
  assert.equal(config.mcp_servers.trezi.tool_timeout_sec, 300)
  assert.ok(
    config.mcp_servers.trezi.tool_timeout_sec > 60 + 180 + 30,
    'covers landing, the workflow budget and the final lookups'
  )
  // The provider runs in a project/worktree, separate from Trezi's install.
  process.chdir(home)
  await verifyTreziMcp(config)
  assert.deepEqual(calls, ['workspace_state'], 'startup verifies the authenticated bridge')
  const badToken = treziMcpConfig(root, { ...registration, token: 'invalid-token' })
  await assert.rejects(verifyTreziMcp(badToken), /Trezi tools could not connect/)
  const missingHelper = treziMcpConfig(home, registration)
  await assert.rejects(verifyTreziMcp(missingHelper), /Trezi tools could not connect/)

  // The user's own ~/.codex declares MCP servers (a Vercel-style URL server and a stdio
  // one). Trezi's sessions must switch them off; only undeclared names would break.
  const env = { CODEX_HOME: home }
  // Plugins and apps bring servers from outside `mcp_servers`: always off (LKM-126).
  const features = { plugins: false, apps: false }
  const unchanged = { ...config, features }
  assert.deepEqual(isolatedCodexConfig(config, env), unchanged, 'no personal config, no servers')
  await writeFile(join(home, 'config.toml'), 'not = [valid')
  assert.deepEqual(isolatedCodexConfig(config, env), unchanged, 'an unreadable config adds nothing')
  assert.deepEqual(
    isolatedCodexConfig({ features: { plugins: true, shell_tool: true } }, env).features,
    { plugins: false, apps: false, shell_tool: true },
    "a caller's features are kept, but plugins and apps stay off"
  )
  const personal = ['vercel', 'personal-stdio']
  // An installed plugin, laid out as `codex plugin add` leaves it: its `.mcp.json`
  // server (the mcp.vercel.com one in the report) is not in `mcp_servers`.
  const plugin = join(home, 'plugins/cache/fixture/vercel/1.0.0')
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true })
  await writeFile(
    join(plugin, '.codex-plugin/plugin.json'),
    JSON.stringify({ name: 'vercel', version: '1.0.0', mcpServers: './.mcp.json' })
  )
  await writeFile(
    join(plugin, '.mcp.json'),
    JSON.stringify({
      mcpServers: { 'vercel-plugin': { type: 'http', url: 'http://127.0.0.1:9/mcp' } }
    })
  )
  await writeFile(
    join(home, 'config.toml'),
    [
      '[mcp_servers.vercel]',
      'url = "http://127.0.0.1:9/mcp"',
      '',
      '[mcp_servers.personal-stdio]',
      'command = "false"',
      '',
      '[plugins."vercel@fixture"]',
      'enabled = true',
      ''
    ].join('\n')
  )
  assert.deepEqual(personalMcpServers(env), personal)
  const isolated = isolatedCodexConfig(config, env)
  assert.deepEqual(isolated.mcp_servers, {
    vercel: { enabled: false },
    'personal-stdio': { enabled: false },
    trezi: config.mcp_servers.trezi
  })
  assert.deepEqual(isolated.features, features)

  const codexBin = new Codex().exec.executablePath
  const flatten = (value, path = '', overrides = []) => {
    for (const [key, entry] of Object.entries(value)) {
      const name = path ? `${path}.${key}` : key
      if (entry && typeof entry === 'object' && !Array.isArray(entry))
        flatten(entry, name, overrides)
      else overrides.push('-c', `${name}=${JSON.stringify(entry)}`)
    }
    return overrides
  }
  const listed = (overrides) => {
    const out = execFileSync(codexBin, [...overrides, 'mcp', 'list', '--json'], {
      cwd: home,
      env: { ...process.env, CODEX_HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return Object.fromEntries(JSON.parse(out).map((server) => [server.name, server.enabled]))
  }
  // Baseline: the CLI does load the fixture, and merely adding Trezi's server keeps it.
  const merged = listed(flatten(config))
  for (const name of personal) assert.equal(merged[name], true, `${name} loads without isolation`)
  assert.equal(merged['vercel-plugin'], true, 'the plugin server loads without isolation')
  const loaded = listed(flatten(isolated))
  for (const name of personal) assert.equal(loaded[name], false, `${name} is switched off`)
  assert.equal(loaded['vercel-plugin'], undefined, 'the plugin server is not loaded at all')
  assert.equal(loaded.trezi, true, "Trezi's server stays on")

  // Use the exact production config and SDK-selected CLI, not a substitute server.
  const overrides = flatten(isolated)
  child = spawn(codexBin, ['app-server', ...overrides], {
    cwd: home,
    env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'ignore']
  })
  let sequence = 0
  const pending = new Map()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    pending.get(message.id)?.(message)
  })
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Timeout: ${method}`))
      }, 30000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        pending.delete(id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  await request('initialize', {
    clientInfo: { name: 'trezi-test', version: '1' },
    capabilities: { experimentalApi: true }
  })
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
  const { thread } = await request('thread/start', {
    cwd: home,
    ephemeral: true,
    approvalPolicy: 'never'
  })
  const status = await request('mcpServerStatus/list', { threadId: thread.id })
  for (const name of [...personal, 'vercel-plugin']) {
    const entry = status.data.find((candidate) => candidate.name === name)
    assert.equal(entry?.runtimeStatus ?? 'disabled', 'disabled', `the session never starts ${name}`)
    assert.equal(Object.keys(entry?.tools ?? {}).length, 0, `${name} exposes no tools`)
  }
  const server = status.data.find((entry) => entry.name === 'trezi')
  assert.ok(server, 'Codex connects to the Trezi MCP server')
  assert.ok(!server.toolsError, 'Codex can list the tools')
  for (const tool of [
    'ask_user',
    'chat_island',
    'chat_ui',
    'preview_screenshot',
    'preview_location',
    'preview_inspect',
    'preview_evaluate',
    'preview_console',
    'preview_viewport',
    'preview_speed',
    'workspace_state'
  ]) {
    assert.ok(server.tools[tool], `Codex exposes ${tool}`)
  }
  assert.equal(config.mcp_servers.trezi.required, true, 'future turns cannot silently omit Trezi')
  // Read per turn: a server removed mid-chat is no longer named (naming it would fail).
  await writeFile(
    join(home, 'config.toml'),
    '[mcp_servers.vercel]\nurl = "http://127.0.0.1:9/mcp"\n'
  )
  assert.deepEqual(Object.keys(isolatedCodexConfig(config, env).mcp_servers), ['vercel', 'trezi'])
  console.log(
    'CODEX-MCP OK — real helper, socket authentication, Codex tool inventory and personal MCP servers off'
  )
} finally {
  process.chdir(root)
  child?.kill()
  registration.dispose()
  await shutdownTreziAgentTools()
  await rm(home, { recursive: true, force: true })
}
