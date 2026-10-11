import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chatUiComponentSchema } from '../bin/chat-ui-schema.mjs'
import { PLANNING_PROJECT, ProjectPlanning } from '../src/main/project-planning.ts'

const records = new Map()
const clone = (value) => value && structuredClone(value)
const owner = {
  save: async (record) => {
    records.set(record.id, clone(record))
  },
  remove: async (id) => {
    records.delete(id)
  }
}
const store = {
  current: (key) =>
    clone(
      [...records.values()].find(
        (record) => record.projectKey === key && record.slot === 'current'
      ) ?? null
    ),
  get: (id) => clone(records.get(id) ?? null)
}
let completions = 0,
  creates = 0,
  createFails = false,
  providerAvailable = true
let reply = JSON.stringify({
  reply: 'A React starter fits this brief.',
  plan: {
    name: 'Price Board',
    stack: 'React and Vite for a lightweight interactive page',
    template: 'react'
  }
})
const planning = new ProjectPlanning({
  owner,
  store,
  complete: async () => {
    completions++
    return providerAvailable ? reply : null
  },
  create: async (root) => {
    creates++
    return createFails ? { ok: false, error: 'Install failed' } : { ok: true, root }
  }
})
const options = { provider: 'codex', model: 'default' }
const record = await planning.start(options)
assert.equal(record.projectKey, PLANNING_PROJECT)
assert.equal(record.projectRoot, '')
assert.equal(creates, 0, 'Entering planning creates no project files')

const brief = 'Build a price comparison page with React and Vite'
const first = await planning.send(record.id, 'turn-one', brief, options, [
  {
    name: 'brief.txt',
    type: 'text/plain',
    data: Buffer.from('Compare three plans').toString('base64')
  }
])
assert.equal(completions, 1)
assert.equal(creates, 0, 'A proposed plan is not a creation request')
assert.equal(first.record.transcript[0].text, brief)
assert.equal(first.record.transcript[0].planningAttachments[0].name, 'brief.txt')
assert.match(first.record.transcript.at(-1).text, /Destination:/)
assert.equal(first.record.transcript.at(-1).ui.component.kind, 'form')
assert.equal(
  chatUiComponentSchema.safeParse(first.record.transcript.at(-1).ui.component).success,
  true
)
await planning.send(record.id, 'turn-one', brief, options)
assert.equal(completions, 1, 'A repeated turn ID does not call the provider again')

const card = first.record.transcript.at(-1).ui
const destination = join('/private/tmp', `trezi-planning-${record.id}`)
const answer = await planning.answer(record.id, card.id, {
  values: {
    name: 'Price Board',
    destination,
    stack: 'React and Vite'
  }
})
assert.equal(answer.message.includes(destination), true)
assert.equal(creates, 0, 'Answering the form only records the confirmation')
const created = await planning.send(record.id, 'turn-two', answer.message, options)
assert.equal(created.createdRoot, destination)
assert.equal(created.record.id, record.id, 'The record keeps its identity after binding')
assert.equal(created.record.projectRoot, destination)
assert.equal(creates, 1)
await planning.send(record.id, 'turn-two', answer.message, options)
assert.equal(creates, 1, 'A repeated confirmed turn cannot create twice')

records.clear()
const cancelled = await planning.start(options)
assert.equal(await planning.cancel(cancelled.id), true)
assert.equal(planning.resume(), null)
assert.equal(creates, 1)

// A vague first brief can ask one useful question. A missing stack is recommended,
// without forcing the user through a fixed technical questionnaire.
records.clear()
reply = JSON.stringify({
  reply: 'What should the app help people do?',
  choices: ['Compare plans', 'Track spending']
})
const vague = await planning.start(options)
const question = await planning.send(vague.id, 'vague-one', 'I want an app', options)
assert.equal(question.record.transcript.at(-1).ui.component.kind, 'options')
assert.equal(
  chatUiComponentSchema.safeParse(question.record.transcript.at(-1).ui.component).success,
  true
)
assert.equal(creates, 1)
reply = JSON.stringify({
  reply: 'React is a sensible fit because this needs interactive comparison.',
  plan: {
    name: 'Plan Finder',
    stack: 'React and Vite',
    template: 'react'
  }
})
const proposed = await planning.send(
  vague.id,
  'vague-two',
  'Compare plans; help me choose the stack',
  options
)
let form = proposed.record.transcript.at(-1).ui
assert.equal(form.component.kind, 'form')

// Existing destinations are refused before the workflow owner receives any write.
let picked = await planning.answer(vague.id, form.id, {
  values: {
    name: 'Plan Finder',
    destination: '/private/tmp',
    stack: 'React and Vite'
  }
})
let failed = await planning.send(vague.id, 'vague-three', picked.message, options)
assert.match(failed.error, /already exists/)
assert.equal(creates, 1)
form = failed.record.transcript.at(-1).ui
const retryPath = join('/private/tmp', `trezi-planning-retry-${vague.id}`)
picked = await planning.answer(vague.id, form.id, {
  values: {
    name: 'Plan Finder',
    destination: retryPath,
    stack: 'React and Vite'
  }
})
createFails = true
failed = await planning.send(vague.id, 'vague-four', picked.message, options)
assert.match(failed.error, /Install failed/)
assert.equal(creates, 2)
const resumed = new ProjectPlanning({
  owner,
  store,
  complete: async () => reply,
  create: async (root) => {
    creates++
    return { ok: true, root }
  }
})
assert.equal(resumed.resume().id, vague.id, 'Relaunch keeps the same planning record')
form = resumed.resume().transcript.at(-1).ui
picked = await resumed.answer(vague.id, form.id, {
  values: {
    name: 'Plan Finder',
    destination: retryPath,
    stack: 'React and Vite'
  }
})
const recovered = await resumed.send(vague.id, 'vague-five', picked.message, options)
assert.equal(recovered.createdRoot, retryPath)
assert.equal(creates, 3)

// A provider failure saves the user turn and can be followed up after sign-in.
records.clear()
providerAvailable = false
const auth = await planning.start(options)
const unavailable = await planning.send(auth.id, 'auth-one', 'Build a calendar', options)
assert.match(unavailable.error, /provider could not answer/)
assert.equal(planning.resume().transcript[0].text, 'Build a calendar')
providerAvailable = true
const afterLogin = await planning.send(auth.id, 'auth-two', 'Continue', options)
assert.equal(
  afterLogin.record.transcript.some((entry) => entry.text.includes('React')),
  true
)
console.log('project-planning: ok')
