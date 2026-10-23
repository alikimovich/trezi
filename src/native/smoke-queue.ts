import { writeFileSync } from 'node:fs'
import type { NativeBridge } from './bridge'
import { preparePreviewInput } from './smoke-input'
import { inspectUntil } from './smoke-wait'

/** Composer queue panel (LKM-198, LKM-302): one frosted panel with flat 28 pt rows and no gap
 *  between them, even padding, a full-width hairline above every row but the first (LKM-318),
 *  the leading glyph over the + button and the trailing actions over Send. */
const PADDING = 8
const ROW = 28
const OVERLAP = 24
const INSET = 10
/** Smallest acceptable hit target for a row or header control. */
const TARGET = 28

/** The visible height for `rows` queued messages, plus the header when there is one. */
export function queueHeight(rows: number, header: boolean) {
  const lines = Math.min(rows, 3) + (header ? 1 : 0)
  return 2 * PADDING + lines * ROW
}

/** `header` is a note or pause line; `paused` also expects its Send now button. */
export function queueGeometryProblems(
  // biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
  composer: any,
  rows: number,
  header: boolean,
  paused = false
): string[] {
  const problems: string[] = []
  const near = (value: number, wanted: number, what: string) => {
    if (!(Math.abs(value - wanted) <= 1)) problems.push(`${what}: ${value}, wanted ${wanted} ±1`)
  }
  // biome-ignore lint/suspicious/noExplicitAny: measured frames are untyped JSON
  const target = (frame: any, what: string) => {
    if (!frame) problems.push(`${what}: missing`)
    else if (!(frame.width >= TARGET && frame.height >= TARGET))
      problems.push(`${what}: ${frame.width}×${frame.height} hit target, wanted ≥ ${TARGET}`)
  }
  const geometry = composer.queueGeometry
  const measured = geometry?.rows ?? []
  if (composer.queueCount !== rows)
    problems.push(`queueCount ${composer.queueCount}, wanted ${rows}`)
  if (composer.queueHeight !== queueHeight(rows, header))
    problems.push(`queueHeight ${composer.queueHeight}, wanted ${queueHeight(rows, header)}`)
  if (composer.queueInset !== INSET) problems.push(`queueInset ${composer.queueInset}`)
  near(composer.queueOverlap, OVERLAP, 'overlap under the composer')
  if (
    !geometry ||
    geometry.hidden ||
    measured.length !== rows ||
    Boolean(geometry.header) !== header
  ) {
    problems.push(
      `measured ${measured.length} rows, header ${Boolean(geometry?.header)}, hidden ${geometry?.hidden}`
    )
    return problems
  }
  const panel = geometry.panel
  near(geometry.height - geometry.visible, OVERLAP, 'hidden strip')
  near(geometry.visible, composer.queueHeight, 'visible height')
  // Even padding around the lines of the visible part (rows beyond three scroll).
  const first = geometry.header?.frame ?? measured[0].row
  const last = measured[Math.min(rows, 3) - 1].row
  const top = first.top
  const bottom = geometry.visible - last.bottom
  near(top, PADDING, 'top padding')
  near(bottom, PADDING, 'bottom padding')
  near(top, bottom, 'top padding against bottom padding')
  measured.slice(0, 3).forEach((line: any, index: number) => {
    near(line.row.bottom - line.row.top, ROW, `row ${index} height`)
    if (!line.text || !line.glyph || !line.more) {
      problems.push(`row ${index}: text, glyph or actions missing`)
      return
    }
    near(line.text.midY, line.row.midY, `row ${index} text centred`)
    near(line.glyph.midY, line.row.midY, `row ${index} glyph centred`)
    near(line.more.midY, line.row.midY, `row ${index} actions centred`)
    near(line.glyph.midX, composer.plusMidX, `row ${index} glyph over the + button`)
    near(line.text.minX, panel.textX, `row ${index} text after the glyph column`)
    near(line.more.midX, composer.sendMidX, `row ${index} actions against Send`)
    for (const part of ['edit', 'remove', 'more']) target(line[part], `row ${index} ${part}`)
    if (index === 0) {
      if (line.separator) problems.push('row 0 has a separator above it')
      return
    }
    // Flat rows: no gap between them, a full-width hairline at the boundary (LKM-318).
    near(line.row.top, measured[index - 1].row.bottom, `gap above row ${index}`)
    const rule = line.separator
    if (!rule) problems.push(`row ${index}: no separator above it`)
    else {
      near(rule.top, line.row.top, `row ${index} separator at the row boundary`)
      if (!(rule.height > 0 && rule.height <= 1))
        problems.push(`row ${index} separator ${rule.height} pt, wanted a hairline`)
      near(rule.minX, panel.minX, `row ${index} separator starts at the panel's leading edge`)
      near(rule.maxX, panel.maxX, `row ${index} separator ends at the panel's trailing edge`)
    }
  })
  if (geometry.header) {
    const { frame, glyph, divider, resume } = geometry.header
    near(frame.bottom - frame.top, ROW, 'header height')
    near(frame.bottom, measured[0].row.top, 'gap below the header')
    if (!glyph) problems.push('header glyph missing')
    else {
      near(glyph.midX, composer.plusMidX, 'header glyph over the + button')
      near(glyph.midY, frame.midY, 'header glyph centred')
    }
    if (!divider) problems.push('header divider missing')
    else {
      near(divider.bottom, frame.bottom, 'header divider at the header bottom')
      near(divider.minX, panel.minX + panel.ruleInset, 'header divider start')
      near(divider.maxX, panel.maxX - panel.ruleInset, 'header divider end')
      if (!(divider.height > 0 && divider.height <= 1))
        problems.push(`header divider ${divider.height} pt, wanted a hairline`)
    }
    if (geometry.header.paused !== paused)
      problems.push(`header paused ${geometry.header.paused}, wanted ${paused}`)
    if (paused) target(resume, 'Send now')
    else if (resume) problems.push('Send now shown on an unpaused queue')
  }
  return problems
}

/** The queue once its last message is gone: no panel and no height above the composer. */
// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
export function emptyQueueProblems(composer: any): string[] {
  const problems: string[] = []
  if (composer.queueCount !== 0) problems.push(`queueCount ${composer.queueCount}`)
  if (composer.queueHeight !== 0) problems.push(`queueHeight ${composer.queueHeight}`)
  if (composer.queueGeometry?.hidden !== true) problems.push('queue panel still shown')
  return problems
}

/** A foreground capture of the composer and its queue; a capture that loses the foreground
 *  while ScreenCaptureKit works is retaken (as `captureForegroundChat`). */
async function captureForegroundComposer(host: NativeBridge) {
  for (let attempt = 1; ; attempt++) {
    await preparePreviewInput(host, true)
    try {
      return await host.request('captureVisibleComposer')
    } catch (error) {
      const foregroundLost =
        error instanceof Error &&
        (error.message === 'Chat window is not in the foreground' ||
          error.message === 'Chat lost foreground during capture')
      if (!foregroundLost || attempt === 3) throw error
    }
  }
}

async function inspectMotion(host: NativeBridge) {
  return (await host.request('composerInspect')).queueGeometry.motion
}

/** LKM-294: runs `send` and captures the queued message it adds sliding in, as
 *  `<screenshot>-queue-insert[-reduced]-<i>.png` with the timings and row tops in `.json`.
 *  `reduced` forces Reduce Motion for the queue only (no system setting): no rise, only a fade. */
export async function checkQueueInsertion(
  host: NativeBridge,
  screenshot: string,
  reduced: boolean,
  send: () => Promise<unknown>
) {
  const prior = await inspectMotion(host)
  await host.request('composerQueueMotion', { reduceMotion: reduced })
  try {
    // Test synchronisation, not a product delay: let the previous message's entrance finish so
    // its fade cannot be mistaken for a replay in the captured frames.
    const settle = Math.max(prior.duration ?? 0, (await inspectMotion(host)).duration ?? 0)
    await new Promise((resolve) => setTimeout(resolve, Math.min(settle * 1000 + 100, 1000)))
    const before = await inspectMotion(host)
    const frames = host.request('captureQueueInsertion', {
      after: before.insertions,
      shots: 10,
      interval: 0.03
    })
    await send()
    const captured: { ms: number; png: string; rows: number[] }[] = await frames
    const motion = (await host.request('composerInspect')).queueGeometry.motion
    if (motion.insertions !== before.insertions + 1 || motion.lastInsertion.length !== 1)
      throw new Error(`Queue insertion did not animate one message: ${JSON.stringify(motion)}`)
    if (motion.reduceMotion !== reduced || (reduced ? motion.rise !== 0 : !(motion.rise > 0)))
      throw new Error(`Queue insertion motion (reduced ${reduced}): ${JSON.stringify(motion)}`)
    const stem = screenshot.replace('.png', `-queue-insert${reduced ? '-reduced' : ''}`)
    captured.forEach((frame, index) => {
      writeFileSync(`${stem}-${index}.png`, Buffer.from(frame.png, 'base64'))
    })
    writeFileSync(
      `${stem}.json`,
      JSON.stringify(
        { reduced, motion, frames: captured.map(({ ms, rows }) => ({ ms, rows })) },
        null,
        2
      )
    )
    return motion
  } finally {
    await host.request('composerQueueMotion', {})
  }
}

/** Waits for the measured layout, asserts it and writes light and dark composer captures with
 *  the geometry beside them (`<screenshot>-queue-<label>-{light,dark}.png` and `.json`). */
export async function checkQueueGeometry(
  host: NativeBridge,
  screenshot: string,
  label: string,
  rows: number,
  note: boolean,
  paused = false
) {
  let problems: string[] = []
  const composer = await inspectUntil(
    (method) => host.request(method),
    'composerInspect',
    (value) => {
      problems = queueGeometryProblems(value, rows, note, paused)
      return problems.length === 0
    },
    () => ({ label, problems })
  )
  const stem = screenshot.replace('.png', `-queue-${label}`)
  const visible: Record<string, string[]> = {}
  try {
    for (const appearance of ['light', 'dark']) {
      const forced = await host.request('composerAppearance', { appearance })
      if (forced.dark !== (appearance === 'dark'))
        throw new Error(`Queue ${appearance} not applied`)
      await new Promise((resolve) => setTimeout(resolve, 250))
      writeFileSync(
        `${stem}-${appearance}.png`,
        Buffer.from(await host.request('captureComposer'), 'base64')
      )
      // LKM-302: the frosted panel as WindowServer paints it, not only the offscreen cache.
      const image = await captureForegroundComposer(host)
      writeFileSync(`${stem}-${appearance}-visible.png`, Buffer.from(image.png, 'base64'))
      visible[appearance] = image.text
    }
  } finally {
    await host.request('composerAppearance', {})
  }
  const { queueGeometry, plusMidX, sendMidX, queueHeight: height, queueOverlap } = composer
  writeFileSync(
    `${stem}.json`,
    JSON.stringify(
      { rows, note, paused, height, queueOverlap, plusMidX, sendMidX, queueGeometry, visible },
      null,
      2
    )
  )
  return composer
}
