import assert from 'node:assert/strict'
import { backgroundAgentOptions } from '../src/shared/background-model.ts'

for (const provider of [undefined, 'claude', 'codex', 'gemini']) {
  const source = Object.freeze({
    provider,
    model: 'parent-model',
    effort: 'high',
    permissionMode: 'auto'
  })
  const comment = backgroundAgentOptions(source)
  assert.equal(
    comment.model,
    provider === 'codex' ? 'gpt-6-sol' : provider === 'gemini' ? 'parent-model' : 'sonnet'
  )
  assert.equal(comment.provider, provider)
  assert.equal(comment.effort, 'high')
  assert.equal(comment.permissionMode, 'auto')
  assert.deepEqual(backgroundAgentOptions(source, 'text-edit'), source)
  assert.equal(source.model, 'parent-model', 'the parent chat must not change')
  const gateway = { ...source, connectionId: 'gateway', model: 'deepseek/custom-exact-id' }
  assert.deepEqual(backgroundAgentOptions(gateway), gateway, 'connection wins over harness')
  assert.deepEqual(
    backgroundAgentOptions(comment),
    comment,
    'renderer and main may both apply policy'
  )
}
assert.equal(backgroundAgentOptions({}).model, 'sonnet')
assert.equal(backgroundAgentOptions({ provider: 'codex' }).model, 'gpt-6-sol')
console.log(
  'BACKGROUND-MODEL OK — Sonnet, Sol, exact Gateway model, visual edits and parent settings preserved'
)
