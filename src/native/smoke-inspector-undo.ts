import assert from 'node:assert/strict'
import type { NativeBridge } from './bridge'
import type { IslandPage } from './smoke-inspector-island'
import { waitFor } from './smoke-wait'

type Island = Record<string, unknown>
type Field = {
  found: boolean
  shown: string
  editing: boolean
  responder: string
  undoTitle: string
}

/**
 * LKM-644: Edit → Undo (⌘Z) / Redo (⇧⌘Z) step the Styles draft with real key events in the
 * app's own event queue. The padding Vertical field is focused and holds a committed 12
 * (the pointer check typed it). After a second committed value, each key must update the
 * real field's shown text (its field editor while focused), the inspector's value and the
 * element's computed padding together, one step at a time. With the composer focused the
 * key is the composer's and the draft does not move; with the page focused (no page field)
 * it steps the draft. Ends with 12 staged again, as the caller expects. Captures before,
 * undo and redo.
 */
export async function checkUndoKeys(
  host: NativeBridge,
  island: (params?: Record<string, unknown>) => Promise<Island>,
  page: IslandPage,
  evidence: Record<string, unknown>,
  capture: (stem: string, state: Island) => Promise<void>,
  original: { field: string; computed: string }
) {
  const value = async () =>
    ((await host.request('inspectorInspect')) as { values: Record<string, string> }).values[
      'style:padding-vertical'
    ]
  const computed = () =>
    page.evaluate(`getComputedStyle(document.querySelector('#native-title')).paddingTop`)
  const key = (shift: boolean, focus?: 'composer' | 'preview') =>
    island({ pointer: true, step: 'key', shift, focus }) as Promise<Field>
  const field = () => island({ pointer: true, step: 'field' }) as Promise<Field>
  const trail: unknown[] = []
  evidence.undoKeys = trail
  /** The field text, the inspector value and the rendered padding all show `expected`. */
  const shows = async (expected: { field: string; computed: string }, label: string) => {
    const state = await waitFor(
      async () => {
        const [shown, staged, rendered] = [await field(), await value(), await computed()]
        return shown.shown === expected.field &&
          staged === expected.field &&
          rendered === expected.computed
          ? { shown, staged, rendered }
          : false
      },
      label,
      10000,
      async () => ({ field: await field(), value: await value(), computed: await computed() })
    )
    trail.push({ label, ...state })
    return state
  }
  const twelve = { field: '12', computed: '12px' }
  const twenty = { field: '20', computed: '20px' }
  const edit = await island({ pointer: true, step: 'edit', value: '20' })
  assert.ok(edit.focused, `pointer: the field takes a second value ${JSON.stringify(edit)}`)
  const before = await shows(twenty, 'second committed value 20')
  assert.ok(before.shown.editing, 'the field keeps focus after Return')
  assert.equal(before.shown.undoTitle, 'Undo Style Change', 'Edit → Undo names the style step')
  // With the committed field still focused (its field editor showing the text).
  await key(false)
  const undone = await shows(twelve, '⌘Z with the committed field focused: 20 → 12')
  assert.ok(undone.shown.editing, 'the focused field shows the restored value while editing')
  await key(true)
  const redone = await shows(twenty, '⇧⌘Z with the field focused: 20 again')
  assert.ok(redone.shown.editing, 'still the same text session, showing 20')
  // Rendered before / undo / redo (a capture takes the focus off the field).
  await capture('inspector-undo-before', await island({}))
  await key(false)
  await shows(twelve, '⌘Z: 20 → 12')
  await capture('inspector-undo-undone', await island({}))
  await key(true)
  await shows(twenty, '⇧⌘Z: 20 again')
  await capture('inspector-undo-redone', await island({}))
  await key(false)
  await shows(twelve, '⌘Z: 12')
  await key(false)
  await shows(original, `⌘Z again: back to the original ${original.field}`)
  await key(true)
  await shows(twelve, '⇧⌘Z: 12')
  await key(true)
  await shows(twenty, '⇧⌘Z: 20')
  // The composer keeps its own Undo: the draft does not move.
  const composer = await key(false, 'composer')
  assert.match(
    composer.responder,
    /TextView/,
    `the composer had the focus ${JSON.stringify(composer)}`
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(await value(), '20', 'composer ⌘Z never steps the visual draft')
  // The page, with no page field focused: the preview script sends one step.
  await key(false, 'preview')
  await shows(twelve, '⌘Z with the preview focused: 20 → 12, once')
}
