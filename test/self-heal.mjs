import assert from 'node:assert/strict'
import { classifyError, incidentDetail } from '../src/main/self-heal/catalog.ts'
import { newChat, reduce } from '../src/native/chat-state.ts'

const routing = 'Reconnecting... 5/5 (workspace routing discovery failed)'
const terminal =
  'Codex Exec exited with code 1: Reading prompt from stdin... ERROR codex_models_manager::manager: failed to refresh available models: Connection failed: error sending request — workspace routing discovery failed'
for (const text of [routing, terminal]) assert.equal(classifyError(text).class, 'provider-network')
const cases = [
  ['authentication expired', 'provider-auth'],
  ['429 Too Many Requests', 'provider-limit'],
  ['model is not available', 'model-unavailable'],
  ['provider helper crashed', 'helper-crash'],
  ['dev server stopped', 'dev-server'],
  ['bun install failed', 'dependency-install'],
  ['merge conflict', 'conflict'],
  ['landing failed', 'landing'],
  ['.git/index.lock exists', 'git-lock'],
  ['ENOSPC', 'disk-full'],
  ['stale preview', 'stale-preview'],
  ['mysterious error', 'unknown']
]
for (const [text, expected] of cases) assert.equal(classifyError(text).class, expected)
assert.doesNotMatch(incidentDetail('Authorization: Bearer abcdefgh12345678'), /abcdefgh12345678/)

const chat = newChat('self-heal')
chat.isRunning = true
reduce(chat, { type: 'error', message: routing })
reduce(chat, { type: 'error', message: terminal })
const rows = chat.messages.filter((message) => message.incident)
assert.equal(rows.length, 1, 'duplicate errors in a turn share one row')
assert.equal(rows[0].incident.line, 'Provider could not connect')
assert.match(rows[0].incident.detail, /Codex Exec exited/)
assert.equal(rows[0].segments.length, 0, 'raw CLI output is not transcript text')
console.log('SELF-HEAL OK — real routing errors, catalog and compact duplicate row')
