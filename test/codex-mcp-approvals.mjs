// LKM-165: Codex sessions run with approvals disabled, so every Trezi MCP tool must be
// pre-approved in the session config; an unapproved one is refused outright ("requires
// approval, but this session disables approvals"). No helper, socket or model call.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { previewToolShapes } from '../bin/preview-tool-schema.mjs'
import { treziMcpConfig } from '../src/main/backends/codex-mcp.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const config = treziMcpConfig(root, { socketPath: '/tmp/trezi-test.sock', token: 'test' })
const tools = config.mcp_servers.trezi.tools

// Every tool the helper registers, read from its source so a new tool cannot be missed.
const helper = readFileSync(join(root, 'bin/trezi-agent-mcp.mjs'), 'utf8')
const registered = new Set([
  ...[...helper.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((match) => match[1]),
  ...Object.keys(previewToolShapes)
])
for (const name of ['workspace_state', 'prepare_conflict_resolution', 'chat_island', 'open_code'])
  assert.ok(registered.has(name), `the helper registers ${name}`)
for (const name of registered)
  assert.deepEqual(tools[name], { approval_mode: 'approve' }, `Codex pre-approves ${name}`)
assert.deepEqual(
  Object.keys(tools).sort(),
  [...registered].sort(),
  'the approval list names exactly the helper tools'
)
assert.equal(config.mcp_servers.trezi.required, true)
console.log('CODEX-MCP-APPROVALS OK — every Trezi tool is pre-approved for approval-free sessions')
