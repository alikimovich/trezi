import './helpers/with-service-owners.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatIslandShape } from '../bin/chat-island-schema.mjs'
import { islandDefinition } from '../src/main/chat-island-schema.ts'
import { islandSource } from '../src/main/chat-island-source.ts'
import { ChatIslands, ISLAND_CONFLICT_NOTICE } from '../src/main/chat-islands.ts'
import { selectControlCandidates } from '../src/main/control-selection.ts'
import { chooseControlsWithJev } from '../src/main/controls-jev.ts'
import { previewServers } from '../src/main/preview-evidence.ts'
import { PAGE_PROBE } from '../src/main/preview-page.ts'
import { registerPreviewSource } from '../src/main/preview-state.ts'
import { enqueueRepoWrite } from '../src/main/repo-write-queue.ts'
import { confirmIslandRendered } from '../src/native/island-rendered.ts'
import {
  chatIslandControlPurposes,
  chatIslandGuidance
} from '../src/shared/chat-island-guidance.ts'
import { projectKey } from '../src/shared/projectKey.ts'

const root = await mkdtemp(join(tmpdir(), 'trezi-islands-'))
const storage = await mkdtemp(join(tmpdir(), 'trezi-island-store-'))
const code =
  'const LIGHT_X = 0;\nconst LIGHT_Y = -0.5;\nconst SOFTNESS = 20;\nconst EASE = [0.25, 0.1, 0.25, 1];\n'
const number = (id, anchor, min = -1, max = 1) => ({
  id,
  label: id,
  kind: 'number',
  min,
  max,
  step: 0.01,
  apply: { strategy: 'literal', anchor },
  ...(id === 'x'
    ? { rendered: { kind: 'computed-style', selector: '#shadow-card', property: 'opacity' } }
    : {})
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
        id: 'ease',
        label: 'Easing',
        kind: 'bezier',
        apply: { strategy: 'literal', anchor: 'const EASE = ' }
      }
    ]
  },
  blocks: [
    { id: 'light', title: 'Light position', kind: 'point', params: ['x', 'y'] },
    { id: 'layers', title: 'Softness and easing', kind: 'group', params: ['blur', 'ease'] }
  ]
}
let changes = 0
const submittedDrafts = []
let renderedDraft = false
const islands = new ChatIslands(() => changes++, undefined, {
  applyDraft: async (_chat, prompt) => {
    submittedDrafts.push(prompt)
    return `draft-turn-${submittedDrafts.length}`
  },
  confirmRendered: async () => renderedDraft
})
try {
  // Catalog guidance is available before registration and stays within the wire catalog.
  const catalog = await islands.tool('not-registered', root, { action: 'catalog' })
  assert.equal(catalog.guidance, chatIslandGuidance)
  assert.deepEqual(catalog.controlPurposes, chatIslandControlPurposes)
  assert.deepEqual(
    Object.keys(catalog.controlPurposes).sort(),
    [...catalog.fields, ...catalog.blocks].sort()
  )
  const blockKinds = chatIslandShape.blocks.unwrap().element.shape.kind.options
  assert.deepEqual(
    catalog.blocks,
    blockKinds,
    'Catalog must not advertise unrenderable block types'
  )
  // The six About-photo controls do not wait for a second model on the default path.
  const photoBlocks = [
    { id: 'pixel-area', params: ['radius', 'block-size'] },
    { id: 'trail', params: ['fringe', 'retention'] },
    { id: 'response', params: ['follow', 'expansion'] }
  ]
  for (const engine of [undefined, 'auto', 'agent']) {
    const selected = await selectControlCandidates(
      'photo',
      photoBlocks,
      { engine, prompt: 'Surface the photo hover controls' },
      async () => {
        throw new Error('The default path must not call Jev')
      }
    )
    assert.equal(selected.engine, 'agent')
    assert.deepEqual(selected.controls, photoBlocks)
    assert.equal(selected.controls.flatMap((block) => block.params).length, 6)
  }
  await writeFile(join(root, 'shadow.js'), code)
  // Publish a disabled draft before a slow Jev response; do not persist drafts.
  let releaseSelection
  const staged = new ChatIslands(
    () => {},
    async (_key, candidates) => {
      await new Promise((resolve) => {
        releaseSelection = resolve
      })
      return { controls: candidates, engine: 'jev' }
    }
  )
  staged.register('slow', root, 'slow-record', () => 1)
  const pending = staged.tool('slow', root, request)
  while (!releaseSelection) await new Promise((resolve) => setTimeout(resolve, 1))
  const draft = staged.attachments('slow')[0].view
  assert.equal(draft.engine, 'preparing')
  assert.equal(draft.status, 'waiting')
  assert.equal(draft.fields[0].value, 0)
  assert.equal(staged.sessions.get('slow').records.length, 0)
  await assert.rejects(
    staged.interact({
      chat: 'slow',
      id: draft.id,
      revision: draft.revision,
      sourceRevision: draft.sourceRevision,
      action: 'commit',
      values: { x: 0.5 }
    }),
    /busy/
  )
  releaseSelection()
  assert.ok((await pending).id)
  assert.equal(staged.attachments('slow').length, 1)
  assert.equal(staged.attachments('slow')[0].view.engine, 'jev')
  const cancelledDraft = staged.tool('slow', root, request)
  releaseSelection = undefined
  while (!releaseSelection) await new Promise((resolve) => setTimeout(resolve, 1))
  await staged.settle('slow', false)
  releaseSelection()
  assert.match((await cancelledDraft).error, /turn finished/)
  assert.equal(staged.sessions.get('slow').preview, undefined)
  assert.equal(staged.sessions.get('slow').records.length, 1, 'Cancelled drafts never persist')
  staged.close('slow')

  islands.register('chat', root, 'durable-session', () => 1)
  const made = await islands.tool('chat', root, request)
  assert.ok(made.id, JSON.stringify(made))
  assert.equal(made.engine, 'agent')
  const view = () => islands.sessions.get('chat').views.get(made.id)
  const command = (action, values = {}) => ({
    chat: 'chat',
    id: made.id,
    revision: view().revision,
    sourceRevision: view().sourceRevision,
    operation: crypto.randomUUID(),
    action,
    values
  })
  assert.equal(view().status, 'waiting')
  await assert.rejects(islands.interact(command('commit', { x: 0.5 })), /not landed/)
  await islands.settle('chat', true)
  const source = () => readFile(join(root, 'shadow.js'), 'utf8')
  await islands.interact(command('draft', { x: 0.2 }))
  await islands.interact(command('draft', { y: 0.4 }))
  assert.equal(await source(), code, 'small control changes stay frontend drafts')
  assert.equal(view().draft.count, 2)
  assert.equal(view().draft.preview, false, 'unprojectable literals report no live preview')
  await islands.interact(command('undo-draft'))
  assert.equal(view().draft.count, 1)
  assert.equal(view().fields.find((field) => field.id === 'y').value, -0.5)
  await islands.interact(command('draft-reset'))
  assert.equal(await source(), code, 'Reset stays a draft until Apply')
  assert.equal(view().fields.find((field) => field.id === 'x').value, 0)
  await islands.interact(command('undo-draft'))
  assert.equal(view().fields.find((field) => field.id === 'x').value, 0.2)
  await islands.interact(command('apply-draft'))
  assert.equal(await source(), code, 'Apply only starts an agent turn; it does not write source')
  assert.equal(submittedDrafts.length, 1, 'one Apply submits one accumulated agent operation')
  assert.equal(view().draft.submitted, true, 'draft remains pending during the agent turn')
  await islands.settle('chat', true, 'draft-turn-1')
  assert.equal(view().draft.count, 1, 'a landed agent turn with no matching source keeps the draft')
  assert.equal(view().draft.submitted, false, 'unconfirmed draft becomes actionable again')
  await islands.interact(command('apply-draft'))
  assert.equal(submittedDrafts.length, 2)
  await writeFile(join(root, 'shadow.js'), code.replace('LIGHT_X = 0', 'LIGHT_X = 0.2'))
  renderedDraft = true
  await islands.settle('chat', true, 'draft-turn-2')
  assert.equal(view().draft, undefined, 'source and rendered result settle the draft')
  await writeFile(join(root, 'shadow.js'), code)
  await islands.refresh('chat')
  await islands.interact(command('draft', { y: 0.1 }))
  await islands.interact(command('apply-draft'))
  await writeFile(join(root, 'shadow.js'), code.replace('LIGHT_Y = -0.5', 'LIGHT_Y = 0.1'))
  await islands.settle('chat', true, 'draft-turn-3')
  assert.equal(
    view().draft?.submitted,
    false,
    'unmapped literal does not remain endlessly submitted'
  )
  assert.equal(
    view().draft?.conflict,
    false,
    'matching applied source keeps Retry and Revert available'
  )
  assert.match(view().notice, /no rendered-value check/)
  await islands.interact(command('apply-draft'))
  assert.equal(submittedDrafts.length, 4, 'retry is one explicit agent operation')
  await islands.settle('chat', false, 'draft-turn-4')
  assert.equal(view().draft?.submitted, false, 'failed retry keeps the pending draft')
  await islands.interact(command('revert-draft'))
  await writeFile(join(root, 'shadow.js'), code)
  await islands.refresh('chat')
  await islands.interact(command('draft', { x: 0.6 }))
  await islands.interact(command('draft-reset'))
  assert.equal(await source(), code, 'Reset does not bypass draft Apply')
  assert.equal(view().fields.find((field) => field.id === 'x').value, 0)
  await islands.interact(command('revert-draft'))
  assert.equal(view().draft, undefined)
  assert.equal(await source(), code, 'Revert draft does not write source')
  await islands.interact(command('draft', { x: 0.8 }))
  await writeFile(join(root, 'shadow.js'), code.replace('LIGHT_X = 0', 'LIGHT_X = 0.1'))
  await islands.refresh('chat')
  assert.equal(view().draft.conflict, true)
  await assert.rejects(islands.interact(command('apply-draft')), /Source changed/)
  assert.equal(view().draft.count, 1, 'failed Apply retains the unsatisfied draft')
  await islands.interact(command('revert-draft'))
  await writeFile(join(root, 'shadow.js'), code)
  await islands.refresh('chat')
  await islands.interact(command('draft', { x: 0.8 }))
  await writeFile(join(root, 'shadow.js'), 'const unrelated = 1;\n')
  await islands.refresh('chat')
  assert.equal(view().status, 'disabled', 'removed bindings disable the island')
  await islands.interact(command('undo-draft'))
  assert.equal(view().draft, undefined, 'Undo can dismiss a draft with broken bindings')
  await writeFile(join(root, 'shadow.js'), code)
  await islands.refresh('chat')
  await islands.interact(command('draft', { x: 0.8 }))
  await writeFile(join(root, 'shadow.js'), 'const unrelated = 1;\n')
  await islands.refresh('chat')
  await islands.interact(command('revert-draft'))
  assert.equal(view().draft, undefined, 'Revert can dismiss a draft with broken bindings')
  await writeFile(join(root, 'shadow.js'), code)
  await islands.refresh('chat')
  const oldCommand = command('commit', { x: 0.3, y: 0.8 })
  await islands.interact(oldCommand)
  assert.match(await source(), /LIGHT_X = 0.3;\nconst LIGHT_Y = 0.8/)
  // LKM-133 root cause: the UI sends the source revision it last rendered. A command computed
  // before the refreshed view reached it (a drag's next frame, blur right after Return, the first
  // adjustment after Reload) carried the pre-write file hash and failed with "Source changed".
  await islands.interact({ ...oldCommand, operation: crypto.randomUUID(), values: { x: 0.35 } })
  assert.match(
    await source(),
    /LIGHT_X = 0.35;\nconst LIGHT_Y = 0.8/,
    'A stale UI revision still applies'
  )
  await islands.interact(command('undo'))
  assert.match(
    await source(),
    /LIGHT_X = 0.3;\nconst LIGHT_Y = 0.8/,
    'Undo reverts only the last adjustment'
  )
  await islands.interact(command('reset'))
  assert.equal(await source(), code, 'Reset restores the initial values')
  // Reload, then one adjustment: it applies.
  await islands.interact(command('reload'))
  await islands.interact(command('commit', { x: 0.1 }))
  assert.match(await source(), /LIGHT_X = 0.1;/, 'The first adjustment after Reload applies')
  await islands.interact(command('undo'))
  assert.equal(await source(), code, 'Point gesture undoes both coordinates')
  await islands.interact(command('commit', { ease: 'cubic-bezier(0.1, -0.2, 0.8, 1.2)' }))
  assert.match(await source(), /EASE = \[0.1, -0.2, 0.8, 1.2\]/)
  await islands.interact(command('reset'))
  assert.equal(await source(), code)
  // A throttled drag: several live writes, each from the revision the UI saw before the drag,
  // share one gesture. They form exactly one Undo group, and Undo restores the value from before.
  const beforeDrag = command('commit')
  for (const x of [0.2, 0.4, 0.6, 0.8]) {
    await islands.interact({
      ...beforeDrag,
      operation: crypto.randomUUID(),
      gesture: 'drag-1',
      values: { x }
    })
    assert.match(await source(), new RegExp(`LIGHT_X = ${x};`), 'Each drag frame writes live')
  }
  await islands.interact(command('undo'))
  assert.equal(await source(), code, 'One Undo restores the whole drag')
  await assert.rejects(
    islands.interact(command('undo')),
    /No edit/,
    'The drag was a single Undo group'
  )
  // A fast burst: frames that have not started are coalesced (latest value wins) and never error.
  const owner = islands.owner,
    admit = owner.islandCommand
  let admitted = 0
  owner.islandCommand = (...args) => {
    admitted++
    return admit.apply(owner, args)
  }
  const burst = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((x) => ({
    ...beforeDrag,
    operation: crypto.randomUUID(),
    gesture: 'drag-2',
    values: { x }
  }))
  await Promise.all(burst.map((c) => islands.interact(c)))
  owner.islandCommand = admit
  assert.match(await source(), /LIGHT_X = 0.8;/)
  assert.ok(
    admitted < burst.length,
    `Queued frames coalesce (${admitted} of ${burst.length} written)`
  )
  await islands.interact(command('undo'))
  assert.equal(await source(), code, 'One Undo restores the whole burst')
  // An unrelated edit elsewhere in the file between two frames: the next frame still applies on
  // top of it, keeping it, even when the edit lands while the frame waits for the write lease.
  await islands.interact({
    ...beforeDrag,
    operation: crypto.randomUUID(),
    gesture: 'drag-3',
    values: { x: 0.3 }
  })
  let unblock
  const held = enqueueRepoWrite(
    root,
    () =>
      new Promise((r) => {
        unblock = r
      })
  )
  // The lease is held once its operation runs (a Swift repository lease is a round trip).
  while (!unblock) await new Promise((r) => setTimeout(r, 1))
  const racing = islands.interact({
    ...beforeDrag,
    operation: crypto.randomUUID(),
    gesture: 'drag-3',
    values: { x: 0.7 }
  })
  await writeFile(join(root, 'shadow.js'), (await source()) + '// concurrent editor change\n')
  unblock()
  await held
  await racing
  assert.equal(
    await source(),
    code.replace('LIGHT_X = 0', 'LIGHT_X = 0.7') + '// concurrent editor change\n'
  )
  await writeFile(join(root, 'shadow.js'), code)
  await islands.refresh('chat')
  const before = await source()
  await assert.rejects(islands.interact(command('commit', { x: 0.9, unknown: 'bad' })), /Unknown/)
  assert.equal(await source(), before, 'Invalid batch must not partially write')
  // (The native field also refuses out-of-range typing; see native-island-editing.)
  for (const x of [Number.NaN, 'wide', null])
    await assert.rejects(islands.interact(command('commit', { x })), /finite number/)
  assert.equal(await source(), before, 'An invalid value is not written')
  // An external change of a bound value: nothing is written, no error; the controls show the
  // source value with an inline notice, and the rest of that gesture is dropped.
  await writeFile(join(root, 'shadow.js'), code.replace('LIGHT_X = 0', 'LIGHT_X = 0.42'))
  await islands.interact({ ...command('commit', { x: 0.9 }), gesture: 'drag-4' })
  assert.equal(
    await source(),
    code.replace('LIGHT_X = 0', 'LIGHT_X = 0.42'),
    'The external value is kept'
  )
  assert.equal(
    view().fields.find((f) => f.id === 'x').value,
    0.42,
    'Controls refresh to the source value'
  )
  assert.equal(view().notice, ISLAND_CONFLICT_NOTICE)
  await islands.interact({ ...command('commit', { x: 0.95 }), gesture: 'drag-4' })
  assert.equal(
    await source(),
    code.replace('LIGHT_X = 0', 'LIGHT_X = 0.42'),
    'The conflicted gesture stops writing'
  )
  await islands.interact({ ...command('commit', { x: 0.5 }), gesture: 'drag-5' })
  assert.match(await source(), /LIGHT_X = 0.5;/, 'The next gesture applies')
  assert.equal(view().notice, '', 'A successful write clears the notice')
  await writeFile(join(root, 'shadow.js'), code)
  const stale = command('commit', { x: 0.9 })
  await writeFile(join(root, 'shadow.js'), code + '// external edit\n')
  await islands.interact(command('reload'))
  const updated = await islands.tool('chat', root, {
    ...request,
    id: made.id,
    revision: 1,
    blocks: [...request.blocks].reverse()
  })
  assert.equal(updated.revision, 2)
  assert.equal(
    (await islands.tool('chat', root, { ...request, id: made.id, revision: 1 })).error.includes(
      'revision'
    ),
    true
  )
  await islands.settle('chat', true)
  islands.close('chat')
  islands.register('resumed-key', root, 'durable-session', () => 2)
  await islands.refresh('resumed-key')
  const restored = islands.attachments('resumed-key')
  assert.equal(restored.length, 1)
  assert.equal(restored[0].view.id, made.id)
  assert.equal(restored[0].turn, 1)
  assert.equal(restored[0].view.revision, 2)
  assert.equal(restored[0].view.status, 'ready')
  assert.equal(restored[0].view.blocks[0].id, 'layers')
  await assert.rejects(islands.interact({ ...stale, chat: 'unrelated' }), /unavailable/)
  const revised = await islands.tool('resumed-key', root, { ...request, id: made.id, revision: 2 })
  assert.notEqual(revised.id, made.id, 'A later turn gets a fresh island')
  assert.equal(revised.revision, 1)
  assert.deepEqual(
    islands.attachments('resumed-key').map((a) => a.turn),
    [1, 2]
  )
  assert.equal(
    islands.attachments('resumed-key')[0].view.revision,
    2,
    'Historical definition stays intact'
  )
  await islands.settle('resumed-key', false)
  await islands.settle('resumed-key', true)
  assert.equal(islands.attachments('resumed-key')[0].view.status, 'ready')
  assert.equal(
    islands.attachments('resumed-key')[1].view.status,
    'disabled',
    'Duplicate success must not revive failed creation'
  )
  assert.match(islands.attachments('resumed-key')[1].view.reason, /did not land/)
  for (const blocks of [
    [{ ...request.blocks[0], params: ['x'] }],
    [{ ...request.blocks[0], params: ['x', 'unknown'] }],
    [request.blocks[0], request.blocks[0]]
  ])
    assert.throws(() => islandDefinition({ ...request, blocks }))
  await symlink(join(storage, 'outside.js'), join(root, 'escape.js'))
  await writeFile(join(storage, 'outside.js'), code)
  assert.match(
    (
      await islands.tool('resumed-key', root, {
        ...request,
        manifest: { ...request.manifest, file: 'escape.js' }
      })
    ).error,
    /outside the project/
  )
  // Queued gestures may not run after their owning chat closes.
  islands.register('queued', root, 'other-session', () => 1)
  const queued = await islands.tool('queued', root, request)
  await islands.settle('queued', true)
  let release
  const barrier = enqueueRepoWrite(
    root,
    () =>
      new Promise((r) => {
        release = r
      })
  )
  while (!release) await new Promise((r) => setTimeout(r, 1))
  const v = islands.attachments('queued')[0].view
  // Handled at once: under the Swift owner the refusal can arrive before the barrier ends.
  const applying = assert.rejects(
    islands.interact({
      ...stale,
      chat: 'queued',
      id: queued.id,
      revision: v.revision,
      sourceRevision: v.sourceRevision
    }),
    /closed/
  )
  islands.close('queued')
  release()
  await barrier
  await applying
  // Installed json-render composition API: Jev chooses whole prepared blocks.
  let evaluations = 0
  const chosen = await chooseControlsWithJev(
    'island-test',
    'Light direction and shadow layers',
    request.blocks,
    {
      evaluate: async ({ questions }) => {
        evaluations++
        return {
          answers: Object.fromEntries(
            Object.entries(questions).map(([key, q]) => [
              key,
              {
                type: 'choice',
                choice:
                  key === 'root'
                    ? 'panel'
                    : key.startsWith('order_')
                      ? key === 'order_node_1'
                        ? '2'
                        : '1'
                      : Object.keys(q.criteria).find((k) => k.startsWith('use:'))
              }
            ])
          )
        }
      }
    }
  )
  // The same composition seam accepts physics, time-based, mixed and non-motion controls.
  for (const [title, groups] of [
    ['Tween', [['duration', 'delay', 'easing']]],
    ['Spring', [['stiffness', 'damping', 'mass']]],
    [
      'Combined',
      [
        ['stiffness', 'damping'],
        ['duration', 'easing']
      ]
    ],
    [
      'Typography',
      [
        ['font-size', 'weight'],
        ['line-height', 'tracking']
      ]
    ]
  ]) {
    const candidates = groups.map((params, index) => ({
      id: `group-${index}`,
      title,
      kind: 'group',
      params
    }))
    const result = await chooseControlsWithJev('scenario-' + title, title, candidates, {
      evaluate: async ({ questions }) => ({
        answers: Object.fromEntries(
          Object.entries(questions).map(([key, q]) => [
            key,
            {
              type: 'choice',
              choice:
                key === 'root'
                  ? 'panel'
                  : key.startsWith('order_')
                    ? key.split('_').at(-1)
                    : Object.keys(q.criteria).find((k) => k.startsWith('use:'))
            }
          ])
        )
      })
    })
    assert.deepEqual(result.flatMap((b) => b.params).sort(), groups.flat().sort())
  }
  assert.equal(evaluations, 2)
  // The actual chat runtime uses this fixed preview transport. Only a declared
  // computed opacity on the matching source-stamped element can confirm Apply.
  const opacityCode =
    "const OPACITY = 0.5;\nconst card = document.createElement('div');\ncard.id = 'card';\ncard.setAttribute('data-trezi-source', 'opacity.js:2:1');\ncard.style.opacity = OPACITY;\ndocument.body.append(card);\n"
  await writeFile(join(root, 'opacity.js'), opacityCode)
  const opacityDefinition = islandDefinition({
    manifest: {
      file: 'opacity.js',
      component: 'Card',
      title: 'Card',
      params: [
        {
          id: 'opacity',
          label: 'Opacity',
          kind: 'number',
          min: 0,
          max: 1,
          apply: { strategy: 'literal', anchor: 'const OPACITY = ' },
          rendered: { kind: 'computed-style', selector: '#card', property: 'opacity' }
        }
      ]
    },
    blocks: [{ id: 'surface', title: 'Surface', kind: 'group', params: ['opacity'] }]
  })
  const opacityRecord = {
    ...opacityDefinition,
    version: 1,
    id: 'opacity',
    revision: 1,
    turn: 1,
    engine: 'agent',
    status: 'ready',
    initial: { opacity: 1 }
  }
  const opacityRevision = (await islandSource(root, opacityRecord)).revision
  let pageHref = 'http://127.0.0.1:7777/'
  let renderedStamp = 'opacity.js:2:1'
  let renderedValue = '0.5'
  let startedAt = 1770000000000
  let navigateDuringRead = false
  previewServers.set(projectKey(root), { url: 'http://127.0.0.1:7777/', pid: 1 })
  registerPreviewSource({
    getUrl: () => pageHref,
    capture: async () => null,
    agent: {
      evaluate: async (script, world) => {
        assert.equal(world, 'preview')
        if (script === PAGE_PROBE) return { href: pageHref, startedAt, ready: 'complete' }
        assert.match(script, /querySelectorAll/)
        const observedStart = startedAt
        if (navigateDuringRead) startedAt += 1000
        return {
          href: pageHref,
          startedAt: observedStart,
          values: [{ stamp: renderedStamp, value: renderedValue }]
        }
      }
    }
  })
  assert.equal(
    await confirmIslandRendered(root, opacityRecord, { opacity: 0.5 }, opacityRevision),
    true,
    'production callback links the exact source constant to the target opacity in the current preview session'
  )
  const unrelatedCode =
    "const OPACITY = 0.5;\nconst other = document.createElement('div');\nother.id = 'other';\nother.style.opacity = OPACITY;\nconst card = document.createElement('div');\ncard.id = 'card';\ncard.setAttribute('data-trezi-source', 'opacity.js:5:1');\ncard.style.opacity = 0.5;\ndocument.body.append(card);\n"
  await writeFile(join(root, 'opacity.js'), unrelatedCode)
  const unrelatedRevision = (await islandSource(root, opacityRecord)).revision
  renderedStamp = 'opacity.js:5:1'
  assert.equal(
    await confirmIslandRendered(root, opacityRecord, { opacity: 0.5 }, unrelatedRevision),
    false,
    'a matching same-file element is not proof that the controlled literal feeds its opacity'
  )
  await writeFile(join(root, 'opacity.js'), opacityCode)
  renderedStamp = 'opacity.js:2:1'
  for (const override of [
    "card.style.setProperty('opacity', '0.5');",
    "card.style.cssText = 'opacity: 0.5';",
    'const alias = card; alias.style.opacity = OPACITY;'
  ]) {
    await writeFile(join(root, 'opacity.js'), `${opacityCode}${override}\n`)
    const overrideRevision = (await islandSource(root, opacityRecord)).revision
    assert.equal(
      await confirmIslandRendered(root, opacityRecord, { opacity: 0.5 }, overrideRevision),
      false,
      `a later or aliased style writer stays unsupported: ${override}`
    )
  }
  const sameLine =
    "const OPACITY = 0.5;\nconst other = document.createElement('div'); const card = document.createElement('div');\n"
  const cardColumn = sameLine.split('\n')[1].indexOf('const card') + 1
  const sameLineCode = `${sameLine}other.id = 'other';\nother.style.opacity = OPACITY;\ncard.id = 'card';\ncard.setAttribute('data-trezi-source', 'opacity.js:2:${cardColumn}');\ncard.style.opacity = OPACITY;\ndocument.body.append(card);\n`
  await writeFile(join(root, 'opacity.js'), sameLineCode)
  const sameLineRevision = (await islandSource(root, opacityRecord)).revision
  renderedStamp = 'opacity.js:2:1'
  assert.equal(
    await confirmIslandRendered(root, opacityRecord, { opacity: 0.5 }, sameLineRevision),
    false,
    'an unrelated same-line creation cannot impersonate the linked target by file and line'
  )
  await writeFile(join(root, 'opacity.js'), opacityCode)
  renderedStamp = 'opacity.js:2:1'
  assert.equal(
    await confirmIslandRendered(root, opacityRecord, { opacity: 0.5 }, 'stale-revision'),
    false,
    'the same rendered frame cannot settle a stale source revision'
  )
  renderedStamp = 'another-file.js:1:1'
  assert.equal(
    await confirmIslandRendered(root, opacityRecord, { opacity: 0.5 }, opacityRevision),
    false,
    'a matching rendered value from another source cannot settle Apply'
  )
  renderedStamp = 'opacity.js:2:1'
  renderedValue = '1'
  assert.equal(
    await confirmIslandRendered(root, opacityRecord, { opacity: 0.5 }, opacityRevision),
    false,
    'source-only success cannot substitute for the rendered value'
  )
  renderedValue = '0.5'
  navigateDuringRead = true
  assert.equal(
    await confirmIslandRendered(root, opacityRecord, { opacity: 0.5 }, opacityRevision),
    false,
    'a frame that navigates during readback cannot settle Apply'
  )
  navigateDuringRead = false
  pageHref = 'http://127.0.0.1:7778/'
  assert.equal(
    await confirmIslandRendered(root, opacityRecord, { opacity: 0.5 }, opacityRevision),
    false,
    'another project preview is rejected even with the expected value and stamp'
  )
  previewServers.delete(projectKey(root))
  assert.deepEqual(
    chosen.map((b) => b.id),
    ['layers', 'light']
  )
  assert.deepEqual(chosen[1].params, ['x', 'y'], 'Compound bindings stay together')
  await assert.rejects(
    chooseControlsWithJev('island-invalid', 'Controls', request.blocks, {
      evaluate: async () => {
        throw new Error('Evaluator failed')
      }
    }),
    /Evaluator failed/
  )
  assert.ok(changes > 3)
  console.log(
    'CHAT-ISLANDS OK — composition, source batches, stale/closed guards, landing, undo and durable restoration'
  )
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(storage, { recursive: true, force: true })
}
