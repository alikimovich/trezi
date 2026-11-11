import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { nativeChat } from './chat-runtime'
import { waitFor } from './smoke-wait'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type State = Record<string, any>
type Page = (code: string) => Promise<unknown>

/** The smoke page's blue card (`#markup-card`). */
const CARD = '#2563eb'
const REGION_DRAFT = 'Tighten this card'

const closeColor = (a: string, b: string, tolerance: number) =>
  typeof a === 'string' &&
  [1, 3, 5].every(
    (i) =>
      Math.abs(Number.parseInt(a.slice(i, i + 2), 16) - Number.parseInt(b.slice(i, i + 2), 16)) <=
      tolerance * 255
  )

/** LKM-646: Mark up's Select region tool through foreground AppKit input, on the smoke page
 *  `checkPreviewMarkup` set up: a real drag with no marks enables Add, a reverse drag over the
 *  card and an adjusted handle make the region, Escape clears it, and Add puts exactly the
 *  card's pixels (no outline, dimming, island or neighbouring content) in this chat's composer
 *  beside its draft. A zero-area drag and Cancel attach nothing; a marked region carries
 *  its marks; a zoomed preview maps the region to captured pixels. */
export async function checkMarkupRegion(host: NativeBridge, page: Page, folder: string) {
  const inspect = (): Promise<State> => host.request('previewMarkupInspect')
  const composer = (): Promise<State> => host.request('composerInspect')
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
    steps[`region-${++count}-${params.action}`] = { ...state, input: params }
    writeFileSync(join(folder, 'region-steps.json'), JSON.stringify(steps, null, 2))
    return state
  }
  const shot = async (name: string) => {
    const capture = await host.request('captureVisibleWindow')
    writeFileSync(join(folder, `${name}.png`), Buffer.from(capture.png, 'base64'))
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
  const button = (label: string) => event({ action: 'button', label })
  const drag = (points: number[][]) => event({ action: 'pointer', points })
  const near = (a: number, b: number, label: string, tolerance = 1.5) =>
    assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`)

  const chat = nativeChat.active
  await host.request('composerPerform', { text: REGION_DRAFT })
  const attachments = () => nativeChat.get(chat).attachments.length
  const before = attachments()

  const opened = await open('region')
  assert.equal(opened.addEnabled, false, 'nothing to add before a region or a mark')
  assert.ok(opened.controls.some((control: State) => control.label === 'Select region'))
  const card = JSON.parse(
    String(
      await page(
        'JSON.stringify(document.querySelector("#markup-card").getBoundingClientRect().toJSON())'
      )
    )
  )
  // CSS px to captured px: the snapshot holds the viewport at backing scale and zoom.
  const scale = opened.image.width / opened.context.viewportWidth
  const inset = 12
  const [x0, y0, x1, y1] = [
    (card.left + inset) * scale,
    (card.top + inset) * scale,
    (card.right - inset) * scale,
    (card.bottom - inset) * scale
  ].map(Math.round)
  await button('Select region')
  assert.equal((await inspect()).tool, 'select')

  // A click-sized drag is no region.
  const tiny = await drag([
    [x0 + 4, y0 + 4],
    [x0 + 5, y0 + 5]
  ])
  assert.equal(tiny.region, null, 'a zero-area drag selects nothing')
  assert.equal(tiny.addEnabled, false, 'and Add stays off')

  // Reverse drag, past the card's right edge, then the right handle back onto the card.
  const over = x1 + 40 * scale
  const drawn = await drag([
    [over, y1],
    [(over + x0) / 2, (y1 + y0) / 2],
    [x0, y0]
  ])
  near(drawn.region.x, x0, 'reverse drag: left')
  near(drawn.region.y, y0, 'reverse drag: top')
  near(drawn.region.x + drawn.region.width, over, 'reverse drag: right')
  assert.equal(drawn.marks.length, 0, 'selecting draws no mark')
  assert.equal(drawn.addEnabled, true, 'a region alone enables Add')
  assert.equal(drawn.undoEnabled, false, 'and is no Undo step')
  await shot('region-drawn')
  const right = drawn.region.x + drawn.region.width,
    middle = drawn.region.y + drawn.region.height / 2
  const adjusted = await drag([
    [right, middle],
    [x1, middle]
  ])
  near(adjusted.region.x + adjusted.region.width, x1, 'the right handle moved the right edge')
  near(adjusted.region.x, x0, 'and nothing else')
  assert.equal(adjusted.marks.length, 0)

  // Escape clears the region, not the session; then redraw it.
  const escaped = await event({ action: 'key', key: '\u{1b}', code: 53 })
  assert.equal(escaped.open, true, 'Escape with a region keeps Mark up open')
  assert.equal(escaped.region, null, 'and clears the region')
  assert.equal(escaped.addEnabled, false)
  const region = (
    await drag([
      [x1, y1],
      [x0, y0]
    ])
  ).region
  await shot('region-ready')
  await button('Add to chat')
  await closed('region add')
  const state = await waitFor(async () => {
    const value = await composer()
    return value.attachments.length === before + 1 && value
  }, 'the region reaches the composer')
  assert.equal(state.text, REGION_DRAFT, 'Add keeps this chat’s draft')
  assert.equal(nativeChat.active, chat, 'in the chat Mark up opened in')
  const added = nativeChat.get(chat).attachments.at(-1)
  assert.ok(added, 'the region is this chat’s attachment')
  // The card's colour as captured (the snapshot may come through a display colour space), then
  // every pixel against it.
  const { center } = await test({ action: 'imageStats', data: added.data })
  assert.ok(closeColor(center, CARD, 0.12), `the region is the card: ${center}`)
  const stats = await test({
    action: 'imageStats',
    data: added.data,
    expect: center,
    tolerance: 0.03
  })
  assert.equal(stats.width, region.width, 'the attachment is the region’s width in captured px')
  assert.equal(stats.height, region.height, 'and its height')
  assert.equal(stats.other, 0, `only the card: no outline, dimming or neighbours (${stats.other})`)
  assert.match(added.note ?? '', /region the user selected/)
  assert.match(added.note ?? '', /drew no marks/)
  await shot('region-added')

  // Cancel with a region, in a zoomed preview: captured pixels, and nothing attached.
  await host.request('previewViewport', { width: 2000 })
  await waitFor(async () => Number(await page('innerWidth')) === 2000, 'zoomed: the page widens')
  const zoomed = await open('region zoomed')
  assert.ok(zoomed.context.zoom < 1, 'zoomed: the zoom is captured')
  await button('Select region')
  const { width, height } = zoomed.image
  const at = [
    [width * 0.6, height * 0.7],
    [width * 0.3, height * 0.4]
  ]
  const picked = await drag(at)
  near(picked.region.x, Math.round(at[1][0]), 'zoomed: region x in captured px')
  near(picked.region.y, Math.round(at[1][1]), 'zoomed: region y in captured px')
  near(picked.region.width, Math.round(at[0][0]) - Math.round(at[1][0]), 'zoomed: width')
  const shown = picked.shown
  near(picked.regionView.x, shown.x + shown.width * 0.3, 'zoomed: the region sits on the image', 1)
  await button('Cancel')
  await closed('region cancel')
  await host.request('previewViewport', {})
  assert.equal(attachments(), before + 1, 'Cancel with a region attaches nothing')

  // A marked region: its mark, cropped with it.
  await waitFor(async () => Number(await page('innerWidth')) !== 2000, 'the page width returns')
  await open('marked region')
  await button('Select region')
  const fresh = await drag([
    [x1, y1],
    [x0, y0]
  ])
  await button('Pen')
  const inkHex = (await inspect()).colorWell.ink
  const row = (y0 + y1) / 2
  const pen = await drag([
    [x0 + 20, row],
    [(x0 + x1) / 2, row + 4],
    [x1 - 20, row]
  ])
  assert.equal(pen.marks.length, 1, 'the pen marks the region')
  assert.deepEqual(pen.region, fresh.region, 'and the region stays')
  await button('Add to chat')
  await closed('marked region add')
  await waitFor(() => attachments() === before + 2, 'the marked region reaches the composer')
  const markedFile = nativeChat.get(chat).attachments.at(-1)
  const marked = await test({
    action: 'imageStats',
    data: markedFile?.data,
    expect: center,
    ink: inkHex,
    tolerance: 0.06
  })
  assert.equal(marked.width, fresh.region.width, 'the marked region keeps the region’s size')
  assert.ok(marked.ink > 0, 'with the mark in it')
  assert.ok(
    marked.corners.every((corner: string) => corner === marked.corners[0]),
    'and the card around it'
  )
  assert.match(markedFile?.note ?? '', /marks .*user/i)
  assert.equal((await composer()).text, REGION_DRAFT, 'the draft is untouched')
}
