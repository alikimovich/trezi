import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { waitFor } from './smoke-wait'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>

const PURPLE = '#7a3fd0'
const IDLE = ['Select', 'Pen', 'Rectangle', 'Shapes', 'Text', 'Close annotation tools']

const sameInk = (a: string, b: string) =>
  [1, 3, 5].every(
    (i) =>
      Math.abs(Number.parseInt(a.slice(i, i + 2), 16) - Number.parseInt(b.slice(i, i + 2), 16)) <= 3
  )
const sha = (data: string) => createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex')
const shown = (state: State) =>
  state.controls.filter((control: State) => !control.hidden).map((control: State) => control.label)

/** LKM-647: the compact, contextual Mark up island through foreground AppKit input on the
 *  smoke page: idle (tools and a trailing Close, no filler), a drawn shape (Undo/Redo/Delete
 *  and Add appear), the shape selected with Select (its colour from the standard panel and its
 *  stroke change it alone), ⌘Z/⇧⌘Z over that history, Delete and back, marks plus a region,
 *  Add excluding the selection's handles, a constrained pane, and Close attaching nothing. */
export async function checkMarkupToolbar(host: NativeBridge, folder: string) {
  const inspect = (): Promise<State> => host.request('previewMarkupInspect')
  const test = async (params: State): Promise<State> => {
    const reply = await host.request('previewMarkupTest', params)
    assert.equal(reply.error, undefined, `${params.action}: ${reply.error}`)
    return reply
  }
  const steps: State = {}
  let count = 0
  const event = async (params: State) => {
    const reply = await test(params)
    assert.equal(reply.route, 'real event route', `${params.action} crossed AppKit`)
    const state = await inspect()
    steps[`toolbar-${++count}-${params.action}`] = { ...state, input: params }
    writeFileSync(join(folder, 'toolbar-steps.json'), JSON.stringify(steps, null, 2))
    return state
  }
  const shot = async (name: string) => {
    const capture = await host.request('captureVisibleWindow')
    writeFileSync(join(folder, `${name}.png`), Buffer.from(capture.png, 'base64'))
  }
  const key = (key: string, code: number, modifiers: State = {}) =>
    event({ action: 'key', key, code, ...modifiers })
  const button = (label: string) => event({ action: 'button', label })
  const chat = nativeChat.active
  const attachments = () => nativeChat.get(chat).attachments.length
  const before = attachments()

  await test({ action: 'open' })
  const idle = await waitFor(async () => {
    const state = await inspect()
    return state.open && state
  }, 'toolbar: Mark up opens')
  assert.deepEqual(shown(idle), IDLE, 'idle: compact')
  assert.equal(idle.status, '', 'idle: no filler text')
  const { frame, snapshot } = idle.island
  // Window points run up: the island sits 10 pt under the page's top edge, inside it.
  assert.ok(
    Math.abs(frame.y + frame.height - (snapshot.y + snapshot.height - 10)) <= 1,
    'idle: at the top of the page'
  )
  const close = idle.controls.find((control: State) => control.label === 'Close annotation tools')
  assert.ok(
    Math.abs(
      close.frame.x +
        close.frame.width -
        Math.max(
          ...idle.controls
            .filter((c: State) => !c.hidden)
            .map((c: State) => c.frame.x + c.frame.width)
        )
    ) < 0.5,
    'idle: Close is the rightmost control'
  )
  assert.equal(close.tooltip, 'Close annotation tools (Esc)')
  // LKM-671: the current tool alone shows selected (fill and on state), after the press ends.
  const current = (state: State) =>
    state.controls.filter((c: State) => c.selected && c.on).map((c: State) => c.label)
  assert.deepEqual(current(idle), ['Select'], 'idle: Select is the selected tool')
  await shot('toolbar-idle')

  // A rectangle: history, Delete and Add appear; nothing is selected yet.
  const { width: w, height: h } = idle.image
  const [x0, y0, x1, y1] = [w * 0.2, h * 0.2, w * 0.45, h * 0.45].map(Math.round)
  await key('r', 15)
  const drawn = await event({
    action: 'pointer',
    points: [
      [x0, y0],
      [(x0 + x1) / 2, (y0 + y1) / 2],
      [x1, y1]
    ]
  })
  assert.equal(drawn.marks.length, 1)
  assert.deepEqual(current(drawn), ['Rectangle'], 'R: the shapes slot shows selected')
  assert.deepEqual(
    [drawn.addEnabled, drawn.undoEnabled, drawn.redoEnabled, drawn.deleteEnabled],
    [true, true, false, false],
    'drawn: Add and Undo on, Redo and Delete off'
  )
  assert.ok(
    shown(drawn).includes('Stroke width') && drawn.colorWell.hidden === false,
    'drawn: the shape tool shows colour and stroke'
  )
  await shot('toolbar-drawn')

  // Select the rectangle by its top edge: its own colour and weight; handles are decoration.
  await button('Select')
  const edge = Math.round(x0 + (x1 - x0) * 0.3)
  const picked = await event({
    action: 'pointer',
    points: [
      [edge, y0],
      [edge, y0]
    ]
  })
  assert.equal(picked.selected, 0, 'a click on the stroke selects the rectangle')
  assert.deepEqual(current(picked), ['Select'], 'a click on Select: it stays selected')
  assert.deepEqual(
    [picked.colorWell.hidden, picked.strokeShown, picked.deleteEnabled],
    [false, true, true]
  )
  await test({ action: 'stroke', stroke: 'thick' })
  await event({ action: 'colorWell' })
  await test({ action: 'annotationColorChoose', color: PURPLE })
  await test({ action: 'colorPanelClose' })
  const styled = await inspect()
  assert.equal(styled.marks[0].stroke, 'thick', 'the stroke menu changes the selected mark')
  assert.ok(
    sameInk(styled.marks[0].ink, PURPLE),
    `the panel's colour is the selected mark's: ${styled.marks[0].ink}`
  )
  assert.ok(!sameInk(styled.colorWell.ink, PURPLE), 'and not the ink of new marks')
  await shot('toolbar-selected')
  const undone = await key('z', 6, { command: true })
  assert.ok(
    !sameInk(undone.marks[0].ink, PURPLE) && undone.marks[0].stroke === 'thick',
    '⌘Z takes the colour'
  )
  assert.equal(undone.redoEnabled, true)
  const redone = await key('z', 6, { command: true, shift: true })
  assert.ok(sameInk(redone.marks[0].ink, PURPLE), '⇧⌘Z puts it back')
  const deleted = await key('\u{7f}', 51)
  assert.equal(deleted.marks.length, 0, '⌫ deletes the selected mark')
  assert.ok(!shown(deleted).includes('Add to chat'), 'nothing left to send: Add goes')
  const back = await key('z', 6, { command: true })
  assert.equal(back.marks.length, 1, '⌘Z brings it back')

  // Marks and a region: the region from a drag off the mark; Add sends the marks inside it,
  // never the selection's outline or handles.
  const region = await event({
    action: 'pointer',
    points: [
      [Math.round(w * 0.1), Math.round(h * 0.15)],
      [Math.round(w * 0.6), Math.round(h * 0.6)]
    ]
  })
  assert.ok(region.region && region.marks.length === 1 && region.addEnabled, 'marks + region')
  const reselected = await event({
    action: 'pointer',
    points: [
      [edge, y0],
      [edge, y0]
    ]
  })
  assert.equal(reselected.selected, 0, 'the mark selects inside the region')
  const composite = await test({ action: 'annotationComposite' })
  await shot('toolbar-marks-region')

  // A constrained pane: Close and Add stay on the island, inside the page.
  await test({ action: 'resize', width: 360, height: 600 })
  const narrow = await inspect()
  for (const label of ['Add to chat', 'Close annotation tools']) {
    const control = narrow.controls.find((c: State) => c.label === label)
    assert.ok(control && !control.hidden, `narrow: ${label} is shown`)
    const f = control.frame
    const bar = narrow.bar
    assert.ok(
      f.x >= bar.x &&
        f.x + f.width <= bar.x + bar.width + 0.5 &&
        f.y >= bar.y &&
        f.y + f.height <= bar.y + bar.height + 0.5,
      `narrow: ${label} inside the island`
    )
  }
  assert.ok(
    narrow.bar.x >= narrow.canvas.x &&
      narrow.bar.x + narrow.bar.width <= narrow.canvas.x + narrow.canvas.width,
    'narrow: the island inside the page'
  )
  await shot('toolbar-narrow')

  await button('Add to chat')
  await waitFor(() => attachments() === before + 1, 'toolbar: the image reaches the composer')
  const added = nativeChat.get(chat).attachments.at(-1)
  assert.equal(
    sha(added?.data ?? ''),
    sha(composite.data),
    'Add sends the marks and region, no selection handles'
  )

  // Close: nothing attached.
  await test({ action: 'open' })
  await waitFor(async () => (await inspect()).open, 'toolbar: reopens')
  await key('p', 35)
  await event({
    action: 'pointer',
    points: [
      [x0, y1],
      [x1, y1]
    ]
  })
  const closing = await inspect()
  assert.match(
    closing.controls.find((c: State) => c.label === 'Close annotation tools').tooltip,
    /discard/,
    'Close says it discards unsent marks'
  )
  await button('Close annotation tools')
  await waitFor(async () => !(await inspect()).open, 'toolbar: Close closes')
  assert.equal(attachments(), before + 1, 'Close attaches nothing')
}
