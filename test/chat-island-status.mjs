import './helpers/with-service-owners.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IslandBindingError, islandProblem } from '../src/main/chat-island-bindings.ts'
import { cloneDefinition, referencedIslands } from '../src/main/chat-island-context.ts'
import { ChatIslands, chatIslandContext, installChatIslands } from '../src/main/chat-islands.ts'
import {
  addReference,
  menuItems,
  setIslandDirectory,
  withReferences
} from '../src/native/chat-island-refs.ts'

// LKM-181: islands the code no longer supports are disabled (per field or whole), the user
// can disable/hide them across restarts, and a referenced island reaches the agent.
const root = await mkdtemp(join(tmpdir(), 'trezi-island-status-'))
const file = join(root, 'shadow.js')
const code = (tint = "'#336699'", y = '-0.5') =>
  `const LIGHT_X = 0;\nconst LIGHT_Y = ${y};\nconst SOFTNESS = 20;\nconst TINT = ${tint};\n`
const number = (id, anchor, min = -1, max = 1) => ({
  id,
  label: id === 'blur' ? 'Softness' : id,
  kind: 'number',
  min,
  max,
  step: 0.01,
  apply: { strategy: 'literal', anchor }
})
const request = {
  action: 'define',
  engine: 'agent',
  manifest: {
    file: 'shadow.js',
    component: 'Card',
    title: 'Shadow lighting',
    params: [
      number('x', 'const LIGHT_X = '),
      number('y', 'const LIGHT_Y = '),
      number('blur', 'const SOFTNESS = ', 0, 100),
      {
        id: 'tint',
        label: 'Tint',
        kind: 'color',
        apply: { strategy: 'literal', anchor: 'const TINT = ' }
      }
    ]
  },
  blocks: [
    { id: 'light', title: 'Light position', kind: 'point', params: ['x', 'y'] },
    { id: 'look', title: 'Softness and tint', kind: 'group', params: ['blur', 'tint'] }
  ]
}
const RAW = /Error\b|\bat \S+ \(|ENOENT|undefined|\/Users\/|\/tmp\//
let turn = 1
const islands = new ChatIslands(() => {})
installChatIslands(islands)
const view = (key, id) => islands.sessions.get(key).views.get(id)
try {
  await writeFile(file, code())
  islands.register('chat', root, 'status-record', () => turn)
  const made = await islands.tool('chat', root, request)
  assert.ok(made.id, JSON.stringify(made))
  assert.equal(made.name, '#island-shadow-1', 'A stable short name')
  await islands.settle('chat', true)
  assert.equal(view('chat', made.id).status, 'ready')
  assert.equal(view('chat', made.id).name, '#island-shadow-1')

  // A literal replaced by a token disables only that field, with a reason.
  await writeFile(file, code("'var(--brand)'"))
  await islands.refresh('chat')
  const partial = view('chat', made.id)
  assert.equal(partial.status, 'partially-disabled')
  const tint = partial.fields.find((f) => f.id === 'tint')
  assert.match(tint.disabled, /Tint is now set by the token --brand; this control can't edit it\./)
  assert.equal(partial.fields.find((f) => f.id === 'blur').disabled, undefined)
  assert.equal(partial.fields.find((f) => f.id === 'x').value, 0)
  const commit = (id, values) => ({
    chat: 'chat',
    id,
    revision: view('chat', id).revision,
    sourceRevision: view('chat', id).sourceRevision,
    action: 'commit',
    values
  })
  await assert.rejects(islands.interact(commit(made.id, { tint: '#ff0000' })), (error) => {
    assert.ok(error instanceof IslandBindingError)
    assert.match(error.message, /token --brand/)
    return true
  })
  await islands.interact(commit(made.id, { blur: 30 }))
  assert.equal(view('chat', made.id).fields.find((f) => f.id === 'blur').value, 30)
  const stored = islands.sessions.get('chat').records.find((r) => r.id === made.id)
  assert.equal(stored.health, 'partially-disabled', 'The status persists with the record')
  assert.match(stored.reasons.tint, /--brand/)

  // A referenced island sends the agent its definition, bindings, values and status.
  const context = await chatIslandContext('chat', 'Make #island-shadow-1 softer')
  assert.deepEqual(referencedIslands('Make #island-shadow-1 softer'), ['island-shadow-1'])
  const referenced = JSON.parse(context.split('\n')[4])
  assert.equal(referenced[0].name, '#island-shadow-1')
  assert.equal(referenced[0].title, 'Shadow lighting')
  assert.equal(referenced[0].file, 'shadow.js')
  assert.equal(referenced[0].status, 'partially-disabled')
  const tintParam = referenced[0].params.find((p) => p.id === 'tint')
  assert.equal(tintParam.anchor, 'const TINT = ')
  assert.match(tintParam.disabled, /--brand/)
  assert.equal(referenced[0].params.find((p) => p.id === 'blur').value, 30)
  assert.doesNotMatch(await chatIslandContext('chat', 'no reference'), /referenced in this message/)

  // A deleted element disables the whole island; it writes nothing and says why in one line.
  await writeFile(file, 'export const Card = () => null\n')
  await islands.refresh('chat')
  const gone = view('chat', made.id)
  assert.equal(gone.status, 'disabled')
  assert.equal(gone.disabledBy, 'code')
  assert.equal(gone.reason, 'The code these controls edited is no longer in shadow.js.')
  assert.doesNotMatch(gone.reason, RAW)
  for (const field of gone.fields) assert.doesNotMatch(field.disabled, RAW)
  await assert.rejects(islands.interact(commit(made.id, { blur: 10 })))

  // Clone needs rebinding while a binding is broken; with rebind it makes a new island.
  await writeFile(
    file,
    'const LIGHT = { x: 0.25, y: -0.5 };\nconst BLUR_PX = 12;\nconst ACCENT = "#112233";\n'
  )
  turn = 2
  assert.match((await islands.tool('chat', root, { action: 'clone', id: made.id })).error, /rebind/)
  const cloned = await islands.tool('chat', root, {
    action: 'clone',
    id: '#island-shadow-1',
    rebind: {
      params: [
        { id: 'x', anchor: 'LIGHT = { x: ' },
        { id: 'y', anchor: ', y: ' },
        { id: 'blur', anchor: 'const BLUR_PX = ' },
        { id: 'tint', anchor: 'const ACCENT = ' }
      ]
    }
  })
  assert.ok(cloned.id, JSON.stringify(cloned))
  assert.notEqual(cloned.id, made.id)
  assert.equal(cloned.name, '#island-shadow-2')
  await islands.settle('chat', true)
  const copy = view('chat', cloned.id)
  assert.equal(copy.status, 'ready')
  assert.deepEqual(Object.fromEntries(copy.fields.map((f) => [f.id, f.value])), {
    x: 0.25,
    y: -0.5,
    blur: 12,
    tint: '#112233'
  })
  assert.equal(view('chat', made.id).status, 'disabled', 'The original stays as it was')
  assert.throws(
    () =>
      cloneDefinition(islands.sessions.get('chat').records[0], {
        params: [{ id: 'nope', anchor: 'x' }]
      }),
    /not a param/
  )

  // The user disables one island and hides another; both survive a restart.
  await islands.interact({ chat: 'chat', id: cloned.id, action: 'disable' })
  assert.equal(view('chat', cloned.id).status, 'disabled')
  assert.equal(view('chat', cloned.id).disabledBy, 'user')
  await assert.rejects(islands.interact(commit(cloned.id, { blur: 20 })), /disabled/)
  await islands.interact({ chat: 'chat', id: made.id, action: 'hide' })
  assert.equal(view('chat', made.id).status, 'hidden')
  islands.close('chat')
  const restarted = new ChatIslands(() => {})
  restarted.register('again', root, 'status-record', () => 2)
  await restarted.refresh('again')
  const after = (id) => restarted.sessions.get('again').views.get(id)
  assert.equal(after(cloned.id).status, 'disabled')
  assert.equal(after(cloned.id).disabledBy, 'user')
  assert.equal(after(made.id).status, 'hidden')
  assert.equal(after(made.id).name, '#island-shadow-1', 'Names persist')
  // Enable re-validates; Show all hidden brings the hidden one back (still disabled by code).
  await restarted.interact({ chat: 'again', id: cloned.id, action: 'enable' })
  assert.equal(after(cloned.id).status, 'ready')
  await restarted.interact({ chat: 'again', id: '', action: 'show-hidden' })
  assert.equal(after(made.id).status, 'disabled')
  assert.equal(after(made.id).disabledBy, 'code')

  // show {id} resurfaces the same island at the end of the chat.
  const shown = await restarted.tool('again', root, { action: 'show', id: '#island-shadow-2' })
  assert.equal(shown.id, cloned.id)
  assert.equal(shown.status, 'ready')
  const attachment = restarted.attachments('again').find((a) => a.view.id === cloned.id)
  assert.equal(attachment.turn, 2)
  restarted.close('again')

  // UI errors are one plain line, never exception text.
  assert.equal(islandProblem(new IslandBindingError('Tint is gone.')), 'Tint is gone.')
  assert.equal(
    islandProblem(new Error('Island changed. Reload its controls.')),
    'Island changed. Reload its controls.'
  )
  for (const raw of [
    new Error("ENOENT: no such file or directory, open '/Users/x/shadow.js'"),
    new TypeError("Cannot read properties of undefined (reading 'id')"),
    new Error('SyntaxError: Unexpected token\n    at parse (file.js:1:2)'),
    'lowercase internal detail'
  ])
    assert.equal(islandProblem(raw), 'This island could not do that. Reload it and try again.')

  // The composer: "#" lists the chat's islands; a reference chip is sent with the message.
  setIslandDirectory(() => [
    { id: made.id, name: '#island-shadow-1', title: 'Shadow lighting', status: 'disabled' },
    { id: cloned.id, name: '#island-shadow-2', title: 'Shadow lighting', status: 'ready' }
  ])
  const chat = {
    chat: 'chat',
    text: 'tune #island-shadow-2',
    caret: 21,
    commands: [],
    dismissed: false
  }
  const items = menuItems(chat)
  assert.deepEqual(
    items.map((i) => [i.title, i.description]),
    [['#island-shadow-2', 'Shadow lighting · ready']]
  )
  assert.equal(items[0].start, 5)
  chat.caret = chat.text.length
  addReference(chat, '#island-shadow-1')
  addReference(chat, '#island-shadow-1')
  addReference(chat, 'not a name')
  assert.deepEqual(chat.references, ['#island-shadow-1'])
  assert.equal(withReferences(chat, 'make it softer'), '#island-shadow-1 make it softer')
  assert.deepEqual(chat.references, [])
  addReference(chat, '#island-shadow-1')
  assert.equal(withReferences(chat, 'fix #island-shadow-1'), 'fix #island-shadow-1')
  console.log(
    'CHAT-ISLAND-STATUS OK — partial/whole disable, persisted user state, references, show and clone'
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
