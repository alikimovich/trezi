import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeBridge } from './bridge'
import { decodePng } from './smoke-png'
import { restoreSidebarFocus } from './smoke-sidebar'
import { waitFor } from './smoke-wait'

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Row = any

/** The row's title carries the shimmer, moving or (Reduce Motion) still. */
export const shimmers = (row: Row) => ['sweep', 'still'].includes(row?.shimmer?.mode)

/** Pixels that differ between two captures of the same size. Pure. */
export function changedPixels(first: Buffer, second: Buffer) {
  const a = decodePng(first)
  const b = decodePng(second)
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`Captures differ in size: ${a.width}×${a.height}, ${b.width}×${b.height}`)
  let changed = 0
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const [ar, ag, ab] = a.rgb(x, y)
      const [br, bg, bb] = b.rgb(x, y)
      if (ar !== br || ag !== bg || ab !== bb) changed++
    }
  return changed
}

/** Moving phases must differ from each other; Reduce Motion's must not. Pure. */
export function shimmerCaptureProblem(changes: number[], moving: boolean) {
  if (moving && changes.some((changed) => !changed))
    return `Shimmer phases did not change the sidebar: ${changes.join(', ')} pixels`
  if (!moving && changes.some(Boolean))
    return `Reduce Motion moved the sidebar: ${changes.join(', ')} pixels`
  return ''
}

/**
 * LKM-389's evidence, while `chat`'s background turn runs and `other` is active: foreground
 * captures of the title's animation phases on an unselected and on the selected row, and of
 * Reduce Motion on both, with the inspected rows beside them in `sidebar-shimmer.json`. The
 * band takes 2 s to cross and is off the title for about 0.4 s, so captures 450 ms apart cannot
 * both fall in that gap. Ends with `other` active and Reduce Motion back to the system's.
 */
export async function checkSidebarShimmer(
  host: NativeBridge,
  artifacts: string,
  chat: string,
  other: string,
  activeChat: () => string
) {
  const id = `chat:${chat}`
  const rowOf = async () =>
    (await host.request('shellInspect')).sidebarChats?.find((row: Row) => row.id === id)
  const mode = (want: string, selected: boolean) =>
    waitFor(async () => {
      const row = await rowOf()
      return row?.shimmer.mode === want && row.selected === selected && row
    }, `sidebar row ${chat} ${want}, selected ${selected}`)
  // 'off' pins the sweep whatever the host's setting is (a runner with Reduce Motion on would
  // otherwise stay 'still'); no value hands the setting back to the host, only in `finally`.
  const reduce = (value?: 'on' | 'off') =>
    host.request('shellPerform', { action: 'marquee-reduce-motion', row: value })
  const select = async (session: string) => {
    await host.request('shellPerform', { action: 'select-row', row: `chat:${session}` })
    await waitFor(() => activeChat() === session, `sidebar row opened ${session}`)
  }
  const report: Record<string, unknown> = {}
  const phases = async (name: string, count: number, moving: boolean) => {
    await restoreSidebarFocus(host, `sidebar-shimmer ${name}`)
    const captures: Buffer[] = []
    for (let phase = 1; phase <= count; phase++) {
      if (phase > 1) await new Promise((resolve) => setTimeout(resolve, 450))
      const image = await host.request('captureVisibleSidebar')
      const png = Buffer.from(image.png, 'base64')
      writeFileSync(join(artifacts, `sidebar-shimmer-${name}-${phase}.png`), png)
      captures.push(png)
    }
    const changes = captures.slice(1).map((png, index) => changedPixels(captures[index], png))
    const problem = shimmerCaptureProblem(changes, moving)
    if (problem) throw new Error(`${name}: ${problem}`)
    report[name] = { changes, row: await rowOf() }
  }
  const both = async (name: string, selected: boolean) => {
    const swept = await mode('sweep', selected)
    if (!swept.shimmer.masked || !swept.shimmer.animated)
      throw new Error(`The title does not sweep: ${JSON.stringify(swept)}`)
    await phases(name, 3, true)
    await reduce('on')
    const still = await mode('still', selected)
    if (still.shimmer.masked || still.shimmer.animated || still.shimmer.alpha >= 1)
      throw new Error(`Reduce Motion is not a still, dimmed title: ${JSON.stringify(still)}`)
    if (!still.label.endsWith(', Running')) throw new Error('Reduce Motion dropped Running')
    await phases(`${name}-reduce-motion`, 2, false)
    await reduce('off')
  }
  try {
    await reduce('off')
    await both('unselected', false)
    await select(chat)
    await both('selected', true)
  } finally {
    await reduce()
    if (activeChat() !== other) await select(other)
  }
  writeFileSync(join(artifacts, 'sidebar-shimmer.json'), JSON.stringify(report, null, 2))
}
