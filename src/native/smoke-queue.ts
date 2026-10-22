import { writeFileSync } from 'node:fs'
import type { NativeBridge } from './bridge'
import { inspectUntil } from './smoke-wait'

/** Composer queue box (LKM-198): even padding, centred rows, placeholder and Send alignment. */
const PADDING = 10
const ROW = 24
const SPACING = 4
const OVERLAP = 24
const INSET = 10

/** The visible height for `rows` queued messages, plus the note line when there is one. */
export function queueHeight(rows: number, note: boolean) {
  const lines = Math.min(rows, 3) + (note ? 1 : 0)
  return 2 * PADDING + lines * ROW + (lines - 1) * SPACING
}

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
export function queueGeometryProblems(composer: any, rows: number, note: boolean): string[] {
  const problems: string[] = []
  const near = (value: number, wanted: number, what: string) => {
    if (!(Math.abs(value - wanted) <= 1)) problems.push(`${what}: ${value}, wanted ${wanted} ±1`)
  }
  const geometry = composer.queueGeometry
  const measured = geometry?.rows ?? []
  if (composer.queueCount !== rows)
    problems.push(`queueCount ${composer.queueCount}, wanted ${rows}`)
  if (composer.queueHeight !== queueHeight(rows, note))
    problems.push(`queueHeight ${composer.queueHeight}, wanted ${queueHeight(rows, note)}`)
  if (composer.queueInset !== INSET) problems.push(`queueInset ${composer.queueInset}`)
  near(composer.queueOverlap, OVERLAP, 'overlap under the composer')
  if (!geometry || measured.length !== rows || Boolean(geometry.header) !== note) {
    problems.push(`measured ${measured.length} rows, header ${Boolean(geometry?.header)}`)
    return problems
  }
  near(geometry.height - geometry.visible, OVERLAP, 'hidden strip')
  near(geometry.visible, composer.queueHeight, 'visible height')
  // Even padding around the lines of the visible part (rows beyond three scroll).
  const first = geometry.header ?? measured[0].row
  const last = measured[Math.min(rows, 3) - 1].row
  const top = first.top
  const bottom = geometry.visible - last.bottom
  near(top, PADDING, 'top padding')
  near(bottom, PADDING, 'bottom padding')
  near(top, bottom, 'top padding against bottom padding')
  measured.slice(0, 3).forEach((line: any, index: number) => {
    near(line.row.bottom - line.row.top, ROW, `row ${index} height`)
    near(line.text.midY, line.row.midY, `row ${index} text centred`)
    near(line.more.midY, line.row.midY, `row ${index} actions centred`)
    near(line.text.minX, composer.placeholderX, `row ${index} text against the placeholder`)
    near(line.more.midX, composer.sendMidX, `row ${index} actions against Send`)
    if (index > 0)
      near(line.row.top - measured[index - 1].row.bottom, SPACING, `gap above row ${index}`)
  })
  if (geometry.header)
    near(geometry.header.bottom + SPACING, measured[0].row.top, 'gap below the note')
  return problems
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
  note: boolean
) {
  let problems: string[] = []
  const composer = await inspectUntil(
    (method) => host.request(method),
    'composerInspect',
    (value) => {
      problems = queueGeometryProblems(value, rows, note)
      return problems.length === 0
    },
    () => ({ label, problems })
  )
  const stem = screenshot.replace('.png', `-queue-${label}`)
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
    }
  } finally {
    await host.request('composerAppearance', {})
  }
  const { queueGeometry, placeholderX, sendMidX, queueHeight: height, queueOverlap } = composer
  writeFileSync(
    `${stem}.json`,
    JSON.stringify(
      { rows, note, height, queueOverlap, placeholderX, sendMidX, queueGeometry },
      null,
      2
    )
  )
  return composer
}
