import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { waitFor } from './smoke-wait'
import { nativeWorkspace } from './workspace-runtime'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>
type Page = (code: string) => Promise<unknown>

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const DRAFT = 'Make the marked card larger'
const EXISTING = {
  name: 'existing.png',
  path: '',
  type: 'image/png',
  data: PIXEL
}

/** A page of the kind people mark up, with Trezi's own marker on one element: a capture
 *  that shows it shows Trezi's chrome. */
const PAGE = `(() => {
  const old = document.querySelector('#markup-smoke'); if (old) old.remove()
  const root = document.createElement('div'); root.id = 'markup-smoke'
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#f6f7f9;font:16px system-ui;padding:24px'
  root.innerHTML = '<h1>Pricing</h1><div id="markup-card" style="width:220px;height:120px;background:#2563eb"></div>'
    + '<div id="markup-chrome" data-trezi-cover style="position:fixed;right:0;bottom:0;width:120px;height:120px;background:#ff00ff"></div>'
  document.body.append(root)
  return true
})()`

/** LKM-391: Mark up through the real route in a disposable profile: the Actions entry, the
 *  capture, drawing through the canvas's pointer path, undo and clear, Escape, and Add into
 *  a composer that already holds a draft and an attachment. Add never sends. Mapping holds
 *  through overlay resize, preview zoom and a narrow preview, and a chat or project change
 *  ends the session out loud. Saves foreground captures and the JSON state of each step. */
export async function checkPreviewMarkup(host: NativeBridge, page: Page, artifacts: string) {
  const folder = join(artifacts, 'preview-markup')
  mkdirSync(folder, { recursive: true })
  const inspect = (): Promise<State> => host.request('previewMarkupInspect')
  const test = async (params: State): Promise<State> => {
    const reply = await host.request('previewMarkupTest', params)
    assert.equal(reply.error, undefined, `${params.action}: ${reply.error}`)
    return reply
  }
  const composer = (): Promise<State> => host.request('composerInspect')
  const steps: State = {}
  const step = async (name: string) => {
    const state = await inspect()
    steps[name] = state
    writeFileSync(join(folder, 'steps.json'), JSON.stringify(steps, null, 2))
    const shot = await host.request('captureVisibleWindow')
    writeFileSync(join(folder, `${name}.png`), Buffer.from(shot.png, 'base64'))
    return state
  }
  const open = async (label: string) => {
    await test({ action: 'open' })
    return waitFor(async () => {
      const state = await inspect()
      return state.open && state
    }, `${label}: Mark up opens`)
  }
  const closed = (label: string) =>
    waitFor(async () => !(await inspect()).open, `${label}: Mark up closes`)
  const sends = () => nativeChat.get(nativeChat.active).messages.length

  await page(PAGE)
  const chat = nativeChat.active
  await host.request('composerPerform', { text: DRAFT })
  await nativeChat.composer({ chat, action: 'files', files: [EXISTING] })
  await waitFor(
    async () => (await composer()).attachments.length === 1,
    'the composer holds the existing attachment'
  )
  const messages = sends()

  // Open: frozen pixels, in focus, on top, with nothing claiming the page stopped.
  const opened = await open('first')
  assert.equal(opened.addEnabled, false, 'nothing to add before a mark')
  assert.equal(opened.undoEnabled, false, 'nothing to undo before a mark')
  assert.equal(opened.focused, true, 'the overlay holds keyboard focus')
  assert.equal(opened.topmost, true, 'the overlay is above the preview')
  assert.ok(opened.cover > 0, 'the page is told the overlay covers it')
  assert.doesNotMatch(opened.status, /pause/i, 'the status does not claim a paused page')
  for (const label of ['Pen', 'Rectangle', 'Circle', 'Arrow', 'Undo', 'Clear', 'Cancel'])
    assert.ok(
      opened.controls.some((control: State) => control.label === label),
      `${label} has a label`
    )
  assert.ok(
    opened.controls.some((control: State) => control.label === 'Add to chat'),
    'Add to chat has a label'
  )
  // Retina: the image holds the backing pixels of the viewport it shows.
  assert.ok(
    Math.abs(
      opened.image.width / opened.backing - opened.context.viewportWidth * opened.context.zoom
    ) <= 2,
    'captured at backing scale'
  )
  // The in-page chrome came back after the capture and was not in it.
  assert.equal(
    await page('getComputedStyle(document.querySelector("#markup-chrome")).display'),
    'block',
    'the hidden chrome is restored'
  )
  assert.equal(opened.magenta, 0, 'in-page chrome is absent from the capture')

  // Frozen: the page moving does not move the pixels under the marks.
  await page('document.querySelector("#markup-card").style.background = "#16a34a"')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal((await inspect()).frozen, opened.frozen, 'the snapshot does not follow the page')

  // Every tool, then undo and clear.
  const { width, height } = opened.image
  const box = (x: number, y: number, w: number, h: number) => [
    [width * x, height * y],
    [width * (x + w), height * (y + h)]
  ]
  await test({ action: 'stroke', tool: 'rectangle', points: box(0.1, 0.1, 0.3, 0.2) })
  await test({ action: 'stroke', tool: 'circle', points: box(0.5, 0.1, 0.2, 0.2) })
  await test({ action: 'stroke', tool: 'arrow', points: box(0.2, 0.5, 0.3, 0.2) })
  await test({
    action: 'stroke',
    tool: 'pen',
    points: [
      [width * 0.6, height * 0.5],
      [width * 0.65, height * 0.6],
      [width * 0.7, height * 0.5],
      [width * 0.75, height * 0.6]
    ]
  })
  const drawn = await step('marks')
  assert.deepEqual(
    drawn.marks.map((mark: State) => mark.tool),
    ['rectangle', 'circle', 'arrow', 'pen']
  )
  assert.equal(drawn.addEnabled, true, 'a mark enables Add')
  assert.equal((await test({ action: 'key', key: 'z', code: 6, command: true })).taken, true)
  assert.equal((await inspect()).marks.length, 3, '⌘Z takes the last mark')
  await test({ action: 'clear' })
  assert.equal((await inspect()).marks.length, 0, 'Clear takes every mark')
  await test({ action: 'stroke', tool: 'rectangle', points: box(0.1, 0.1, 0.3, 0.2) })
  await test({ action: 'stroke', tool: 'arrow', points: box(0.4, 0.4, 0.3, 0.2) })

  // Overlay resize, preview zoom and a narrow preview: marks stay in captured pixels and
  // land on the same part of the shown image.
  const stored = (await inspect()).marks.map((mark: State) => mark.points)
  const placement = (state: State) =>
    state.marks[0].view.map(([x, y]: number[]) => [
      (x - state.shown.x) / state.shown.width,
      (y - state.shown.y) / state.shown.height
    ])
  const before = placement(await inspect())
  for (const [label, w, h] of [
    ['narrow', 390, 700],
    ['resized', 760, 480]
  ] as const) {
    await test({ action: 'resize', width: w, height: h })
    const state = await step(`resize-${label}`)
    assert.deepEqual(
      state.marks.map((mark: State) => mark.points),
      stored,
      `${label}: captured coordinates are unchanged`
    )
    placement(state).forEach(([x, y]: number[], index: number) => {
      assert.ok(Math.abs(x - before[index][0]) < 0.005, `${label}: mark x stays on the image`)
      assert.ok(Math.abs(y - before[index][1]) < 0.005, `${label}: mark y stays on the image`)
    })
  }

  // Escape discards the lot and leaves the composer as it was.
  await test({ action: 'key', key: '\u{1b}', code: 53 })
  await closed('escape')
  let state = await composer()
  assert.equal(state.text, DRAFT, 'Escape keeps the draft')
  assert.equal(state.attachments.length, 1, 'Escape attaches nothing')

  // Cancel the same way.
  await open('cancel')
  await test({ action: 'stroke', tool: 'circle', points: box(0.1, 0.1, 0.2, 0.2) })
  await test({ action: 'cancel' })
  await closed('cancel')
  assert.equal((await composer()).attachments.length, 1, 'Cancel attaches nothing')

  // A narrow and a zoomed preview: the capture is the view's pixels, the context says how
  // the page sat in it, and a mark still lands where it was drawn.
  for (const [label, viewport] of [
    ['narrow-viewport', 390],
    ['zoomed-viewport', 2000]
  ] as const) {
    await host.request('previewViewport', { width: viewport })
    await waitFor(
      async () => Number(await page('innerWidth')) === viewport,
      `${label}: the page takes the width`
    )
    const session = await open(label)
    assert.equal(session.context.viewportWidth, viewport, `${label}: the viewport is captured`)
    if (viewport > 1000) assert.ok(session.context.zoom < 1, `${label}: the zoom is captured`)
    const { image, shown } = session
    assert.ok(
      Math.abs(image.width / image.height - shown.width / shown.height) < 0.02,
      `${label}: the image is shown undistorted`
    )
    const at = [
      [image.width * 0.25, image.height * 0.25],
      [image.width * 0.75, image.height * 0.75]
    ]
    await test({ action: 'stroke', tool: 'rectangle', points: at })
    const marked = await step(label)
    marked.marks[0].points.forEach(([x, y]: number[], index: number) => {
      assert.ok(Math.abs(x - at[index][0]) < 1, `${label}: captured x is where it was drawn`)
      assert.ok(Math.abs(y - at[index][1]) < 1, `${label}: captured y is where it was drawn`)
    })
    assert.ok(
      Math.abs(marked.marks[0].view[0][0] - (shown.x + shown.width * 0.25)) < 1,
      `${label}: the mark lands on the image`
    )
    await test({ action: 'cancel' })
    await closed(label)
    await host.request('previewViewport', {})
  }

  // Project and chat isolation: a session ends with what it was bound to.
  const project = nativeWorkspace.state.activeKey!
  await open('chat change')
  await test({ action: 'stroke', tool: 'circle', points: box(0.1, 0.1, 0.2, 0.2) })
  host.emit('shell-action', { action: 'new-chat', project })
  await waitFor(() => nativeChat.active !== chat, 'a new chat opens')
  await closed('chat change')
  const fresh = nativeChat.active
  assert.equal((await composer()).attachments.length, 0, 'the other chat receives nothing')
  await nativeWorkspace.command({ type: 'chat', key: project, session: chat })
  await waitFor(async () => (await composer()).attachments.length === 1, 'back on the first chat')
  await nativeWorkspace.command({ type: 'close-chat', key: project, session: fresh })
  const other = join(folder, 'other-project')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'index.html'), '<h1>Other project</h1>')
  await open('project change')
  await test({ action: 'stroke', tool: 'circle', points: box(0.1, 0.1, 0.2, 0.2) })
  await nativeWorkspace.command({ type: 'open', root: other })
  await closed('project change')
  assert.equal((await composer()).attachments.length, 0, 'the other project receives nothing')
  const opened2 = nativeWorkspace.active!.key
  await nativeWorkspace.command({ type: 'select', key: project })
  await nativeWorkspace.command({ type: 'close', key: opened2 })
  await nativeWorkspace.command({ type: 'chat', key: project, session: chat })
  await waitFor(async () => (await composer()).attachments.length === 1, 'back on the project')
  await waitFor(() => page('!!document.querySelector("#native-title")'), 'the fixture is back')
  await page(PAGE)

  // Add: the composite joins the draft and the existing attachment; nothing is sent.
  await open('add')
  await test({ action: 'stroke', tool: 'rectangle', points: box(0.1, 0.1, 0.3, 0.2) })
  await test({ action: 'stroke', tool: 'arrow', points: box(0.4, 0.4, 0.3, 0.2) })
  await step('before-add')
  await test({ action: 'add' })
  await closed('add')
  state = await waitFor(async () => {
    const value = await composer()
    return value.attachments.length === 2 && value
  }, 'the composite reaches the composer')
  assert.equal(state.text, DRAFT, 'Add keeps the draft')
  assert.deepEqual(
    state.attachments.map((file: State) => file.name),
    ['existing.png', 'Mark up.png']
  )
  assert.equal(state.inputIsFirstResponder, true, 'the composer takes the instruction')
  assert.equal(sends(), messages, 'Add does not send')
  assert.match(
    nativeChat.get(chat).attachments[1].note ?? '',
    /marks.*user/i,
    'the statement that marks are the user’s travels with the image'
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(sends(), messages, 'nothing sends afterwards either')
  writeFileSync(
    join(folder, 'composer.json'),
    JSON.stringify({ text: state.text, attachments: state.attachments.length }, null, 2)
  )
  writeFileSync(
    join(folder, 'composer.png'),
    Buffer.from((await host.request('captureVisibleWindow')).png, 'base64')
  )
}

export async function restorePreviewMarkup(host: NativeBridge, page: Page) {
  await host.request('previewMarkupTest', { action: 'cancel' }).catch(() => {})
  await host.request('previewViewport', {}).catch(() => {})
  await page('document.querySelector("#markup-smoke")?.remove()').catch(() => {})
  const { attachments } = await host.request('composerInspect')
  await host.request('composerPerform', {
    steps: [...attachments.map(() => ({ remove: 0 })), { text: '' }]
  })
}
