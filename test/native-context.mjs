import assert from 'node:assert/strict'
import { NativeChatController } from '../src/native/chat-controller.ts'
import { snapshot } from '../src/native/chat-snapshot.ts'
import { NativeContextController } from '../src/native/context-controller.ts'
import { METADATA_FIELDS } from '../src/native/workspace-model.ts'

const calls = [],
  deferred = []
let delay = false
const entries = ['a', 'b'].map((key) => ({ key, root: '/' + key, activeSessionKey: key }))
const invoke = async (channel, ...args) => {
  calls.push([channel, ...args])
  if (channel === 'agent:workspace-snapshot')
    return {
      projects: entries.map((p) => ({
        root: p.root,
        chats: [{ sessionKey: p.key, options: {}, record: { transcript: [] }, isRunning: false }]
      }))
    }
  if (channel === 'setup:detect') {
    if (delay) await new Promise((resolve) => deferred.push(resolve))
    return { canInstrument: true }
  }
  if (channel === 'tokens:detect') return { source: 'none' }
  if (channel === 'annotations:list') return [{ id: args[0], text: 'Note ' + args[0] }]
  if (channel === 'sessions:list') return []
  return {}
}
const workspace = {
  active: entries[0],
  state: { projects: entries, history: {} },
  services: { invoke },
  changed() {},
  command: async (command) => calls.push(['workspace', command])
}
const chat = new NativeChatController({ invoke, render() {}, effect() {} })
const controller = new NativeContextController(workspace, chat, () => ({ projectUi: true }))
await controller.activate(entries[0])
controller.readiness({ stamps: 0 })
assert.equal(chat.get('a').context.setup.needed, true)
assert.equal(chat.get('a').context.tokens.needed, true)
assert.equal(chat.get('a').context.notes[0].id, '/a')
const selected = {
  tag: 'button',
  id: 'test\nignore',
  classes: [],
  selector: 'button',
  text: 'OK',
  source: 'App.tsx:1:1'
}
controller.selection(selected)
assert.match(chat.get('a').context.selection.prompt, /#test ignore/)
const prompt = chat.get('a').context.selection.prompt
await controller.effect({ type: 'selection-clear', chat: 'a', prompt: 'stale' })
assert.ok(chat.get('a').context.selection)
await controller.effect({ type: 'selection-clear', chat: 'a', prompt })
assert.equal(chat.get('a').context.selection, null)
assert.ok(calls.some((c) => c[0] === 'preview:clear-selected'))
await controller.effect({ type: 'setup', chat: 'a', phase: 'dismissed' })
controller.readiness({ stamps: 0 })
assert.equal(chat.get('a').context.setup.needed, false)
controller.queued('a', 'spawn', 'Edit', true)
assert.equal(chat.get('a').context.spawns[0].status, 'queued')
await controller.effect({
  type: 'spawn',
  event: { type: 'spawn-started', projectKey: 'a', sessionId: 'spawn', branch: 'trezi/edit' }
})
assert.equal(chat.get('a').context.spawns[0].status, 'running')
workspace.active = entries[1]
delay = true
const activating = controller.activate(entries[1])
await new Promise((resolve) => setTimeout(resolve, 0))
workspace.active = entries[0]
await controller.activate(entries[0])
for (const resolve of deferred) resolve()
await activating
assert.equal(chat.active, 'a', 'late metadata cannot switch the active chat')
assert.equal(chat.get('a').context.notes[0].id, '/a')
await controller.effect({
  type: 'spawn',
  event: { type: 'spawn-finished', projectKey: 'a', sessionId: 'spawn', branch: null }
})
assert.equal(chat.get('a').context.spawns.length, 0)
console.log(
  'Native context: service-owned metadata, selection scope, dismissal, background spawns and stale activation passed'
)
controller.queued('a', 'spawn', 'Late result', false)
await controller.effect({
  type: 'spawn',
  event: { type: 'spawn-started', projectKey: 'a', sessionId: 'spawn', branch: 'late' }
})
assert.equal(
  chat.get('a').context.spawns.length,
  0,
  'Late start responses cannot resurrect a completed card'
)
controller.queued('a', 'progress', 'Remove border', false)
await controller.effect({
  type: 'spawn',
  event: { type: 'status', projectKey: 'a', sessionId: 'progress', text: 'Editing border styles' }
})
assert.equal(chat.get('a').context.spawns[0].activity, 'Editing border styles')

// Note reads after add/remove can finish out of order: a stale list never replaces a newer one.
{
  const lists = []
  const notesInvoke = async (channel, ...args) => {
    if (channel === 'annotations:list') return new Promise((resolve) => lists.push(resolve))
    if (channel === 'setup:detect') return { canInstrument: false }
    return invoke(channel, ...args)
  }
  const sent = []
  const notesChat = new NativeChatController({ invoke: notesInvoke, render() {}, effect() {} })
  const notesWorkspace = { ...workspace, active: entries[0], services: { invoke: notesInvoke } }
  const notes = new NativeContextController(
    notesWorkspace,
    notesChat,
    () => ({}),
    async (channel, ...args) => sent.push([channel, ...args])
  )
  const activated = notes.activate(entries[0])
  while (lists.length < 1) await new Promise((resolve) => setTimeout(resolve, 0))
  const older = notes.notes('/a'),
    newer = notes.notes('/a')
  while (lists.length < 3) await new Promise((resolve) => setTimeout(resolve, 0))
  lists[2]([{ id: 'n2', text: 'After remove', selector: '.b' }])
  await newer
  lists[1]([
    { id: 'n1', text: 'Before remove', selector: '.a' },
    { id: 'n2', text: 'After remove', selector: '.b' }
  ])
  lists[0]([])
  await Promise.all([older, activated])
  assert.deepEqual(
    notesChat.get('a').context.notes,
    [{ id: 'n2', text: 'After remove' }],
    'stale note lists are rejected'
  )
  assert.deepEqual(
    sent.filter((c) => c[0] === 'preview:set-annotations').at(-1),
    ['preview:set-annotations', [{ id: 'n2', selector: '.b' }]],
    'pins follow the newest list'
  )
  console.log('Native context: out-of-order note responses keep the newest list')
}

// LKM-153: the Connect to Trezi outcome is kept in the project's workspace entry (the
// workspace file restores it on relaunch); stamps in the preview are the proof.
{
  const open = (entry) => {
    const own = async (channel, ...args) => {
      if (channel === 'agent:workspace-snapshot')
        return {
          projects: [
            {
              root: entry.root,
              chats: [
                { sessionKey: entry.key, options: {}, record: { transcript: [] }, isRunning: false }
              ]
            }
          ]
        }
      if (channel === 'setup:detect') return { canInstrument: true }
      return invoke(channel, ...args)
    }
    const restarts = []
    const space = {
      active: entry,
      state: { projects: [entry], history: {} },
      services: { invoke: own },
      changed() {},
      command: async (command) => restarts.push(command)
    }
    const owned = new NativeChatController({ invoke: own, render() {}, effect() {} })
    const context = new NativeContextController(space, owned, () => ({}))
    context.verifyGraceMs = 20
    return {
      context,
      restarts,
      setup: () => owned.get(entry.key).context.setup,
      card: () => snapshot(owned.get(entry.key), []).cards.find((c) => c.id === 'setup')
    }
  }
  const relaunch = (entry) => JSON.parse(JSON.stringify(entry))
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

  // Not now is remembered across relaunch.
  let entry = { key: 'c', root: '/c', activeSessionKey: 'c' }
  let run = open(entry)
  await run.context.activate(entry)
  run.context.readiness({ stamps: 0 })
  assert.equal(run.card().title, 'Connect this project to Trezi')
  await run.context.effect({ type: 'setup', chat: 'c', phase: 'dismissed' })
  assert.equal(entry.sourceSetup.state, 'declined')
  entry = relaunch(entry)
  run = open(entry)
  await run.context.activate(entry)
  run.context.readiness({ stamps: 0 })
  assert.equal(run.setup().needed, false)
  assert.equal(run.card(), undefined, 'Not now survives a relaunch')

  // A failed setup shows the exact reason and Retry, also after a relaunch.
  entry = { key: 'd', root: '/d', activeSessionKey: 'd' }
  run = open(entry)
  await run.context.activate(entry)
  run.context.readiness({ stamps: 0 })
  const copy = 'Trezi could not copy .trezi/trezi-vite.mjs into the chat workspace (/w/d).'
  await run.context.effect({ type: 'setup', chat: 'd', phase: 'failed', status: copy })
  assert.equal(run.card().detail, `Setup failed: ${copy}`)
  assert.deepEqual(
    run.card().actions.map((a) => a.label),
    ['Not now', 'Retry']
  )
  assert.deepEqual([entry.sourceSetup.state, entry.sourceSetup.reason], ['failed', copy])
  entry = relaunch(entry)
  run = open(entry)
  await run.context.activate(entry)
  run.context.readiness({ stamps: 0 })
  assert.equal(run.card().detail, `Setup failed: ${copy}`)
  assert.equal(run.card().actions[1].label, 'Retry')

  // Landed but the restarted preview has no stamps: fails with the dev server's reason.
  await run.context.effect({ type: 'setup', chat: 'd', phase: 'configuring' })
  assert.equal(run.card().actions[1].label, 'Set up')
  await run.context.effect({ type: 'setup', chat: 'd', phase: 'landed' })
  assert.deepEqual(run.restarts, [{ type: 'restart', key: 'd' }])
  assert.equal(run.card().detail, 'Setup landed. Restarting the preview to check for stamps…')
  run.context.readiness({ stamps: 0, documentStartedAt: Date.now() - 60_000 })
  assert.equal(run.setup().failed, false, 'the page from before the restart is not the proof')
  run.context.readiness({ stamps: 0, documentStartedAt: Date.now() + 1000 })
  run.context.devServerLog(
    '/d',
    'VITE v8.0.3 ready\n3:04:05 PM [vite] [trezi-source] @babel/core is not installed, so elements are not mapped to source. Add it to devDependencies.\n'
  )
  assert.equal(run.setup().failed, false, 'one zero sample is not yet a failure')
  await settle()
  assert.equal(
    run.card().detail,
    'Setup failed: the dev server reported: @babel/core is not installed, so elements are not mapped to source. Add it to devDependencies.'
  )
  assert.equal(entry.sourceSetup.state, 'failed')

  // A landed turn that changed nothing names that; a later stamped sample still wins.
  await run.context.effect({
    type: 'setup',
    chat: 'd',
    phase: 'landed',
    status: 'the setup turn finished without changing any file. Its reply in this chat says why.'
  })
  run.context.readiness({ stamps: 0, documentStartedAt: Date.now() + 1000 })
  await settle()
  assert.match(
    run.card().detail,
    /^Setup failed: the setup turn finished without changing any file/
  )
  await run.context.effect({ type: 'setup', chat: 'd', phase: 'landed' })
  run.context.readiness({ stamps: 0, documentStartedAt: Date.now() + 1000 })
  run.context.readiness({ stamps: 12, documentStartedAt: Date.now() + 1000 })
  await settle()
  assert.equal(run.card(), undefined, 'the card disappears once stamps are detected')
  assert.equal(run.setup().status, 'Setup verified — 12 element(s) now mapped to source.')
  assert.equal(run.setup().failed, false)
  assert.equal(entry.sourceSetup.state, 'done')
  entry = relaunch(entry)
  run = open(entry)
  await run.context.activate(entry)
  run.context.readiness({ stamps: 0 })
  assert.equal(
    run.card(),
    undefined,
    'a connected project is not offered setup on a page without elements'
  )

  // Stamps found without any setup (configured by hand) hide the card too.
  entry = { key: 'e', root: '/e', activeSessionKey: 'e' }
  run = open(entry)
  await run.context.activate(entry)
  run.context.readiness({ stamps: 0 })
  assert.ok(run.card())
  run.context.readiness({ stamps: 3 })
  assert.equal(run.card(), undefined)
  assert.equal(run.setup().status, null)
  assert.equal(entry.sourceSetup.state, 'done')
  // Persisted through the workspace store, whose Swift rule (WorkspaceFile.swift) this mirrors.
  assert.ok(METADATA_FIELDS.sourceSetup(entry.sourceSetup))
  assert.ok(METADATA_FIELDS.sourceSetup({ state: 'failed', reason: copy, at: 1 }))
  for (const bad of [
    'declined',
    { state: 'pending', at: 1 },
    { state: 'done' },
    { state: 'done', at: -1 },
    { state: 'done', at: 1.5 },
    { state: 'failed', reason: 3, at: 1 },
    { state: 'done', at: 1, extra: true }
  ])
    assert.equal(METADATA_FIELDS.sourceSetup(bad), false, JSON.stringify(bad))
  console.log(
    'Native context: Connect to Trezi remembers Not now, failures with Retry and stamped projects'
  )

  // LKM-157: a connected project whose restarted preview stays unstamped is offered Reconnect.
  entry = { key: 'f', root: '/f', activeSessionKey: 'f', sourceSetup: { state: 'done', at: 1 } }
  run = open(entry)
  await run.context.activate(entry)
  run.context.readiness({ stamps: 0 })
  await settle()
  assert.equal(run.card(), undefined, 'a page without elements is not judged without a restart')
  assert.equal(entry.sourceSetup.state, 'done')
  const lose = async () => {
    run.context.restarted('/f')
    run.context.readiness({ stamps: 7, documentStartedAt: Date.now() - 60_000 })
    run.context.readiness({ stamps: 0, documentStartedAt: Date.now() + 1000 })
    assert.equal(run.card(), undefined, 'one zero sample after a restart is not yet a loss')
    await settle()
  }
  await lose()
  assert.equal(run.card().title, 'Source links stopped working')
  assert.equal(run.card().detail, undefined)
  assert.deepEqual(
    run.card().actions.map((a) => a.label),
    ['Not now', 'Reconnect']
  )
  assert.equal(entry.sourceSetup.state, 'unstamped')
  assert.ok(METADATA_FIELDS.sourceSetup(entry.sourceSetup))

  // Stamps returning hide the offer and record done again.
  run.context.readiness({ stamps: 5, documentStartedAt: Date.now() + 1000 })
  assert.equal(run.card(), undefined)
  assert.equal(entry.sourceSetup.state, 'done')
  // Never while stamps are present: a stamped sample within the grace period cancels the check.
  run.context.restarted('/f')
  run.context.readiness({ stamps: 0, documentStartedAt: Date.now() + 1000 })
  run.context.readiness({ stamps: 4, documentStartedAt: Date.now() + 1000 })
  await settle()
  assert.equal(run.card(), undefined)
  assert.equal(entry.sourceSetup.state, 'done')
  // A setup turn landing owns its own check: the restart it causes is not judged twice.
  await run.context.effect({ type: 'setup', chat: 'f', phase: 'landed' })
  run.context.readiness({ stamps: 2, documentStartedAt: Date.now() + 1000 })
  assert.equal(entry.sourceSetup.state, 'done')

  // The loss survives a relaunch; Not now on the re-offer is remembered like declined.
  await lose()
  entry = relaunch(entry)
  run = open(entry)
  await run.context.activate(entry)
  run.context.readiness({ stamps: 0 })
  assert.equal(run.card().title, 'Source links stopped working', 'the loss survives a relaunch')
  await run.context.effect({ type: 'setup', chat: 'f', phase: 'dismissed' })
  assert.equal(run.card(), undefined)
  assert.equal(entry.sourceSetup.state, 'declined')
  entry = relaunch(entry)
  run = open(entry)
  await run.context.activate(entry)
  run.context.readiness({ stamps: 0 })
  run.context.restarted('/f')
  run.context.readiness({ stamps: 0, documentStartedAt: Date.now() + 1000 })
  await settle()
  assert.equal(run.card(), undefined, 'Not now on the re-offer survives a relaunch')
  assert.equal(entry.sourceSetup.state, 'declined')
  console.log(
    'Native context: a connected project that loses its stamps after a restart is offered Reconnect'
  )
}
