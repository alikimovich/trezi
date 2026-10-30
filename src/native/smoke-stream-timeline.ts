/**
 * LKM-383: what the parallel-chat stream check reads and asserts, apart from the host so the unit
 * tier runs the same assertions over real `NativeChat.inspect()` payloads
 * (`test/native-chat-parallel-stream.mjs`). Pure, apart from the injected reads.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A state may be wrong this long after a step began, or in one run while it streams. */
export const STREAM_BOUND_MS = 5000
/** How long each step must stay right. */
export const STREAM_HOLD_MS = 700
const SAMPLE_MS = 100
/** Samples quoted in a failure; the artifact keeps them all. */
const TIMELINE_TAIL = 40

// biome-ignore lint/suspicious/noExplicitAny: host inspection payloads are untyped JSON
type Inspect = any

export interface StreamSample {
  label: string
  t: number
  /** The chat this step shows. */
  expected: string
  bunActive: string
  swiftChat: string
  visible: boolean
  /** The chat's sidebar row is selected, or the sidebar is collapsed and has none to select. */
  sidebar: boolean
  inView: number
  realized: number
  swiftCount: number
  bunCount: number
  /** Bun's last row, and its text length in Bun and in Swift's row of that id (-1: no row). */
  bunRow: string
  bunLast: number
  swiftLast: number
  settling: boolean
}

export function streamSample(
  label: string,
  expected: string,
  chat: Inspect,
  shell: Inspect,
  bun: { active: string; messages: readonly { id: string; text: string }[] },
  t = Date.now()
): StreamSample {
  const last = bun.messages.at(-1)
  const row = chat.messages?.find((m: Inspect) => m.id === last?.id)
  return {
    label,
    t,
    expected,
    bunActive: bun.active,
    swiftChat: chat.chat,
    visible: !!chat.visible,
    sidebar:
      !!shell.sidebarCollapsed ||
      !!shell.sidebarChats?.some((r: Inspect) => r.id === `chat:${expected}` && r.selected),
    inView: chat.visibleMessageIDs?.length ?? 0,
    realized: chat.realizedRows ?? 0,
    swiftCount: chat.messageCount ?? 0,
    bunCount: bun.messages.length,
    bunRow: last?.id ?? '',
    bunLast: last?.text.length ?? -1,
    swiftLast: row?.text.length ?? -1,
    settling: !!chat.latestSettling
  }
}

/** What is wrong in this sample. `rows`: the step's chat has messages, so one must be in view. */
export function streamProblems(sample: StreamSample, rows = true): string[] {
  const problems: string[] = []
  if (sample.bunActive !== sample.expected)
    problems.push(`Bun's active chat is ${sample.bunActive}, not ${sample.expected}`)
  if (sample.swiftChat !== sample.bunActive)
    problems.push(`Swift shows chat ${sample.swiftChat}, not the active chat ${sample.bunActive}`)
  if (!sample.visible) problems.push('the chat column is hidden (chatInspect.visible)')
  if (!sample.sidebar) problems.push(`the sidebar row of ${sample.expected} is not selected`)
  if (rows && !sample.inView)
    problems.push(
      `no message row in view (chatInspect.visibleMessageIDs is empty, ${sample.realized} realized, ${sample.swiftCount} of ${sample.bunCount} rows in Swift)`
    )
  return problems
}

export interface StreamStep {
  label: string
  /** Reads the state now; `watchStream` adds it to the timeline. */
  read: () => Promise<StreamSample>
  timeline: StreamSample[]
  rows?: boolean
  boundMs?: number
  holdMs?: number
  sleep?: (ms: number) => Promise<void>
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

/** Returns once the step stayed right for `holdMs` and Swift's last row reached the text Bun had
 *  by then. Bun keeps streaming, so that text is a fixed target and not Bun's latest. Throws when
 *  a problem outlasts `boundMs`, or the text does. */
export async function watchStream(step: StreamStep) {
  const { label, read, timeline, rows = true, sleep = delay } = step
  const { boundMs = STREAM_BOUND_MS, holdMs = STREAM_HOLD_MS } = step
  const next = async () => {
    const sample = await read()
    timeline.push(sample)
    return sample
  }
  let sample = await next()
  let wrongSince = sample.t
  let rightSince: number | undefined
  for (;;) {
    const problems = streamProblems(sample, rows)
    if (problems.length) {
      rightSince = undefined
      if (sample.t - wrongSince >= boundMs)
        throw new Error(`${label}: ${problems.join('; ')} for ${seconds(boundMs)} s`)
    } else {
      wrongSince = sample.t
      rightSince ??= sample.t
      if (sample.t - rightSince >= holdMs) break
    }
    await sleep(SAMPLE_MS)
    sample = await next()
  }
  const { bunRow, bunLast, t: from } = sample
  while (sample.bunRow === bunRow && sample.swiftLast < bunLast) {
    if (sample.t - from >= boundMs)
      throw new Error(
        `${label}: Swift's last row has ${sample.swiftLast} characters and did not reach Bun's ${bunLast} within ${seconds(boundMs)} s`
      )
    await sleep(SAMPLE_MS)
    sample = await next()
  }
}

const shortChat = (chat: string) => chat.slice(-6)

/** The samples as text, oldest first, with times from the first one: the failure's own timeline. */
export function formatTimeline(timeline: readonly StreamSample[]): string {
  const start = timeline[0]?.t ?? 0
  const rows = timeline
    .slice(-TIMELINE_TAIL)
    .map((s) =>
      [
        `+${seconds(s.t - start)}s ${s.label}`,
        `expected=${shortChat(s.expected)} bun=${shortChat(s.bunActive)} swift=${shortChat(s.swiftChat)}`,
        `visible=${s.visible} sidebar=${s.sidebar} inView=${s.inView} realized=${s.realized}`,
        `rows=${s.swiftCount}/${s.bunCount} last=${s.swiftLast}/${s.bunLast} settling=${s.settling}`
      ].join(' ')
    )
  return [`Timeline (last ${rows.length} of ${timeline.length} samples):`, ...rows].join('\n')
}
