import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
const INSTRUCTION = ' Also use blue.'
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

/** LKM-393: Mark up through foreground AppKit input in a disposable profile: the Actions entry, the
 *  capture, posted pointer, key and button events, Escape, and Add into
 *  a composer that already holds a draft and an attachment. Add never sends; the composite is
 *  then retained (`native-composite.png` + `.json`: hash, provenance) and sent by the
 *  composer's normal Send, with the provider's outbound call intercepted, saving the payload
 *  (`send-payload.json`). Mapping holds through overlay resize, preview zoom and a narrow
 *  preview, and a chat or project change ends the session out loud. Saves foreground
 *  captures and the JSON state and route classification of each step. */
export async function checkPreviewMarkup(host: NativeBridge, page: Page, artifacts: string) {
  const { TREZI_NATIVE_BACKGROUND_TEST: background } = process.env
  if (background === '1') {
    console.log(
      'SKIP preview-markup posted AppKit routes: TREZI_NATIVE_BACKGROUND_TEST requires a foreground window'
    )
    return
  }
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
  const step = async (name: string, route: string, input?: State) => {
    const state = await inspect()
    steps[name] = { ...state, route, ...(input ? { input } : {}) }
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
  let eventNumber = 0
  const event = async (params: State) => {
    const reply = await test(params)
    assert.equal(reply.route, 'real event route', `${params.action} crossed AppKit`)
    await step(`event-${++eventNumber}-${params.action}`, 'real event route', params)
    return reply
  }
  const button = (label: string) => event({ action: 'button', label })
  const stroke = async (tool: string, points: number[][]) => {
    const labels: Record<string, string> = {
      rectangle: 'Rectangle',
      circle: 'Circle',
      arrow: 'Arrow',
      pen: 'Pen'
    }
    await button(labels[tool])
    await event({ action: 'pointer', points })
  }

  await page(PAGE)
  await page('history.pushState({ markupSmoke: true }, "", "#markup-smoke-route")')
  await page(
    '(() => { window.__markupSmokeKeys = 0; window.__markupSmokeKeyListener = event => { if (event.metaKey) window.__markupSmokeKeys++ }; window.addEventListener("keydown", window.__markupSmokeKeyListener); return true })()'
  )
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
  await step(
    'opened',
    'seam only: shell-action opens the overlay without clicking the Actions menu'
  )
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
  await step('frozen', 'seam only: fixture page style mutation simulates live content changing')

  // Every tool, then undo and clear.
  const { width, height } = opened.image
  const box = (x: number, y: number, w: number, h: number) => [
    [width * x, height * y],
    [width * (x + w), height * (y + h)]
  ]
  await stroke('rectangle', box(0.1, 0.1, 0.3, 0.2))
  await stroke('circle', box(0.5, 0.1, 0.2, 0.2))
  await stroke('arrow', box(0.2, 0.5, 0.3, 0.2))
  await stroke('pen', [
    [width * 0.6, height * 0.5],
    [width * 0.65, height * 0.6],
    [width * 0.7, height * 0.5],
    [width * 0.75, height * 0.6]
  ])
  const drawn = await step('marks', 'real event route')
  assert.deepEqual(
    drawn.marks.map((mark: State) => mark.tool),
    ['rectangle', 'circle', 'arrow', 'pen']
  )
  assert.equal(drawn.addEnabled, true, 'a mark enables Add')
  const history = await host.request('previewHistory')
  assert.equal(history.canBack, true, 'the page has real history to protect')
  for (const [key, code] of [
    ['\u{f702}', 123],
    ['\u{f703}', 124],
    ['[', 33],
    [']', 30]
  ] as const) {
    await event({ action: 'key', key, code, command: true })
    const after = await host.request('previewHistory')
    assert.equal(after.steps, history.steps, 'history keys do not navigate beneath the overlay')
    assert.equal(after.url, history.url, 'the page URL remains under the overlay')
    assert.equal(
      await page('window.__markupSmokeKeys'),
      0,
      'history keyDown does not reach the page'
    )
  }
  await event({ action: 'key', key: 'z', code: 6, command: true })
  assert.equal(await page('window.__markupSmokeKeys'), 0, 'Undo keyDown does not reach the page')
  assert.equal((await inspect()).marks.length, 3, '⌘Z takes the last mark')
  await button('Undo')
  assert.equal((await inspect()).marks.length, 2, 'Undo button takes another mark')
  await button('Clear')
  assert.equal((await inspect()).marks.length, 0, 'Clear takes every mark')
  await stroke('rectangle', box(0.1, 0.1, 0.3, 0.2))
  await stroke('arrow', box(0.4, 0.4, 0.3, 0.2))

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
    const state = await step(
      `resize-${label}`,
      'seam only: test-only overlay area setter checks mapping without resizing the whole window'
    )
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
  await event({ action: 'key', key: '\u{1b}', code: 53 })
  await closed('escape')
  await step('escaped', 'real event route')
  let state = await composer()
  assert.equal(state.text, DRAFT, 'Escape keeps the draft')
  assert.equal(state.attachments.length, 1, 'Escape attaches nothing')

  // Cancel the same way.
  await open('cancel')
  await stroke('circle', box(0.1, 0.1, 0.2, 0.2))
  await button('Cancel')
  await closed('cancel')
  await step('cancelled', 'real event route')
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
    await stroke('rectangle', at)
    const marked = await step(
      label,
      'seam only: viewport; real event route: drawing (previewViewport sets deterministic width and zoom)'
    )
    marked.marks[0].points.forEach(([x, y]: number[], index: number) => {
      assert.ok(Math.abs(x - at[index][0]) < 1, `${label}: captured x is where it was drawn`)
      assert.ok(Math.abs(y - at[index][1]) < 1, `${label}: captured y is where it was drawn`)
    })
    assert.ok(
      Math.abs(marked.marks[0].view[0][0] - (shown.x + shown.width * 0.25)) < 1,
      `${label}: the mark lands on the image`
    )
    await button('Cancel')
    await closed(label)
    await host.request('previewViewport', {})
  }

  // Project and chat isolation: a session ends with what it was bound to.
  const project = nativeWorkspace.state.activeKey
  assert.ok(project, 'the first project is active')
  await open('chat change')
  await stroke('circle', box(0.1, 0.1, 0.2, 0.2))
  host.emit('shell-action', { action: 'new-chat', project })
  await waitFor(() => nativeChat.active !== chat, 'a new chat opens')
  await closed('chat change')
  await step('chat-isolation', 'seam only: workspace command switches chats deterministically')
  const fresh = nativeChat.active
  assert.equal((await composer()).attachments.length, 0, 'the other chat receives nothing')
  await nativeWorkspace.command({ type: 'chat', key: project, session: chat })
  await waitFor(async () => (await composer()).attachments.length === 1, 'back on the first chat')
  await nativeWorkspace.command({ type: 'close-chat', key: project, session: fresh })
  const other = join(folder, 'other-project')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'index.html'), '<h1>Other project</h1>')
  await open('project change')
  await stroke('circle', box(0.1, 0.1, 0.2, 0.2))
  await nativeWorkspace.command({ type: 'open', root: other })
  await closed('project change')
  await step(
    'project-isolation',
    'seam only: workspace command switches generated fixture projects'
  )
  assert.equal((await composer()).attachments.length, 0, 'the other project receives nothing')
  const opened2 = nativeWorkspace.active?.key
  assert.ok(opened2, 'the second project is active')
  await nativeWorkspace.command({ type: 'select', key: project })
  await nativeWorkspace.command({ type: 'close', key: opened2 })
  await nativeWorkspace.command({ type: 'chat', key: project, session: chat })
  await waitFor(async () => (await composer()).attachments.length === 1, 'back on the project')
  await waitFor(() => page('!!document.querySelector("#native-title")'), 'the fixture is back')
  await page(PAGE)

  // Add: the composite joins the draft and the existing attachment; nothing is sent.
  await open('add')
  await stroke('rectangle', box(0.1, 0.1, 0.3, 0.2))
  await stroke('arrow', box(0.4, 0.4, 0.3, 0.2))
  await step('before-add', 'real event route')
  await button('Add to chat')
  await closed('add')
  await step('added', 'real event route')
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
  const typed = await test({ action: 'typeInstruction', text: INSTRUCTION })
  assert.equal(typed.route, 'real event route', 'instruction crosses AppKit text input')
  state = await waitFor(async () => {
    const value = await composer()
    return value.text === DRAFT + INSTRUCTION && value
  }, 'typed instruction follows the original draft')
  await step('typed-instruction', 'real event route')
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
    JSON.stringify(
      {
        route:
          'seam only: initial draft and attachment setup; real event route: Add and typed instruction',
        text: state.text,
        attachments: state.attachments.length
      },
      null,
      2
    )
  )
  writeFileSync(
    join(folder, 'composer.png'),
    Buffer.from((await host.request('captureVisibleWindow')).png, 'base64')
  )

  // The composite is retained, then the user presses the composer's normal Send.
  const retained = retainComposite(
    folder,
    nativeChat.get(chat).attachments[1],
    steps['before-add'].context,
    ['rectangle', 'arrow']
  )
  await sendThroughComposer(host, folder, chat, retained, messages, () =>
    event({ action: 'sendButton' })
  )
}

type Composite = { type: string; data: string; name: string; note?: string }

/** Keeps the exact bytes the native Add produced next to a record of where they came from.
 *  `test/provider-image-live.mjs` reads this pair (`TREZI_LIVE_MARKUP_COMPOSITE`) and checks
 *  the hash, so a live turn is provably about this composite and not a synthetic picture. */
function retainComposite(folder: string, added: Composite, context: State, marks: string[]) {
  assert.equal(added.name, 'Mark up.png', 'the composite is the Mark up attachment')
  const bytes = Buffer.from(added.data, 'base64')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const file = `native-composite.${added.type === 'image/jpeg' ? 'jpg' : 'png'}`
  writeFileSync(join(folder, file), bytes)
  const png = added.type === 'image/png'
  let sha = 'unknown'
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {}
  const record = {
    origin: 'native Add: markup-add event from the overlay, added by NativeMarkupController',
    route: 'real event route: hit-tested Add button; controller attachment handoff',
    nativeOrigin: true,
    ticket: 'LKM-391',
    check: 'preview-markup',
    sha,
    at: new Date().toISOString(),
    file,
    name: added.name,
    type: added.type,
    sha256,
    bytes: bytes.length,
    width: png ? bytes.readUInt32BE(16) : null,
    height: png ? bytes.readUInt32BE(20) : null,
    page: 'smoke fixture page #markup-smoke (Pricing heading and a blue card)',
    marks,
    capture: context,
    note: added.note ?? ''
  }
  writeFileSync(join(folder, 'native-composite.json'), JSON.stringify(record, null, 2))
  return record
}

/** Normal composer Send of the retained composite with the draft and the earlier attachment.
 *  Only the provider's outbound `agent:send` is intercepted (no provider call), as in
 *  `smoke-sent-attachments.ts`; the planning of the attachments and the prompt are real. */
async function sendThroughComposer(
  host: NativeBridge,
  folder: string,
  chat: string,
  composite: ReturnType<typeof retainComposite>,
  messages: number,
  clickSend: () => Promise<State>
) {
  const invoke = nativeChat.services.invoke
  const sent: unknown[][] = []
  nativeChat.services.invoke = async (channel, ...args) => {
    if (channel === 'agent:send') {
      sent.push(args)
      return
    }
    return invoke(channel, ...args)
  }
  try {
    const live = nativeChat.get(chat)
    assert.equal(live.isRunning, false, 'no turn is running before Send')
    await clickSend()
    await waitFor(() => sent.length === 1, 'Send reaches the provider route, not the queue')
    const [prompt, images] = sent[0] as [string, { mediaType: string; data: string }[]]
    const digests = images.map((image) => ({
      mediaType: image.mediaType,
      bytes: Buffer.from(image.data, 'base64').length,
      sha256: createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex')
    }))
    const existing = createHash('sha256').update(Buffer.from(PIXEL, 'base64')).digest('hex')
    assert.ok(
      digests.some((image) => image.sha256 === composite.sha256),
      'the image sent is the retained native composite, byte for byte'
    )
    assert.ok(
      digests.some((image) => image.sha256 === existing),
      'the earlier attachment travels too'
    )
    assert.ok(
      prompt.endsWith(DRAFT + INSTRUCTION),
      'the draft and typed instruction are the message'
    )
    assert.ok(prompt.includes(composite.note), 'the statement about the marks is in the prompt')
    assert.match(prompt, /marks.*user/i)
    await waitFor(() => live.messages.length > messages, 'the message is in the conversation')
    assert.equal(
      (await host.request('composerInspect')).attachments.length,
      0,
      'Send consumed them'
    )
    writeFileSync(
      join(folder, 'send-payload.json'),
      JSON.stringify(
        {
          via: 'posted, hit-tested Send button click, then agent:send intercepted before the provider',
          route: 'real event route: Send button click; seam only: outbound agent:send interception',
          compositeSha256: composite.sha256,
          images: digests,
          prompt
        },
        null,
        2
      )
    )
    // The turn ends the way a provider's would, so later checks find an idle chat.
    nativeChat.event({ type: 'delta', projectKey: chat, text: 'Received.' })
    nativeChat.event({ type: 'done', projectKey: chat, landingPending: false })
    await waitFor(() => !live.isRunning, 'the Mark up turn ends')
  } finally {
    nativeChat.services.invoke = invoke
  }
}

export async function restorePreviewMarkup(host: NativeBridge, page: Page) {
  await host.request('previewMarkupTest', { action: 'cancel' }).catch(() => {})
  await host.request('previewViewport', {}).catch(() => {})
  await page('window.removeEventListener("keydown", window.__markupSmokeKeyListener)').catch(
    () => {}
  )
  await page('document.querySelector("#markup-smoke")?.remove()').catch(() => {})
  const { attachments } = await host.request('composerInspect')
  await host.request('composerPerform', {
    steps: [...attachments.map(() => ({ remove: 0 })), { text: '' }]
  })
}
