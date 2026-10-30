import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { decodePng } from './smoke-png'
import { waitFor } from './smoke-wait'

/**
 * LKM-387: what a hovered chat title really looks like while it scrolls. The title's frame, clip
 * and travel were always right; the text simply was not painted across them, so this check reads
 * pixels: foreground captures at the scroll's start, middle and end, cropped to the title's clip.
 */
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Item = any
type Image = { width: number; height: number; rgb: (x: number, y: number) => number[] }
export type MarqueePhase = 'start' | 'mid' | 'end'
export type MarqueeBox = {
  x: number
  y: number
  width: number
  height: number
  referenceWidth: number
}

/** `SidebarMarqueeTitle.fade`: how far each soft edge reaches into the title. */
const FADE = 14
/** Wider than a word space, so a bin with no ink means the text is not there. */
const BIN = 16
/** Colour distance from the row behind the text that counts as text. */
const INK = 90
/** The end state: the last glyph stops this close to the clip's right edge. */
const END_SLACK = 5

/** The title's ink in points from the clip's left edge, compared with the row above the text. */
export function marqueeColumns(image: Image, box: MarqueeBox) {
  const scale = image.width / box.referenceWidth
  const row = Math.max(0, Math.round((box.y - 2) * scale))
  const top = Math.round(box.y * scale)
  const bottom = Math.min(image.height, Math.round((box.y + box.height) * scale))
  const ink: number[] = []
  for (let x = 0; x < box.width * scale; x++) {
    const column = Math.round(box.x * scale + x)
    if (column >= image.width) break
    const back = image.rgb(column, row)
    for (let y = top; y < bottom; y++) {
      const pixel = image.rgb(column, y)
      if (pixel.reduce((sum, value, index) => sum + Math.abs(value - back[index]), 0) > INK) {
        ink.push(x / scale)
        break
      }
    }
  }
  return ink
}

/** Why the capture is not text across the whole clip, or null. The faded edges are not read. */
export function marqueeInkProblem(image: Image, box: MarqueeBox, phase: MarqueePhase) {
  const ink = marqueeColumns(image, box)
  const blank: string[] = []
  const to = box.width - (phase === 'end' ? END_SLACK : FADE)
  for (let from = FADE; from + BIN <= to; from += BIN)
    if (!ink.some((x) => x >= from && x < from + BIN)) blank.push(`${from}–${from + BIN}`)
  if (blank.length) return `${phase}: no text at ${blank.join(', ')} pt of ${box.width} pt`
  if (phase === 'end' && box.width - (ink.at(-1) ?? 0) > END_SLACK)
    return `end: text stops ${(box.width - (ink.at(-1) ?? 0)).toFixed(1)} pt before the clip's edge`
  return null
}

/** One title's whole scroll, hovered through the row's seam. `during` runs just after the hover. */
export async function checkMarqueeScroll(
  host: NativeBridge,
  artifacts: string,
  row: string,
  stage: string,
  during?: () => Promise<void>
) {
  const item = async () =>
    (await host.request('shellInspect')).sidebarChats.find((entry: Item) => entry.id === row)
  const perform = (action: string, id?: string) =>
    host.request('shellPerform', id === undefined ? { action } : { action, row: id })
  const shot = async (phase: MarqueePhase, state: Item) => {
    if (process.env.TREZI_NATIVE_BACKGROUND_TEST === '1') {
      console.log(`Sidebar marquee: background run, ${stage} ${phase} not captured.`)
      return
    }
    const image = await host.request('captureVisibleSidebar')
    const png = Buffer.from(image.png, 'base64')
    const name = `sidebar-marquee-${stage}-${phase}`
    writeFileSync(join(artifacts, `${name}.png`), png)
    writeFileSync(join(artifacts, `${name}.json`), JSON.stringify(state, null, 2), 'utf8')
    const problem = marqueeInkProblem(decodePng(png), state.marqueeState, phase)
    assert.equal(problem, null, `${stage}: ${problem}, see ${name}.png`)
  }

  assert.equal(await perform('sidebar-hover', row), true, `${stage}: hovered the row`)
  const started = await waitFor(
    async () => {
      const state = await item()
      return state?.hovered && state.marquee && state
    },
    `${stage}: the title scrolls on hover`,
    10000,
    item
  )
  await shot('start', started)
  assert.ok(started.marqueeState.fadeTrailing > 0, `${stage}: the right edge is soft`)
  if (during) await during()

  const settle = async (label: string, reached: (state: Item) => boolean, timeout: number) =>
    waitFor(
      async () => {
        const state = await item()
        return state && reached(state) && state
      },
      `${stage}: ${label}`,
      timeout,
      item
    )
  // Bounded by what is left at 30 pt/s, with room for a loaded host.
  const budget = 3000 + (started.travel / 30) * 1000
  const middle = await settle(
    'scrolled half way',
    (state) => state.marqueeState.offset >= state.travel / 2,
    budget
  )
  await shot('mid', middle)
  assert.ok(middle.marqueeState.fadeLeading > 0, `${stage}: the left edge is soft`)
  const end = await settle(
    'scrolled to the end',
    (state) => state.marqueeState.offset >= state.travel - 0.5,
    budget
  )
  await shot('end', end)

  // Still there after the captures: it holds at the end while hovered.
  const held = await item()
  const state = held.marqueeState
  assert.ok(Math.abs(state.offset - held.travel) <= 1, `${stage}: holds at the end`)
  assert.equal(state.fadeTrailing, 0, `${stage}: the last glyph is not faded`)
  // The label's frame includes its 2 pt text inset.
  const right = state.x + state.width
  assert.ok(Math.abs(state.textEnd - 2 - right) <= 1, `${stage}: the text ends at the clip's edge`)
  assert.ok(
    Math.abs(state.archiveLeft - right - 4) <= 1,
    `${stage}: the title reaches Archive: ${state.archiveLeft} after ${right}`
  )

  await perform('sidebar-hover')
  const rest = await settle('back at rest', (state) => !state.hovered && !state.marquee, 5000)
  assert.equal(rest.marqueeState.offset, 0, `${stage}: back at the title's start`)
  assert.equal(rest.marqueeState.truncated, true, `${stage}: truncated again`)
  return { started, middle, end }
}
