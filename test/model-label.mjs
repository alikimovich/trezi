/**
 * LKM-164: the chat shows the model a session runs, not just the alias it asked for.
 * The Claude SDK's init message names the resolved model (`claude-opus-5-5`); the
 * backend emits it as a `model` event, and the composer's Model picker labels the
 * selected choice with it.
 *
 * Run with: bun run test:model-label
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { snapshot } from '../src/native/chat-snapshot.ts'
import { newChat, reduce } from '../src/native/chat-state.ts'
import { pickerLabel, resolvedModelLabel } from '../src/shared/model-label.ts'

for (const [id, label] of [
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-fable-5-1', 'Fable 5.1'],
  ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
  ['claude-sonnet-4-6', 'Sonnet 4.6'],
  ['claude-opus-4-8', 'Opus 4.8'],
  ['claude-fable-5-1[1m]', 'Fable 5.1 (1M)'],
  ['claude-opus-5', 'Opus 5'],
  ['claude-3-5-sonnet-20241022', 'Sonnet 3.5'],
  // Not a Claude id, or one this does not understand: shown as given.
  ['gpt-6-sol', 'gpt-6-sol'],
  ['claude-opus-next-preview', 'claude-opus-next-preview'],
  ['claude-', 'claude-'],
  [' claude-opus-5-5 ', 'Opus 5.5']
])
  assert.equal(resolvedModelLabel(id), label, id)

assert.equal(pickerLabel('Opus'), 'Opus', 'nothing resolved yet: the choice')
assert.equal(pickerLabel('Opus', 'claude-opus-5-5'), 'Opus 5.5', 'an alias shows its version')
assert.equal(pickerLabel('Default', 'claude-opus-5-5'), 'Default · Opus 5.5')
assert.equal(pickerLabel('Opus 5.5', 'claude-opus-5-5'), 'Opus 5.5', 'already named')
assert.equal(
  pickerLabel('Claude Opus 5.5 (latest)', 'claude-opus-5-5'),
  'Claude Opus 5.5 (latest)',
  'a label that contains it is kept'
)
assert.equal(pickerLabel('Sonnet', 'claude-opus-5-5'), 'Sonnet · Opus 5.5', 'a mismatch shows both')

// The chat: the init's model reaches the picker's selected row, and only that row.
const choices = [
  {
    value: 'claude:default',
    modelId: 'default',
    label: 'Default',
    provider: 'claude',
    group: 'Claude'
  },
  { value: 'claude:opus', modelId: 'opus', label: 'Opus', provider: 'claude', group: 'Claude' },
  {
    value: 'claude:sonnet',
    modelId: 'sonnet',
    label: 'Sonnet',
    provider: 'claude',
    group: 'Claude'
  }
]
const chat = newChat('chat-a')
chat.ready = true
chat.settings = { ...chat.settings, provider: 'claude', model: 'claude:opus', modelId: 'opus' }
const picker = () => snapshot(chat, choices).composer.choices.find((c) => c.label === 'Model')
assert.equal(picker().value, 'claude:opus')
assert.deepEqual(
  picker().options.map((o) => o.label),
  ['Default', 'Opus', 'Sonnet'],
  'before the session reports'
)
const version = chat.version
reduce(chat, { type: 'model', model: 'claude-opus-5-5' })
assert.equal(chat.resolvedModel, 'claude-opus-5-5')
assert.ok(chat.version > version, 'the event refreshes the chat')
assert.deepEqual(
  picker().options.map((o) => o.label),
  ['Default', 'Opus 5.5', 'Sonnet']
)
assert.equal(chat.messages.length, 0, 'not transcript content')
chat.settings = { ...chat.settings, model: 'claude:default', modelId: 'default' }
assert.deepEqual(
  picker().options.map((o) => o.label),
  ['Default · Opus 5.5', 'Opus', 'Sonnet']
)

// Switching model forgets the old answer before the restarted session reports.
const controller = readFileSync(
  new URL('../src/native/chat-controller.ts', import.meta.url),
  'utf8'
)
assert.match(
  controller,
  /async changeModel[\s\S]*?chat\.switching = true\s+[^\n]*\n\s+chat\.resolvedModel = undefined/,
  'changeModel clears the resolved model'
)
// The service relays the event (bounded) and it does not count as turn output.
const frames = readFileSync(new URL('../src/service/ProviderFrames.swift', import.meta.url), 'utf8')
assert.match(frames, /"model": \["model"\]/, 'the provider owner relays `model` events')
assert.match(frames, /\["commands", "progress", "model"\]/, 'and does not treat them as output')
// The Claude backend emits it from the SDK's init message.
const claude = readFileSync(new URL('../src/main/backends/claude.ts', import.meta.url), 'utf8')
assert.match(claude, /emit\(\{ type: 'model', model \}\)/)

console.log(
  'MODEL-LABEL OK — resolved Claude ids read as "Opus 5.5", picker labels the selected row'
)
